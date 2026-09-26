"""Phase 6 regression tests — HTTP-calling methods driven through an injected
httpx.MockTransport. No real network calls. Covers billing-key charge, cancel (incl.
EC:D14 partial-cancel PG rejection), and schedule (provider-side scheduled billing),
per spec/portone.pseudo.md "[EC:F] issueBillingKey / chargeBillingKey / schedulePayment
/ cancelSchedules" and "[EC:D4 D13 D14 D6] refund".

pytest-asyncio is not installed: every async call runs via asyncio.run() inside a sync
`def test_...():` function.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

import httpx
import pytest
from schift_payment_kit_core import Money, PaymentKitError, ProviderError
from schift_payment_kit_portone import PortoneProvider, PortoneProviderConfig

API_SECRET = "test_sk_dummy"
STORE_ID = "store_dummy"
WEBHOOK_SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"


class RecordingTransport(httpx.AsyncBaseTransport):
    """Captures every request and returns a scripted response, keyed by (method, path)."""

    def __init__(self) -> None:
        self.calls: list[httpx.Request] = []
        self._responses: dict[tuple[str, str], httpx.Response] = {}

    def script(self, method: str, path: str, response: httpx.Response) -> None:
        self._responses[(method.upper(), path)] = response

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        key = (request.method.upper(), request.url.path)
        if key not in self._responses:
            raise AssertionError(f"RecordingTransport: unscripted request {key}")
        return self._responses[key]


def make_provider(
    transport: RecordingTransport, scheduling: str = "provider"
) -> PortoneProvider:
    client = httpx.AsyncClient(base_url="https://api.portone.io", transport=transport)
    return PortoneProvider(
        PortoneProviderConfig(
            api_secret=API_SECRET,
            store_id=STORE_ID,
            webhook_secret=WEBHOOK_SECRET,
            scheduling=scheduling,
        ),
        client,
    )


# ── [EC:F] charge_billing_key ────────────────────────────────────────────────


def test_ec_f_charge_billing_key_sends_post_with_portone_auth_header_and_full_body() -> (
    None
):
    transport = RecordingTransport()
    # Real PayWithBillingKeyResponse shape (verified against the V2 OpenAPI spec): only
    # `{ payment: { pgTxId, paidAt } }` — a slim completion summary, not a full Payment.
    payment_response = {
        "payment": {"pgTxId": "pg_tx_1", "paidAt": "2026-09-01T00:00:05.000Z"}
    }
    transport.script(
        "POST",
        "/payments/order_charge_1/billing-key",
        httpx.Response(200, json=payment_response),
    )
    provider = make_provider(transport)

    payment = asyncio.run(
        provider.charge_billing_key(
            billing_key="billing-key-abcdef1234",
            amount=Money(amount_minor=9900, currency="KRW"),
            order_id="order_charge_1",
            customer_ref="cus_abc",
            idempotency_key="charge:cus_abc:2026-09",
        )
    )

    assert len(transport.calls) == 1
    call = transport.calls[0]
    assert call.method == "POST"
    assert call.url.path == "/payments/order_charge_1/billing-key"
    assert call.headers["authorization"] == f"PortOne {API_SECRET}"
    assert call.headers["content-type"] == "application/json"
    import json as _json

    body = _json.loads(call.content)
    assert body == {
        "storeId": STORE_ID,
        "billingKey": "billing-key-abcdef1234",
        "orderName": "Subscription charge",
        "amount": {"total": 9900},
        "currency": "KRW",
        "customer": {"id": "cus_abc"},
    }
    assert payment.status == "succeeded"
    assert payment.id == "order_charge_1"


def test_ec_f_order_id_not_idempotency_header_is_the_idempotency_mechanism() -> None:
    # spec: PortOne's idempotency model is "caller supplies a unique paymentId per
    # attempt" via the path, not an Idempotency-Key header.
    transport = RecordingTransport()
    resp = {"payment": {"pgTxId": "pg_tx_1", "paidAt": "2026-09-01T00:00:05.000Z"}}
    transport.script(
        "POST", "/payments/order_charge_1/billing-key", httpx.Response(200, json=resp)
    )
    provider = make_provider(transport)

    asyncio.run(
        provider.charge_billing_key(
            billing_key="bk_1",
            amount=Money(amount_minor=9900, currency="KRW"),
            order_id="order_charge_1",
            customer_ref="cus_abc",
            idempotency_key="charge:cus_abc:2026-09",
        )
    )
    header_keys = [k.lower() for k in transport.calls[0].headers]
    assert not any("idempotency" in k for k in header_keys)


def test_ec_f_distinct_order_id_per_attempt_produces_distinct_path() -> None:
    transport = RecordingTransport()
    resp1 = {
        "id": "order_charge_1",
        "status": "PAID",
        "amount": {"total": 9900},
        "customer": {"id": "cus_abc"},
    }
    resp2 = {
        "id": "order_charge_2",
        "status": "PAID",
        "amount": {"total": 9900},
        "customer": {"id": "cus_abc"},
    }
    transport.script(
        "POST", "/payments/order_charge_1/billing-key", httpx.Response(200, json=resp1)
    )
    transport.script(
        "POST", "/payments/order_charge_2/billing-key", httpx.Response(200, json=resp2)
    )
    provider = make_provider(transport)

    asyncio.run(
        provider.charge_billing_key(
            billing_key="bk_1",
            amount=Money(amount_minor=9900, currency="KRW"),
            order_id="order_charge_1",
            customer_ref="cus_abc",
            idempotency_key="x",
        )
    )
    asyncio.run(
        provider.charge_billing_key(
            billing_key="bk_1",
            amount=Money(amount_minor=9900, currency="KRW"),
            order_id="order_charge_2",
            customer_ref="cus_abc",
            idempotency_key="y",
        )
    )
    assert transport.calls[0].url.path == "/payments/order_charge_1/billing-key"
    assert transport.calls[1].url.path == "/payments/order_charge_2/billing-key"


# ── [EC:D4 D6 D13 D14] refund ────────────────────────────────────────────────


def test_ec_d4_full_cancel_sends_post_with_storeid_reason_and_amount() -> None:
    transport = RecordingTransport()
    cancel_response = {
        "cancellation": {
            "id": "cxl_full_1",
            "status": "SUCCEEDED",

            "totalAmount": 15000,
            "cancelledAt": "2026-09-02T00:00:00.000Z",
        }
    }
    transport.script(
        "POST",
        "/payments/example-payment-id/cancel",
        httpx.Response(200, json=cancel_response),
    )
    provider = make_provider(transport)

    refund = asyncio.run(
        provider.refund(
            payment_ref="example-payment-id",
            amount=Money(amount_minor=15000, currency="KRW"),
            reason="customer request",
            idempotency_key="revoke:1",
        )
    )

    assert len(transport.calls) == 1
    call = transport.calls[0]
    assert call.method == "POST"
    assert call.url.path == "/payments/example-payment-id/cancel"
    assert call.headers["authorization"] == f"PortOne {API_SECRET}"
    import json as _json

    assert _json.loads(call.content) == {
        "storeId": STORE_ID,
        "reason": "customer request",
        "amount": 15000,
    }
    # EC:D6 — refund currency comes from the caller's Money.currency, not invented
    assert refund.amount.amount_minor == 15000
    assert refund.amount.currency == "KRW"
    assert refund.status == "succeeded"


def test_ec_d4_partial_cancel_includes_amount_less_than_full_total() -> None:
    transport = RecordingTransport()
    cancel_response = {
        "cancellation": {
            "id": "cxl_partial_1",
            "status": "SUCCEEDED",

            "totalAmount": 5000,
            "cancelledAt": "2026-09-02T00:00:00.000Z",
        }
    }
    transport.script(
        "POST",
        "/payments/example-payment-id/cancel",
        httpx.Response(200, json=cancel_response),
    )
    provider = make_provider(transport)

    refund = asyncio.run(
        provider.refund(
            payment_ref="example-payment-id",
            amount=Money(amount_minor=5000, currency="KRW"),
            reason="partial refund",
            idempotency_key="revoke:2",
        )
    )
    import json as _json

    body = _json.loads(transport.calls[0].content)
    assert body["amount"] == 5000
    assert refund.amount.amount_minor == 5000


def test_ec_d13_refund_account_included_for_virtual_account_refund() -> None:
    transport = RecordingTransport()
    cancel_response = {
        "cancellation": {
            "id": "cxl_va_1",
            "status": "SUCCEEDED",

            "totalAmount": 20000,
            "cancelledAt": "2026-09-02T00:00:00.000Z",
        }
    }
    transport.script(
        "POST",
        "/payments/va-payment-id/cancel",
        httpx.Response(200, json=cancel_response),
    )
    provider = make_provider(transport)
    refund_account = {
        "bank": "004",
        "accountNumber": "110-123-456789",
        "holderName": "홍길동",
    }

    asyncio.run(
        provider.refund(
            payment_ref="va-payment-id",
            amount=Money(amount_minor=20000, currency="KRW"),
            reason="virtual account refund",
            idempotency_key="revoke:3",
            extra={"refundAccount": refund_account},
        )
    )
    import json as _json

    body = _json.loads(transport.calls[0].content)
    assert body == {
        "storeId": STORE_ID,
        "reason": "virtual account refund",
        "amount": 20000,
        "refundAccount": refund_account,
    }


def test_ec_d14_pg_rejects_partial_cancel_propagates_as_provider_error() -> None:
    # provider.capabilities().partial_refund stays True — deny_partial is observed by
    # the caller as a raised error, per spec: "provider 는 사전 차단하지 않고 PortOne 이
    # 반환하는 에러를 그대로 전파한다 (deny_partial 은 호출자가 에러로 관찰)".
    transport = RecordingTransport()
    error_body = {
        "message": "Selected PG does not support partial cancellation",
        "type": "PARTIAL_CANCEL_NOT_SUPPORTED",
    }
    transport.script(
        "POST",
        "/payments/installment-payment-id/cancel",
        httpx.Response(400, json=error_body),
    )
    provider = make_provider(transport)
    assert provider.capabilities().partial_refund is True

    with pytest.raises(ProviderError) as exc_info:
        asyncio.run(
            provider.refund(
                payment_ref="installment-payment-id",
                amount=Money(amount_minor=3000, currency="KRW"),
                reason="partial refund attempt",
                idempotency_key="revoke:4",
            )
        )
    err = exc_info.value
    assert err.failure.provider_code == "PARTIAL_CANCEL_NOT_SUPPORTED"
    assert (
        err.failure.user_message == "Selected PG does not support partial cancellation"
    )
    import json as _json

    body = _json.loads(transport.calls[0].content)
    assert body["amount"] == 3000  # no client-side pre-block; request was still sent


# ── [EC:F] schedule_payment / cancel_schedules ───────────────────────────────


def test_ec_f_schedule_payment_sends_post_with_full_body_and_time_to_pay() -> None:
    transport = RecordingTransport()
    schedule_response = {"schedule": {"id": "sch_1", "status": "SCHEDULED"}}
    transport.script(
        "POST",
        "/payments/order_schedule_1/schedule",
        httpx.Response(200, json=schedule_response),
    )
    provider = make_provider(transport, scheduling="provider")
    time_to_pay = datetime(2026, 10, 1, 0, 0, 0, tzinfo=UTC)

    result = asyncio.run(
        provider.schedule_payment(
            billing_key="billing-key-abcdef1234",
            amount=Money(amount_minor=9900, currency="KRW"),
            order_id="order_schedule_1",
            customer_ref="cus_abc",
            time_to_pay=time_to_pay,
        )
    )

    assert len(transport.calls) == 1
    call = transport.calls[0]
    assert call.method == "POST"
    assert call.url.path == "/payments/order_schedule_1/schedule"
    assert call.headers["authorization"] == f"PortOne {API_SECRET}"
    import json as _json

    assert _json.loads(call.content) == {
        "payment": {
            "storeId": STORE_ID,
            "billingKey": "billing-key-abcdef1234",
            "orderName": "Subscription charge",
            "amount": {"total": 9900},
            "currency": "KRW",
            "customer": {"id": "cus_abc"},
        },
        "timeToPay": time_to_pay.isoformat(),
    }
    assert result == schedule_response


def test_ec_f_capabilities_scheduling_reflects_config() -> None:
    transport = RecordingTransport()
    provider_default = make_provider(transport)
    assert provider_default.capabilities().scheduling == "provider"
    provider_self = make_provider(transport, scheduling="self")
    assert provider_self.capabilities().scheduling == "self"


def test_ec_f_cancel_schedules_sends_delete_with_billing_key_and_storeid_body() -> None:
    # Real endpoint per the V2 OpenAPI spec: DELETE /payment-schedules
    # (RevokePaymentSchedulesBody), not /payments/{paymentId}/schedule — there is no
    # such cancel-by-paymentId endpoint.
    transport = RecordingTransport()
    revoke_response = {
        "revokedScheduleIds": ["sch_1"],
        "revokedAt": "2026-09-02T00:00:00.000Z",
    }
    transport.script(
        "DELETE",
        "/payment-schedules",
        httpx.Response(200, json=revoke_response),
    )
    provider = make_provider(transport)

    result = asyncio.run(
        provider.cancel_schedules(billing_key="billing-key-abcdef1234")
    )

    assert len(transport.calls) == 1
    call = transport.calls[0]
    assert call.method == "DELETE"
    assert call.url.path == "/payment-schedules"
    assert call.headers["authorization"] == f"PortOne {API_SECRET}"
    import json as _json

    assert _json.loads(call.content) == {
        "storeId": STORE_ID,
        "billingKey": "billing-key-abcdef1234",
    }
    assert result == revoke_response


def test_ec_f_cancel_schedules_requires_billing_key_or_schedule_ids() -> None:
    transport = RecordingTransport()
    provider = make_provider(transport)
    with pytest.raises(PaymentKitError):
        asyncio.run(provider.cancel_schedules())
    assert len(transport.calls) == 0


# ── EC:K2-K7 — KR cash receipt ────────────────────────────────────────────────


def make_provider_with_channel_key(transport: RecordingTransport) -> PortoneProvider:
    client = httpx.AsyncClient(base_url="https://api.portone.io", transport=transport)
    return PortoneProvider(
        PortoneProviderConfig(
            api_secret=API_SECRET,
            store_id=STORE_ID,
            webhook_secret=WEBHOOK_SECRET,
            channel_key="channel_1",
        ),
        client,
    )


def test_ec_k4_refuses_card_payment_without_calling_issue_endpoint() -> None:
    transport = RecordingTransport()
    transport.script(
        "GET",
        "/payments/pay_card",
        httpx.Response(
            200,
            json={
                "amount": {"total": 15000},
                "currency": "KRW",
                "method": {"type": "PaymentMethodCard"},
            },
        ),
    )
    provider = make_provider_with_channel_key(transport)

    async def run():
        await provider.issue_cash_receipt(
            payment_ref="pay_card",
            type="personal",
            customer_identity_number="01012345678",
        )

    with pytest.raises(Exception) as exc_info:
        asyncio.run(run())
    assert (
        getattr(exc_info.value, "code", None)
        == "cash_receipt_unsupported_for_payment_method"
    )
    assert len(transport.calls) == 1  # only the GET re-fetch


def test_ec_k2_k3_issues_against_non_card_payment() -> None:
    transport = RecordingTransport()
    transport.script(
        "GET",
        "/payments/pay_1",
        httpx.Response(
            200,
            json={
                "amount": {"total": 15000},
                "currency": "KRW",
                "orderName": "Sub",
                "method": {"type": "PaymentMethodTransfer"},
            },
        ),
    )
    transport.script(
        "POST",
        "/cash-receipts",
        httpx.Response(
            200,
            json={
                "cashReceipt": {
                    "issueNumber": "12345",
                    "url": "https://x",
                    "pgReceiptId": "pg_1",
                }
            },
        ),
    )
    provider = make_provider_with_channel_key(transport)

    async def run():
        return await provider.issue_cash_receipt(
            payment_ref="pay_1",
            type="business",
            customer_identity_number="1234567890",
        )

    receipt = asyncio.run(run())
    assert receipt.status == "issued"
    assert receipt.type == "business"
    post_call = next(c for c in transport.calls if c.method == "POST")
    import json as _json

    body = _json.loads(post_call.content)
    assert body["paymentId"] == "pay_1"
    assert body["channelKey"] == "channel_1"
    assert body["type"] == "CORPORATE"
    assert body["amount"] == {"total": 15000, "taxFree": None}


def test_ec_k2_channel_key_required_when_not_configured() -> None:
    transport = RecordingTransport()
    provider = make_provider(transport)  # no channel_key

    async def run():
        await provider.issue_cash_receipt(
            payment_ref="pay_1", type="personal", customer_identity_number="010"
        )

    with pytest.raises(Exception) as exc_info:
        asyncio.run(run())
    assert getattr(exc_info.value, "code", None) == "channel_key_required"
    assert len(transport.calls) == 0


def test_ec_k5_cancel_cash_receipt_posts_no_body_no_partial_support() -> None:
    transport = RecordingTransport()
    transport.script(
        "POST",
        "/payments/pay_1/cash-receipt/cancel",
        httpx.Response(
            200, json={"cancelledAmount": 15000, "cancelledAt": "2026-09-09T00:00:00.000Z"}
        ),
    )
    provider = make_provider_with_channel_key(transport)

    async def run():
        return await provider.cancel_cash_receipt(payment_ref="pay_1")

    receipt = asyncio.run(run())
    assert receipt.status == "canceled"
    assert len(transport.calls) == 1
    call = transport.calls[0]
    assert call.url.path == "/payments/pay_1/cash-receipt/cancel"
    import json as _json

    assert _json.loads(call.content) == {"storeId": STORE_ID}


def test_ec_k7_get_cash_receipt() -> None:
    transport = RecordingTransport()
    transport.script(
        "GET",
        "/payments/pay_1/cash-receipt",
        httpx.Response(
            200, json={"status": "ISSUED", "paymentId": "pay_1", "issueNumber": "1", "url": "https://x"}
        ),
    )
    provider = make_provider_with_channel_key(transport)

    async def run():
        return await provider.get_cash_receipt(payment_ref="pay_1")

    receipt = asyncio.run(run())
    assert receipt is not None
    assert receipt.status == "issued"


def test_ec_k7_get_cash_receipt_returns_none_on_not_found() -> None:
    transport = RecordingTransport()
    transport.script(
        "GET",
        "/payments/pay_missing/cash-receipt",
        httpx.Response(404, json={"type": "CashReceiptNotFoundError", "message": "not found"}),
    )
    provider = make_provider_with_channel_key(transport)

    async def run():
        return await provider.get_cash_receipt(payment_ref="pay_missing")

    receipt = asyncio.run(run())
    assert receipt is None


# ── [EC:A23] uncancel_subscription — unsupported by design (no native subscription) ─────


def test_ec_a23_uncancel_subscription_raises_unsupported() -> None:
    transport = RecordingTransport()
    provider = make_provider(transport)

    async def run():
        return await provider.uncancel_subscription("sub_ref")

    with pytest.raises(PaymentKitError) as exc_info:
        asyncio.run(run())
    assert exc_info.value.code == "unsupported"
    assert transport.calls == []
