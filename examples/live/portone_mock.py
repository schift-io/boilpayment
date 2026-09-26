"""Drives the real PortOne V2 provider (httpx) code paths of PortoneProvider against
tools/mocks/portone/server.mjs (no keys, no network) — mirrors examples/live/portone-mock.ts
exactly (same scenarios, same output shape).
Run: node tools/mocks/portone/server.mjs &   then   .venv/bin/python examples/live/portone_mock.py
"""

from __future__ import annotations

import asyncio
import json
import os
import threading
from dataclasses import asdict
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, HTTPServer

import httpx
from boilpayment_core import (
    DEFAULT_POLICY,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    Money,
    NoopNotifier,
    Payment,
    PaymentKitError,
    ProviderError,
    SequentialIdGen,
    WebhookSignatureError,
)
from boilpayment_credits import TopupInput
from boilpayment_credits import topup as credits_topup
from boilpayment_portone import PortoneProvider, PortoneProviderConfig
from boilpayment_webhook import (
    default_handlers,
    receive,
)
from boilpayment_webhook import (
    process as process_webhook,
)

MOCK_PORT = os.environ.get("PORTONE_MOCK_PORT", "12212")
MOCK_BASE = f"http://127.0.0.1:{MOCK_PORT}"
API_SECRET = "test_dummy_secret"
STORE_ID = "store_dummy"
WEBHOOK_SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"


def out(key: str, value: object) -> None:
    print(f"{key}: {json.dumps(value, default=str)}")


async def mock_call(
    client: httpx.AsyncClient, path: str, method: str, body: dict | None = None
):
    res = await client.request(method, path, json=body)
    data = res.json() if res.content else {}
    if res.is_error:
        raise RuntimeError(f"mock {method} {path} -> {res.status_code}: {data}")
    return data


class _CaptureHandler(BaseHTTPRequestHandler):
    captured: dict | None = None
    event: threading.Event = threading.Event()

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(length).decode("utf-8")
        headers = {k.lower(): v for k, v in self.headers.items()}
        _CaptureHandler.captured = {"headers": headers, "raw_body": raw_body}
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b"{}")
        _CaptureHandler.event.set()

    def log_message(self, *args: object) -> None:  # silence default stderr logging
        pass


async def main() -> None:
    mock_client = httpx.AsyncClient(base_url=MOCK_BASE, timeout=10.0)
    provider = PortoneProvider(
        PortoneProviderConfig(
            api_secret=API_SECRET,
            store_id=STORE_ID,
            webhook_secret=WEBHOOK_SECRET,
            api_base=MOCK_BASE,
        )
    )

    # -- confirmPayment: match + mismatch (EC:E13/E10) --
    await mock_call(
        mock_client,
        "/__mock/seed/payment",
        "POST",
        {
            "id": "pay_confirm_1",
            "status": "PAID",
            "amount": {"total": 10000},
            "currency": "KRW",
            "customer": {"id": "cus_1"},
            "paidAt": "2026-09-01T00:00:05.000Z",
            "requestedAt": "2026-09-01T00:00:00.000Z",
        },
    )
    confirmed = await provider.confirm_payment(
        "pay_confirm_1", Money(amount_minor=10000, currency="KRW")
    )
    out("confirmPayment match", {"status": confirmed.status, "id": confirmed.id})
    try:
        await provider.confirm_payment(
            "pay_confirm_1", Money(amount_minor=9999, currency="KRW")
        )
        raise AssertionError("Expected confirmPayment mismatch rejection")
    except PaymentKitError as e:
        assert e.code == 'amount_mismatch'
        out("confirmPayment mismatch", getattr(e, "code", type(e).__name__))

    # -- getPayment: PAID / VIRTUAL_ACCOUNT_ISSUED -> pending / FAILED with pgCode -> E9 --
    await mock_call(
        mock_client,
        "/__mock/seed/payment",
        "POST",
        {
            "id": "pay_va_1",
            "status": "VIRTUAL_ACCOUNT_ISSUED",
            "amount": {"total": 30000},
            "currency": "KRW",
            "customer": {"id": "cus_1"},
            "requestedAt": "2026-09-01T00:00:00.000Z",
        },
    )
    va_payment = await provider.get_payment("pay_va_1")
    out("getPayment VIRTUAL_ACCOUNT_ISSUED", {"status": va_payment.status})

    await mock_call(
        mock_client,
        "/__mock/seed/payment",
        "POST",
        {
            "id": "pay_failed_1",
            "status": "FAILED",
            "amount": {"total": 8000},
            "currency": "KRW",
            "customer": {"id": "cus_1"},
            "requestedAt": "2026-09-01T00:10:00.000Z",
            "failedAt": "2026-09-01T00:10:05.000Z",
            "failure": {
                "pgCode": "CARD_DECLINED",
                "pgMessage": "Insufficient card limit",
            },
        },
    )
    failed_payment = await provider.get_payment("pay_failed_1")
    out(
        "getPayment FAILED",
        {
            "status": failed_payment.status,
            "failure": asdict(failed_payment.failure)
            if failed_payment.failure
            else None,
        },
    )

    # -- issueBillingKey + chargeBillingKey (idempotent repeat) -- EC:F --
    issued = await provider.issue_billing_key(
        customer={"id": "cus_1"}, method={"card": {"credential": {}}}
    )
    out("issueBillingKey", {"billingKey": issued["billing_key"]})
    order_id = "order_charge_1"
    charge1 = await provider.charge_billing_key(
        billing_key=issued["billing_key"],
        amount=Money(amount_minor=9900, currency="KRW"),
        order_id=order_id,
        customer_ref="cus_1",
        idempotency_key="charge:1",
    )
    out("chargeBillingKey first", {"status": charge1.status, "id": charge1.id})
    # EC:A34 -- real PortOne answers ALREADY_PAID for a paid paymentId (never a second charge); the
    # adapter turns that into the paid payment, so a retried charge is idempotent.
    charge2 = await provider.charge_billing_key(
        billing_key=issued["billing_key"],
        amount=Money(amount_minor=9900, currency="KRW"),
        order_id=order_id,
        customer_ref="cus_1",
        idempotency_key="charge:1-retry",
    )
    assert charge2.status == "succeeded" and charge2.provider_ref == charge1.provider_ref
    out("chargeBillingKey idempotent repeat", {"status": charge2.status, "id": charge2.id})

    # -- schedulePayment + cancelSchedules -- EC:F, scheduling='provider' --
    schedule_result = await provider.schedule_payment(
        billing_key=issued["billing_key"],
        amount=Money(amount_minor=9900, currency="KRW"),
        order_id="order_sched_1",
        customer_ref="cus_1",
        time_to_pay=datetime(2026, 10, 1, tzinfo=UTC),
    )
    out("schedulePayment", schedule_result)
    cancel_schedule_result = await provider.cancel_schedules(
        billing_key=issued["billing_key"]
    )
    out("cancelSchedules", cancel_schedule_result)

    # -- refund partial (D4) + virtual-account refund without/with refundAccount (D13) --
    partial = await provider.refund(
        payment_ref=order_id,
        amount=Money(amount_minor=4000, currency="KRW"),
        reason="partial refund",
        idempotency_key="revoke:1",
    )
    assert partial.status == "succeeded" and partial.amount.amount_minor == 4000 and partial.provider_ref
    out(
        "refund partial",
        {
            "status": partial.status,
            "amount": {
                "amountMinor": partial.amount.amount_minor,
                "currency": partial.amount.currency,
            },
        },
    )

    await mock_call(
        mock_client,
        "/__mock/seed/payment",
        "POST",
        {
            "id": "pay_va_refund_1",
            "status": "PAID",
            "amount": {"total": 20000},
            "currency": "KRW",
            "customer": {"id": "cus_1"},
            "method": {"type": "VirtualAccount"},
            "requestedAt": "2026-09-01T00:00:00.000Z",
            "paidAt": "2026-09-01T00:00:05.000Z",
        },
    )
    try:
        await provider.refund(
            payment_ref="pay_va_refund_1",
            amount=Money(amount_minor=20000, currency="KRW"),
            reason="va refund no account",
            idempotency_key="revoke:2",
        )
        raise AssertionError("Expected refund virtual-account without refundAccount rejection")
    except ProviderError as e:
        assert e.failure.provider_code == 'INVALID_REQUEST'
        failure = getattr(e, "failure", None)
        out(
            "refund virtual-account without refundAccount",
            asdict(failure) if failure else str(e),
        )
    va_refund = await provider.refund(
        payment_ref="pay_va_refund_1",
        amount=Money(amount_minor=20000, currency="KRW"),
        reason="va refund with account",
        idempotency_key="revoke:3",
        extra={
            "refundAccount": {
                "bank": "004",
                "number": "110-123-456789",
                "holderName": "홍길동",
            }
        },
    )
    assert va_refund.status == "succeeded" and va_refund.amount.amount_minor == 20000 and va_refund.provider_ref
    out(
        "refund virtual-account with refundAccount",
        {
            "status": va_refund.status,
            "amount": {
                "amountMinor": va_refund.amount.amount_minor,
                "currency": va_refund.amount.currency,
            },
        },
    )

    # -- listPayments with customer filter (no server-side customer filter exists) --
    await mock_call(
        mock_client,
        "/__mock/seed/payment",
        "POST",
        {
            "id": "pay_other_cust",
            "status": "PAID",
            "amount": {"total": 1000},
            "currency": "KRW",
            "customer": {"id": "cus_OTHER"},
            "requestedAt": "2026-09-01T00:00:00.000Z",
        },
    )
    listed = await provider.list_payments(
        customer_ref="cus_1", since=datetime(2026, 1, 1, tzinfo=UTC)
    )
    out(
        "listPayments customer filter",
        {
            "count": len(listed),
            "allMatchCustomer": all(p.customer_id == "cus_1" for p in listed),
        },
    )

    # -- verifyWebhook: valid / tampered body / stale timestamp -- EC:E4 --
    sign_valid = await mock_call(
        mock_client,
        "/__mock/sign",
        "POST",
        {
            "type": "Transaction.Paid",
            "data": {"paymentId": order_id},
            "secret": WEBHOOK_SECRET,
        },
    )
    valid_event = await provider.verify_webhook(
        headers=sign_valid["headers"], raw_body=sign_valid["body"]
    )
    out(
        "verifyWebhook valid",
        {"type": valid_event.type, "paymentRef": valid_event.payment_ref},
    )

    sign_tamper = await mock_call(
        mock_client,
        "/__mock/sign",
        "POST",
        {
            "type": "Transaction.Paid",
            "data": {"paymentId": order_id},
            "secret": WEBHOOK_SECRET,
        },
    )
    tampered_body = sign_tamper["body"].replace('"paymentId"', '"paymentId2"')
    try:
        await provider.verify_webhook(
            headers=sign_tamper["headers"], raw_body=tampered_body
        )
        raise AssertionError("Expected verifyWebhook tampered rejection")
    except WebhookSignatureError as e:
        out("verifyWebhook tampered", type(e).__name__)

    sign_stale = await mock_call(
        mock_client,
        "/__mock/sign",
        "POST",
        {
            "type": "Transaction.Paid",
            "data": {"paymentId": order_id},
            "secret": WEBHOOK_SECRET,
            "staleSeconds": 600,
        },
    )
    try:
        await provider.verify_webhook(
            headers=sign_stale["headers"], raw_body=sign_stale["body"]
        )
        raise AssertionError("Expected verifyWebhook stale rejection")
    except WebhookSignatureError as e:
        out("verifyWebhook stale", type(e).__name__)

    # -- provider-scheduled renewal round trip: mock pushes a real signed Transaction.Paid
    # webhook to a tiny local listener; webhook.receive/process (with default_handlers wired
    # to the real credits.topup) grants credits from it. PortOne's normalized webhook never
    # carries subscription_ref (PortOne has no native subscription), so this always flows
    # through the credits.topup one-time-payment path, not lifecycle.on_renewal_paid;
    # resolve_topup_credits below stands in for "the app resolves how many credits this
    # renewal charge buys" (EC:B10). --
    clock = FixedClock(datetime(2026, 9, 1, tzinfo=UTC))
    repo = InMemoryRepo()
    ledger = InMemoryLedger(SequentialIdGen("led_"))
    ids = SequentialIdGen("id_")

    renewal_payment = Payment(
        id="local_pay_1",
        customer_id="cus_1",
        provider="portone",
        provider_ref=order_id,
        subscription_id=None,
        amount=Money(amount_minor=9900, currency="KRW"),
        status="pending",
        kind="subscription",
        period=None,
        occurred_at=clock.now(),
        failure=None,
    )
    await repo.payments.put(renewal_payment)

    _CaptureHandler.captured = None
    _CaptureHandler.event = threading.Event()
    httpd = HTTPServer(("127.0.0.1", 12214), _CaptureHandler)
    listener_thread = threading.Thread(target=httpd.handle_request, daemon=True)
    listener_thread.start()

    await mock_call(
        mock_client,
        "/__mock/webhook",
        "POST",
        {
            "url": "http://127.0.0.1:12214/webhook",
            "secret": WEBHOOK_SECRET,
            "type": "Transaction.Paid",
            "data": {"paymentId": order_id},
        },
    )
    _CaptureHandler.event.wait(timeout=5)
    listener_thread.join(timeout=5)
    httpd.server_close()
    delivery = _CaptureHandler.captured
    assert delivery is not None, (
        "mock did not deliver the webhook to the local listener"
    )

    received = await receive(
        provider=provider,
        headers=delivery["headers"],
        raw_body=delivery["raw_body"],
        repo=repo,
        clock=clock,
    )
    out(
        "renewal webhook receive",
        {"status": received.status, "duplicated": received.duplicated},
    )

    class _RealCredits:
        async def topup(self, **kwargs: object) -> object:
            return await credits_topup(TopupInput(**kwargs))  # type: ignore[arg-type]

    async def resolve_topup_credits(_payment: Payment) -> int:
        return 100

    handlers = default_handlers(
        policy=DEFAULT_POLICY,
        ledger=ledger,
        repo=repo,
        notifier=NoopNotifier(),
        clock=clock,
        ids=ids,
        credits=_RealCredits(),
        resolve_topup_credits=resolve_topup_credits,
    )
    await process_webhook(
        event_id=received.event_id,
        providers={"portone": provider},
        handlers=handlers,
        repo=repo,
        clock=clock,
    )
    record = await repo.webhook_events.get(received.event_id)
    balance = await ledger.balance("cus_1", "paid", clock.now())
    out(
        "renewal processed",
        {
            "recordStatus": record.status if record else None,
            "error": record.error if record else None,
        },
    )
    out("credits balance after renewal", asdict(balance))

    await mock_client.aclose()
    print("\nPORTONE-MOCK ROUND TRIP OK")


asyncio.run(main())
