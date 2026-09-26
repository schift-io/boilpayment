import pytest
from boilpayment_core import Money
from boilpayment_toss import _normalize_toss_refund, map_toss_webhook


@pytest.mark.parametrize(
    "status,expected",
    [
        ("DONE", "refund.created"),
        ("FAILED", "refund.pending"),
        ("PENDING", "refund.pending"),
    ],
)
def test_cancel_event_identity_status(status: str, expected: str) -> None:
    body = {
        "eventType": "CANCEL_STATUS_CHANGED",
        "createdAt": "2026-09-10T10:00:00.000",
        "data": {
            "transactionKey": "cancel_2",
            "cancelAmount": 3000,
            "cancelStatus": status,
        },
    }
    event = map_toss_webhook(body)
    assert event.type == expected
    assert event.refund_ref == "cancel_2"
    assert event.payment_ref is None
    assert event.amount is None
    assert map_toss_webhook(body).id == event.id
    assert (
        map_toss_webhook(
            {**body, "data": {**body["data"], "transactionKey": "cancel_3"}}
        ).id
        != event.id
    )


def test_payment_snapshot_selects_single_cancellation_not_total() -> None:
    event = map_toss_webhook(
        {
            "eventType": "PAYMENT_STATUS_CHANGED",
            "data": {
                "paymentKey": "payment",
                "status": "PARTIAL_CANCELED",
                "currency": "KRW",
                "totalAmount": 10000,
                "lastTransactionKey": "cancel_2",
                "cancels": [
                    {
                        "transactionKey": "cancel_2",
                        "cancelAmount": 3000,
                        "cancelStatus": "DONE",
                    },
                    {
                        "transactionKey": "cancel_1",
                        "cancelAmount": 2000,
                        "cancelStatus": "DONE",
                    },
                ],
            },
        }
    )
    assert event.refund_ref == "cancel_2"
    assert event.amount == Money(amount_minor=3000, currency="KRW")


def test_aggregate_refund_has_no_amount_or_ref() -> None:
    event = map_toss_webhook(
        {
            "eventType": "PAYMENT_STATUS_CHANGED",
            "data": {
                "paymentKey": "payment",
                "status": "PARTIAL_CANCELED",
                "totalAmount": 10000,
                "currency": "KRW",
            },
        }
    )
    assert event.refund_ref is None
    assert event.amount is None


@pytest.mark.parametrize(
    "status,expected",
    [("DONE", "succeeded"), ("PENDING", "pending"), ("FAILED", "pending")],
)
def test_api_refund_transaction_status(status: str, expected: str) -> None:
    refund = _normalize_toss_refund(
        {
            "paymentKey": "payment",
            "currency": "KRW",
            "lastTransactionKey": "cancel_2",
            "cancels": [
                {
                    "transactionKey": "cancel_2",
                    "cancelAmount": 3000,
                    "cancelStatus": status,
                }
            ],
        },
        payment_ref="payment",
        amount=Money(amount_minor=3000, currency="KRW"),
        reason="test",
    )
    assert refund.provider_ref == "cancel_2"
    assert refund.status == expected


def test_authoritative_lookup_uses_exact_cancel_id() -> None:
    import anyio
    import httpx
    from boilpayment_toss import TossProvider, TossProviderConfig

    async def run() -> None:
        raw = {
            "paymentKey": "payment",
            "currency": "KRW",
            "lastTransactionKey": "new",
            "cancels": [
                {"transactionKey": "old", "cancelAmount": 2000, "cancelStatus": "DONE"},
                {"transactionKey": "new", "cancelAmount": 3000, "cancelStatus": "DONE"},
            ],
        }
        async with httpx.AsyncClient(
            base_url="https://toss.invalid",
            transport=httpx.MockTransport(lambda _: httpx.Response(200, json=raw)),
        ) as client:
            provider = TossProvider(
                TossProviderConfig(secret_key="test_secret"), client=client
            )
            refund = await provider.get_refund(payment_ref="payment", refund_ref="old")
            assert refund is not None
            assert refund.provider_ref == "old"
            assert refund.amount.amount_minor == 2000
            assert refund.status == "succeeded"
            assert (
                await provider.get_refund(payment_ref="payment", refund_ref="missing")
                is None
            )

    anyio.run(run)
