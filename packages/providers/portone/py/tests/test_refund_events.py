import pytest
from schift_payment_kit_core import Money
from schift_payment_kit_portone import _normalize_portone_refund, map_portone_webhook


@pytest.mark.parametrize(
    "type_,expected",
    [
        ("Transaction.CancelPending", "refund.pending"),
        ("Transaction.Cancelled", "refund.created"),
        ("Transaction.PartialCancelled", "refund.created"),
    ],
)
def test_cancellation_event_identity(type_: str, expected: str) -> None:
    body = {
        "type": type_,
        "timestamp": "2026-09-10T01:00:00Z",
        "data": {
            "paymentId": "payment",
            "transactionId": "attempt",
            "cancellationId": "cancel_2",
            "totalAmount": 10000,
        },
    }
    event = map_portone_webhook(body)
    assert event.type == expected
    assert event.refund_ref == "cancel_2"
    assert event.payment_ref == "payment"
    assert event.amount is None
    assert map_portone_webhook(body).id == event.id
    assert (
        map_portone_webhook(
            {**body, "data": {**body["data"], "cancellationId": "cancel_3"}}
        ).id
        != event.id
    )


@pytest.mark.parametrize(
    "status,expected",
    [("SUCCEEDED", "succeeded"), ("REQUESTED", "pending"), ("FAILED", "failed")],
)
def test_api_refund_cancellation_status(status: str, expected: str) -> None:
    refund = _normalize_portone_refund(
        {
            "cancellation": {
                "id": "cancel_2",
                "status": status,
                "totalAmount": 3000,
                "requestedAt": "2026-09-10T01:00:00Z",
            }
        },
        payment_ref="payment",
        amount=Money(amount_minor=3000, currency="KRW"),
        reason="test",
    )
    assert refund.provider_ref == "cancel_2"
    assert refund.status == expected


@pytest.mark.parametrize(
    "status,expected",
    [("SUCCEEDED", "succeeded"), ("REQUESTED", "pending"), ("FAILED", "failed")],
)
def test_authoritative_lookup_matches_exact_cancellation(
    status: str, expected: str
) -> None:
    import anyio
    import httpx
    from schift_payment_kit_portone import PortoneProvider, PortoneProviderConfig

    async def run() -> None:
        raw = {
            "id": "payment",
            "currency": "KRW",
            "cancellations": [
                {
                    "id": "old",
                    "status": status,
                    "totalAmount": 2000,
                    "requestedAt": "2026-09-10T01:00:00Z",
                },
                {
                    "id": "new",
                    "status": "SUCCEEDED",
                    "totalAmount": 3000,
                    "requestedAt": "2026-09-10T01:01:00Z",
                },
            ],
        }
        async with httpx.AsyncClient(
            base_url="https://portone.invalid",
            transport=httpx.MockTransport(lambda _: httpx.Response(200, json=raw)),
        ) as client:
            provider = PortoneProvider(
                PortoneProviderConfig(
                    api_secret="test_secret",
                    store_id="store",
                    webhook_secret="whsec_test",
                ),
                client=client,
            )
            refund = await provider.get_refund(payment_ref="payment", refund_ref="old")
            assert refund is not None
            assert refund.provider_ref == "old"
            assert refund.amount.amount_minor == 2000
            assert refund.status == expected
            assert (
                await provider.get_refund(payment_ref="payment", refund_ref="missing")
                is None
            )

    anyio.run(run)
