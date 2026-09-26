"""Drives the real Toss SDK-shaped HTTP code paths of TossProvider against
tools/mocks/toss/server.mjs (no keys, no network).
Run: node tools/mocks/toss/server.mjs &  then  .venv/bin/python examples/live/toss_mock.py"""

from __future__ import annotations

import asyncio
import json
import os
import threading
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

import httpx
from schift_payment_kit_core import (
    CreateCheckoutInput,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    Money,
    PaymentKitError,
    Period,
    Plan,
    PlanPrice,
    ProviderError,
    SequentialIdGen,
    Subscription,
    WebhookSignatureError,
    resolve_policy,
)
from schift_payment_kit_lifecycle import scheduler
from schift_payment_kit_lifecycle.scheduler import SchedulerTickInput
from schift_payment_kit_toss import TossProvider, TossProviderConfig

MOCK_BASE = f"http://127.0.0.1:{os.environ.get('TOSS_MOCK_PORT', 12211)}"


def out(k: str, v: Any) -> None:
    print(f"{k}: {json.dumps(v, default=str)}")


async def mock_authorize(
    client: httpx.AsyncClient, body: dict[str, Any]
) -> dict[str, Any]:
    res = await client.post(f"{MOCK_BASE}/__mock/authorize", json=body)
    return res.json()


async def trigger_mock_webhook(client: httpx.AsyncClient, body: dict[str, Any]) -> None:
    await client.post(f"{MOCK_BASE}/__mock/webhook", json=body)


class _CapturingHandler(BaseHTTPRequestHandler):
    captured: dict[str, Any] = {}

    def do_POST(self) -> None:  # noqa: N802 - stdlib method name
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        headers = {k.lower(): v for k, v in self.headers.items()}
        _CapturingHandler.captured = {
            "headers": headers,
            "rawBody": body.decode("utf-8"),
        }
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - silence stdlib logging
        pass


def receive_one_webhook() -> tuple[int, HTTPServer, threading.Thread]:
    """Spins up a one-shot local HTTP receiver so a mock-triggered webhook delivery is a real
    HTTP POST (EC:E4 variant — exercises the wire path, not a hand-built object)."""
    httpd = HTTPServer(("127.0.0.1", 0), _CapturingHandler)
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.handle_request)
    thread.start()
    return port, httpd, thread


async def main() -> None:
    provider = TossProvider(
        TossProviderConfig(
            secret_key="test_sk_mock_123",
            client_key="test_ck_mock_123",
            allowed_webhook_ips=["203.0.113.5"],
            api_base=MOCK_BASE,
        )
    )

    plan = Plan(
        id="plan_krw",
        name="KRW Plan",
        interval="month",
        credits_per_period=500,
        usage_included=0,
        trial_days=0,
        prices=[PlanPrice(currency="KRW", amount_minor=5000)],
    )

    async with httpx.AsyncClient() as client:
        c = await provider.create_customer(email="buyer@example.com")
        out("createCustomer", c)

        checkout = await provider.create_checkout(
            CreateCheckoutInput(
                customer_ref=c["ref"],
                plan=plan,
                price=plan.prices[0],
                mode="subscription",
                success_url="https://x/s",
                cancel_url="https://x/c",
                idempotency_key="checkout:1",
            )
        )
        out("createCheckout", {"id": checkout.id, "hasUrl": bool(checkout.url)})

        # ── confirm_payment: amount match ───────────────────────────────────
        card_payment_key = "pay_card_1"
        await mock_authorize(
            client,
            {
                "paymentKey": card_payment_key,
                "orderId": checkout.provider_ref,
                "amount": 5000,
                "method": "카드",
                "customerKey": c["ref"],
            },
        )
        card_pay = await provider.confirm_payment(
            payment_key=card_payment_key, order_id=checkout.provider_ref, amount=5000
        )
        out(
            "confirmPayment",
            {
                "status": card_pay.status,
                "kind": card_pay.kind,
                "amount": {
                    "amountMinor": card_pay.amount.amount_minor,
                    "currency": card_pay.amount.currency,
                },
            },
        )

        # ── confirm_payment: amount mismatch → error ────────────────────────
        await mock_authorize(
            client,
            {
                "paymentKey": "pay_mismatch_1",
                "orderId": "ord_mismatch_1",
                "amount": 3000,
                "method": "카드",
                "customerKey": c["ref"],
            },
        )
        try:
            await provider.confirm_payment(
                payment_key="pay_mismatch_1", order_id="ord_mismatch_1", amount=9999
            )
            raise AssertionError("Expected confirmPayment_mismatch rejection")
        except ProviderError as e:
            assert e.failure.provider_code == 'INVALID_REQUEST'
            failure = getattr(e, "failure", None)
            out(
                "confirmPayment_mismatch",
                {
                    "code": getattr(e, "code", None),
                    "failureCode": getattr(failure, "code", None),
                    "providerCode": getattr(failure, "provider_code", None),
                },
            )

        # ── confirm_payment / get_payment: virtual account → pending (EC:E8) ─
        await mock_authorize(
            client,
            {
                "paymentKey": "pay_va_1",
                "orderId": "ord_va_1",
                "amount": 20000,
                "method": "가상계좌",
                "customerKey": c["ref"],
            },
        )
        va_pay = await provider.confirm_payment(
            payment_key="pay_va_1", order_id="ord_va_1", amount=20000
        )
        out(
            "confirmPayment_virtualAccount",
            {"status": va_pay.status, "kind": va_pay.kind},
        )
        va_get = await provider.get_payment("pay_va_1")
        out("getPayment_virtualAccount", {"status": va_get.status})
        done_get = await provider.get_payment(card_payment_key)
        out("getPayment_done", {"status": done_get.status})

        # ── issue_billing_key + charge_billing_key (idempotent repeat) ──────
        billing = await provider.issue_billing_key(
            auth_key="authkey_test_1", customer_key=c["ref"]
        )
        out(
            "issueBillingKey",
            {"billingKey": billing.billing_key, "customerKey": billing.customer_key},
        )
        charge1 = await provider.charge_billing_key(
            billing_key=billing.billing_key,
            amount=Money(amount_minor=5000, currency="KRW"),
            order_id="order_charge_1",
            customer_ref=c["ref"],
            idempotency_key="charge:1",
        )
        charge2 = await provider.charge_billing_key(
            billing_key=billing.billing_key,
            amount=Money(amount_minor=5000, currency="KRW"),
            order_id="order_charge_1",
            customer_ref=c["ref"],
            idempotency_key="charge:1",
        )
        out(
            "chargeBillingKey",
            {
                "status": charge1.status,
                "idempotentReplaySameId": charge1.id == charge2.id,
            },
        )

        # ── refund: partial (EC:D4) ──────────────────────────────────────────
        refund_partial = await provider.refund(
            payment_ref=card_pay.id,
            amount=Money(amount_minor=1000, currency="KRW"),
            reason="requested_by_customer",
            idempotency_key="refund:1",
        )
        assert refund_partial.status == "succeeded" and refund_partial.amount.amount_minor == 1000 and refund_partial.provider_ref
        out(
            "refund_partial",
            {
                "status": refund_partial.status,
                "amount": {
                    "amountMinor": refund_partial.amount.amount_minor,
                    "currency": refund_partial.amount.currency,
                },
            },
        )

        # ── refund: virtual account missing refundReceiveAccount (EC:D13) ───
        try:
            await provider.refund(
                payment_ref=va_pay.id,
                amount=Money(amount_minor=20000, currency="KRW"),
                reason="requested_by_customer",
                idempotency_key="refund:va:1",
            )
            raise AssertionError("Expected refund_va_missing_account rejection")
        except PaymentKitError as e:
            assert e.code == 'refund_receive_account_required'
            out("refund_va_missing_account", getattr(e, "code", None))

        refund_va = await provider.refund(
            payment_ref=va_pay.id,
            amount=Money(amount_minor=20000, currency="KRW"),
            reason="requested_by_customer",
            idempotency_key="refund:va:2",
            extra={
                "refundReceiveAccount": {
                    "bank": "신한",
                    "accountNumber": "110-1234-5678",
                    "holderName": "Mock Customer",
                }
            },
        )
        assert refund_va.status == "succeeded" and refund_va.amount.amount_minor == 20000 and refund_va.provider_ref
        out(
            "refund_va_with_account",
            {
                "status": refund_va.status,
                "amount": {
                    "amountMinor": refund_va.amount.amount_minor,
                    "currency": refund_va.amount.currency,
                },
            },
        )

        # ── list_payments (EC:H4, best-effort) ───────────────────────────────
        listed = await provider.list_payments(
            customer_ref=c["ref"], since=datetime.fromtimestamp(0, UTC)
        )
        out("listPayments", {"count": len(listed)})

        # ── verify_webhook: allowed vs disallowed ip (EC:E4 variant) ────────
        port1, httpd1, thread1 = receive_one_webhook()
        await trigger_mock_webhook(
            client,
            {
                "url": f"http://127.0.0.1:{port1}/hook",
                "paymentKey": card_pay.id,
                "status": "DONE",
            },
        )
        thread1.join(timeout=5)
        delivered1 = dict(_CapturingHandler.captured)
        delivered1["headers"]["x-paykit-remote-ip"] = "203.0.113.5"
        ev1 = await provider.verify_webhook(
            headers=delivered1["headers"], raw_body=delivered1["rawBody"]
        )
        out("verifyWebhook_allowed", {"type": ev1.type, "paymentRef": ev1.payment_ref})
        httpd1.server_close()

        port2, httpd2, thread2 = receive_one_webhook()
        await trigger_mock_webhook(
            client,
            {
                "url": f"http://127.0.0.1:{port2}/hook",
                "paymentKey": card_pay.id,
                "status": "DONE",
            },
        )
        thread2.join(timeout=5)
        delivered2 = dict(_CapturingHandler.captured)
        delivered2["headers"]["x-paykit-remote-ip"] = "10.0.0.1"
        try:
            await provider.verify_webhook(
                headers=delivered2["headers"], raw_body=delivered2["rawBody"]
            )
            raise AssertionError("Expected verifyWebhook_disallowed rejection")
        except WebhookSignatureError as e:
                out("verifyWebhook_disallowed", getattr(e, "code", None))
        httpd2.server_close()

    # ── self-scheduler round trip (EC:F) — real TossProvider, real HTTP charge ─
    clock = FixedClock(datetime(2024, 1, 1, tzinfo=UTC))
    ledger = InMemoryLedger(SequentialIdGen("led_"))
    repo = InMemoryRepo()
    ids = SequentialIdGen("id_")
    policy = resolve_policy()

    sched_plan = Plan(
        id="plan_sched",
        name="Scheduled Plan",
        interval="month",
        credits_per_period=500,
        usage_included=0,
        trial_days=0,
        prices=[PlanPrice(currency="KRW", amount_minor=5000)],
    )
    await repo.plans.put(sched_plan)

    sched_customer_key = "cus_sched_1"
    sched_billing = await provider.issue_billing_key(
        auth_key="authkey_sched_1", customer_key=sched_customer_key
    )

    sub = Subscription(
        id="sub_toss_sched_1",
        customer_id=sched_customer_key,
        plan_id=sched_plan.id,
        provider="toss",
        provider_ref="",  # Toss has no native subscription object — see spec "계약 변경 제안"
        status="active",
        current_period=Period(start=datetime(2023, 12, 1, tzinfo=UTC), end=clock.now()),
        anchor_day=1,
        cancel_at_period_end=False,
        grace_until=None,
        billing_key=sched_billing.billing_key,
        scheduled_plan_id=None,
        created_at=datetime(2023, 12, 1, tzinfo=UTC),
    )
    await repo.subscriptions.put(sub)

    tick_result = await scheduler.tick(
        SchedulerTickInput(
            provider=provider,
            repo=repo,
            policy=policy,
            ledger=ledger,
            clock=clock,
            ids=ids,
        )
    )
    balance = await ledger.balance(sched_customer_key, None, clock.now())
    out(
        "scheduler_tick",
        {
            "chargedCount": len(tick_result.charged),
            "failedCount": len(tick_result.failed),
            "balance": balance.available,
        },
    )

    print("TOSS-MOCK ROUND TRIP OK")


if __name__ == "__main__":
    asyncio.run(main())
