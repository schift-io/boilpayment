"""Drives the real Polar REST code paths of PolarProvider against tools/mocks/polar/server.mjs
(no keys, no network to polar.sh). Then does a renewal round trip through the real
webhook/lifecycle/credits packages so an order.paid webhook the mock produces actually grants
credits in the core in-memory ledger. Mirrors examples/live/polar-mock.ts exactly.

Run:
  POLAR_MOCK_PORT=12213 node tools/mocks/polar/server.mjs &
  .venv/bin/python examples/live/polar_mock.py
"""

from __future__ import annotations

import asyncio
import base64
import dataclasses
import hashlib
import hmac
import json
import os
import threading
import time
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, HTTPServer

import httpx
from schift_payment_kit_core import (
    DEFAULT_POLICY,
    CollectingNotifier,
    CreateCheckoutInput,
    InMemoryLedger,
    InMemoryRepo,
    Money,
    Payment,
    PaymentKitError,
    Plan,
    PlanPrice,
    SequentialIdGen,
    Subscription,
    SystemClock,
    WebhookSignatureError,
)
from schift_payment_kit_lifecycle import OnRenewalPaidInput
from schift_payment_kit_lifecycle import dunning as lc_dunning
from schift_payment_kit_lifecycle import on_renewal_paid as lc_on_renewal_paid
from schift_payment_kit_polar import PolarProvider
from schift_payment_kit_webhook import default_handlers, process, receive

MOCK_PORT = int(os.environ.get("POLAR_MOCK_PORT", "12213"))
MOCK_BASE = f"http://127.0.0.1:{MOCK_PORT}"
WEBHOOK_SECRET = (
    "whsec_cG9sYXJtb2NrdGVzdHNlY3JldGtleQ=="  # arbitrary valid base64 payload
)


def out(k: str, v) -> None:
    print(f"{k}: {json.dumps(_to_dict(v), default=str)}")


def _to_dict(obj):
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return {f.name: _to_dict(getattr(obj, f.name)) for f in dataclasses.fields(obj)}
    if isinstance(obj, dict):
        return {k: _to_dict(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_to_dict(v) for v in obj]
    if isinstance(obj, datetime):
        return obj.isoformat()
    return obj


def sign_standard_webhook(id_: str, timestamp: str, body: str, secret: str) -> str:
    secret_raw = secret.removeprefix("whsec_")
    key = base64.b64decode(secret_raw)
    signed_content = f"{id_}.{timestamp}.{body}".encode()
    sig = base64.b64encode(
        hmac.new(key, signed_content, hashlib.sha256).digest()
    ).decode("utf-8")
    return f"v1,{sig}"


# ── adapts the real lifecycle package's positional-dataclass functions to the
# webhook package's LifecycleDeps Protocol (kwargs matching OnRenewalPaidInput/OnPaymentFailedInput fields) ──
class RealDunningDeps:
    async def on_payment_failed(self, *, sub, policy, repo, notifier, clock):
        return await lc_dunning.on_payment_failed(
            lc_dunning.OnPaymentFailedInput(
                sub=sub, policy=policy, repo=repo, notifier=notifier, clock=clock
            )
        )


class RealLifecycleDeps:
    def __init__(self) -> None:
        self.dunning = RealDunningDeps()

    async def on_renewal_paid(self, *, sub, payment, policy, ledger, repo, clock):
        return await lc_on_renewal_paid(
            OnRenewalPaidInput(
                sub=sub,
                payment=payment,
                policy=policy,
                ledger=ledger,
                repo=repo,
                clock=clock,
            )
        )


# ── tiny stdlib-only HTTP listener to catch the mock's /__mock/webhook delivery ──
def capture_one_webhook_request(
    port_holder: list[int],
) -> tuple[HTTPServer, threading.Thread]:
    captured: dict = {}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length).decode("utf-8")
            captured["headers"] = {k.lower(): v for k, v in self.headers.items()}
            captured["raw_body"] = body
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"ok":true}')

        def log_message(self, format, *args):  # noqa: A002
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    port_holder.append(server.server_address[1])
    thread = threading.Thread(target=server.handle_request)
    thread.start()
    server._captured = captured  # type: ignore[attr-defined]
    return server, thread


async def main() -> None:
    async with httpx.AsyncClient() as raw:
        p = PolarProvider(
            access_token="polar_oat_test_x",
            webhook_secret=WEBHOOK_SECRET,
            api_base=MOCK_BASE,
        )

        out("capabilities", p.capabilities())

        # ── customer + subscription checkout (prod_sub_basic) ──────────────────
        cust_a = await p.create_customer(email="a@example.com")
        out("createCustomer A", cust_a)
        ck_a = await p.create_checkout(
            CreateCheckoutInput(
                customer_ref=cust_a["ref"],
                plan=Plan(
                    id="plan_basic",
                    name="Basic",
                    interval="month",
                    credits_per_period=1000,
                    usage_included=0,
                    trial_days=0,
                    prices=[],
                ),
                price=PlanPrice(
                    currency="USD",
                    amount_minor=2900,
                    provider_price_refs={"polar": "prod_sub_basic"},
                ),
                mode="subscription",
                success_url="https://x/success",
                cancel_url="https://x/cancel",
                idempotency_key="checkout:a:1",
            )
        )
        out("createCheckout subscription", {"id": ck_a.id, "hasUrl": bool(ck_a.url)})

        payments_a = await p.list_payments(
            customer_ref=cust_a["ref"], since=datetime.fromtimestamp(0, UTC)
        )
        order_a = next((pay for pay in payments_a if pay.subscription_id), None)
        if order_a is None:
            raise RuntimeError(
                "mock did not synthesize a subscription order for checkout A"
            )
        out(
            "listPayments A -> subscription order",
            {
                "paymentRef": order_a.provider_ref,
                "subscriptionRef": order_a.subscription_id,
                "kind": order_a.kind,
                "status": order_a.status,
            },
        )

        pay_a = await p.get_payment(order_a.provider_ref)
        out(
            "getPayment A",
            {"status": pay_a.status, "kind": pay_a.kind, "amount": pay_a.amount},
        )

        sub_a1 = await p.get_subscription(order_a.subscription_id)
        out(
            "getSubscription A",
            {
                "status": sub_a1.status,
                "anchorDay": sub_a1.anchor_day,
                "periodStart": sub_a1.current_period.start,
            },
        )

        # EC:A1 -- reset_anchor has no Polar equivalent and must be silently ignored (see spec "계약 메모")
        ch_a = await p.change_subscription(
            order_a.subscription_id,
            new_price_ref="prod_sub_pro",
            proration="immediate",
            reset_anchor=True,
        )
        out(
            "changeSubscription (immediate, reset_anchor=True)",
            {"status": ch_a.status, "periodStart": ch_a.current_period.start},
        )
        if ch_a.current_period.start != sub_a1.current_period.start:
            raise AssertionError(
                "ASSERTION FAILED: reset_anchor=True must be ignored -- current_period.start changed"
            )
        out("assert resetAnchor ignored", "OK -- current_period.start unchanged")

        cx_a1 = await p.cancel_subscription(order_a.subscription_id, at_period_end=True)
        out(
            "cancelSubscription at_period_end=True",
            {"status": cx_a1.status, "cancelAtPeriodEnd": cx_a1.cancel_at_period_end},
        )

        cx_a2 = await p.cancel_subscription(
            order_a.subscription_id, at_period_end=False
        )
        out(
            "cancelSubscription at_period_end=False (immediate)",
            {"status": cx_a2.status},
        )

        # ── one-time checkout (prod_onetime_pack) -- refund test ────────────────
        cust_b = await p.create_customer(email="b@example.com")
        out("createCustomer B", cust_b)
        ck_b = await p.create_checkout(
            CreateCheckoutInput(
                customer_ref=cust_b["ref"],
                plan=Plan(
                    id="plan_topup",
                    name="Topup",
                    interval="month",
                    credits_per_period=0,
                    usage_included=0,
                    trial_days=0,
                    prices=[],
                ),
                price=PlanPrice(
                    currency="USD",
                    amount_minor=999,
                    provider_price_refs={"polar": "prod_onetime_pack"},
                ),
                mode="one_time",
                success_url="https://x/success",
                cancel_url="https://x/cancel",
                idempotency_key="checkout:b:1",
            )
        )
        out("createCheckout one_time", {"id": ck_b.id, "hasUrl": bool(ck_b.url)})

        payments_b = await p.list_payments(
            customer_ref=cust_b["ref"], since=datetime.fromtimestamp(0, UTC)
        )
        order_b = payments_b[0]
        out(
            "listPayments B -> topup order",
            {
                "paymentRef": order_b.provider_ref,
                "kind": order_b.kind,
                "status": order_b.status,
                "amount": order_b.amount,
            },
        )
        if order_b.kind != "topup":
            raise AssertionError(
                "ASSERTION FAILED: one_time order should normalize to kind=topup"
            )

        caps = p.capabilities()
        refund_amount = (
            order_b.amount.amount_minor // 2
            if caps.partial_refund
            else order_b.amount.amount_minor
        )
        rf = await p.refund(
            payment_ref=order_b.provider_ref,
            amount=Money(amount_minor=refund_amount, currency=order_b.amount.currency),
            reason="requested_by_customer",
            idempotency_key="refund:b:1",
        )
        assert rf.status == "succeeded" and rf.amount.amount_minor == refund_amount and rf.provider_ref
        out(
            "refund (partial per capabilities)",
            {"status": rf.status, "amount": rf.amount, "providerRef": rf.provider_ref},
        )

        # ── report_usage -- idempotent by identifier (EC:C4) ─────────────────────
        usage_key = "usage:b:1"
        await p.report_usage(
            meter="api_calls",
            customer_ref=cust_b["ref"],
            quantity=3,
            occurred_at=datetime.now(UTC),
            idempotency_key=usage_key,
        )
        out("reportUsage (first)", "ok")
        # raw verification call (not through the typed provider -- report_usage() returns None) to prove
        # the mock's events.ingest dedupes by external_id, matching spec's "C4: externalId 로 ... 중복 수집 방지"
        dedup_res = (
            await raw.post(
                f"{MOCK_BASE}/v1/events/ingest",
                headers={
                    "Authorization": "Bearer polar_oat_test_x",
                    "Content-Type": "application/json",
                },
                json={
                    "events": [
                        {
                            "name": "api_calls",
                            "customer_id": cust_b["ref"],
                            "timestamp": datetime.now(UTC).isoformat(),
                            "external_id": usage_key,
                            "metadata": {"value": 3},
                        }
                    ]
                },
            )
        ).json()
        out("reportUsage dedup check (raw, same external_id)", dedup_res)
        if dedup_res["duplicates"] != 1:
            raise AssertionError(
                "ASSERTION FAILED: repeated external_id must be reported as a duplicate"
            )

        # ── unsupported charge_billing_key (native subscriptions provider) ──────
        try:
            await p.charge_billing_key(
                billing_key="x",
                amount=Money(amount_minor=1, currency="USD"),
                order_id="o",
                customer_ref=cust_a["ref"],
                idempotency_key="k",
            )
            raise AssertionError("Expected unsupported billing-key rejection")
        except PaymentKitError as e:
            assert e.code == "unsupported"
            out("chargeBillingKey", e.code)

        # ── verify_webhook: valid / tampered / stale timestamp (EC:E4, EC:webhookSignature) ──
        body = json.dumps(
            {
                "type": "order.paid",
                "timestamp": datetime.now(UTC).isoformat(),
                "data": {
                    "id": "order_verify_test",
                    "customer_id": cust_b["ref"],
                    "total_amount": 1000,
                    "currency": "usd",
                    "status": "paid",
                    "paid": True,
                    "created_at": datetime.now(UTC).isoformat(),
                },
            }
        )
        id_ = "msg_verify_1"
        timestamp = str(int(time.time()))
        sig = sign_standard_webhook(id_, timestamp, body, WEBHOOK_SECRET)
        ev = await p.verify_webhook(
            headers={
                "webhook-id": id_,
                "webhook-timestamp": timestamp,
                "webhook-signature": sig,
            },
            raw_body=body,
        )
        out("verifyWebhook valid", {"type": ev.type, "paymentRef": ev.payment_ref})

        id_ = "msg_verify_2"
        timestamp = str(int(time.time()))
        sig = sign_standard_webhook(id_, timestamp, body, WEBHOOK_SECRET)
        try:
            await p.verify_webhook(
                headers={
                    "webhook-id": id_,
                    "webhook-timestamp": timestamp,
                    "webhook-signature": sig,
                },
                raw_body=body.replace("1000", "999999"),
            )
            raise AssertionError(
                "ASSERTION FAILED: tampered body must fail verification"
            )
        except WebhookSignatureError:
            out("verifyWebhook tampered", "rejected: WebhookSignatureError")

        id_ = "msg_verify_3"
        stale_timestamp = str(int(time.time()) - 3600)  # 1h old
        sig = sign_standard_webhook(id_, stale_timestamp, body, WEBHOOK_SECRET)
        try:
            await p.verify_webhook(
                headers={
                    "webhook-id": id_,
                    "webhook-timestamp": stale_timestamp,
                    "webhook-signature": sig,
                },
                raw_body=body,
            )
            raise AssertionError(
                "ASSERTION FAILED: stale timestamp must fail verification"
            )
        except WebhookSignatureError:
            out("verifyWebhook stale timestamp", "rejected: WebhookSignatureError")

        # ══════════════════════════════════════════════════════════════════════
        # Renewal round trip: mock-produced order.paid webhook -> real webhook.receive/
        # process -> real lifecycle.on_renewal_paid -> real credits grant -> ledger balance.
        # ══════════════════════════════════════════════════════════════════════
        clock = SystemClock()
        repo = InMemoryRepo()
        ledger = InMemoryLedger()
        notifier = CollectingNotifier()
        policy = DEFAULT_POLICY

        cust_c = await p.create_customer(email="c@example.com")
        out("createCustomer C (renewal)", cust_c)
        ck_c = await p.create_checkout(
            CreateCheckoutInput(
                customer_ref=cust_c["ref"],
                plan=Plan(
                    id="plan_basic",
                    name="Basic",
                    interval="month",
                    credits_per_period=1000,
                    usage_included=0,
                    trial_days=0,
                    prices=[],
                ),
                price=PlanPrice(
                    currency="USD",
                    amount_minor=2900,
                    provider_price_refs={"polar": "prod_sub_basic"},
                ),
                mode="subscription",
                success_url="https://x/success",
                cancel_url="https://x/cancel",
                idempotency_key="checkout:c:1",
            )
        )
        out("createCheckout C (renewal)", {"id": ck_c.id})

        payments_c = await p.list_payments(
            customer_ref=cust_c["ref"], since=datetime.fromtimestamp(0, UTC)
        )
        order_c = next(pay for pay in payments_c if pay.subscription_id)
        sub_c = await p.get_subscription(order_c.subscription_id)
        out(
            "checkoutC synthesized",
            {
                "orderRef": order_c.provider_ref,
                "subscriptionRef": order_c.subscription_id,
                "periodStart": sub_c.current_period.start,
                "periodEnd": sub_c.current_period.end,
            },
        )

        plan = Plan(
            id="plan_basic",
            name="Basic",
            interval="month",
            credits_per_period=1000,
            usage_included=0,
            trial_days=0,
            prices=[
                PlanPrice(
                    currency="USD",
                    amount_minor=2900,
                    provider_price_refs={"polar": "prod_sub_basic"},
                )
            ],
        )
        await repo.plans.put(plan)

        local_customer_id = "cust_local_c"
        local_sub = Subscription(
            id="sub_local_c",
            customer_id=local_customer_id,
            plan_id=plan.id,
            provider="polar",
            provider_ref=order_c.subscription_id,
            status="active",
            current_period=sub_c.current_period,
            anchor_day=sub_c.anchor_day,
            cancel_at_period_end=False,
            grace_until=None,
            billing_key=None,
            scheduled_plan_id=None,
            created_at=clock.now(),
        )
        await repo.subscriptions.put(local_sub)
        local_payment = Payment(
            id="pay_local_c",
            customer_id=local_customer_id,
            provider="polar",
            provider_ref=order_c.provider_ref,
            subscription_id=local_sub.id,
            amount=order_c.amount,
            status="pending",
            kind="subscription",
            period=sub_c.current_period,
            occurred_at=clock.now(),
            failure=None,
        )
        await repo.payments.put(local_payment)

        # tiny listener to catch the mock's webhook delivery
        port_holder: list[int] = []
        server, thread = capture_one_webhook_request(port_holder)
        listener_url = f"http://127.0.0.1:{port_holder[0]}/webhook"
        deliver_res = (
            await raw.post(
                f"{MOCK_BASE}/__mock/webhook",
                json={
                    "url": listener_url,
                    "secret": WEBHOOK_SECRET,
                    "type": "order.paid",
                    "id": order_c.provider_ref,
                },
            )
        ).json()
        out("__mock/webhook trigger", deliver_res)
        thread.join(timeout=10)
        server.server_close()
        captured = server._captured  # type: ignore[attr-defined]
        out(
            "webhook received by local listener",
            {
                "headerKeys": [
                    k for k in captured["headers"] if k.startswith("webhook-")
                ]
            },
        )

        receive_result = await receive(
            provider=p,
            headers=captured["headers"],
            raw_body=captured["raw_body"],
            repo=repo,
            clock=clock,
        )
        out("webhook.receive", receive_result)

        handlers = default_handlers(
            policy=policy,
            ledger=ledger,
            repo=repo,
            notifier=notifier,
            clock=clock,
            ids=SequentialIdGen("id_"),
            lifecycle=RealLifecycleDeps(),
        )
        await process(
            event_id=receive_result.event_id,
            providers={"polar": p},
            handlers=handlers,
            repo=repo,
            clock=clock,
        )

        record = await repo.webhook_events.get(receive_result.event_id)
        out(
            "webhook.process record",
            {
                "status": record.status if record else None,
                "error": record.error if record else None,
            },
        )
        if record is None or record.status != "processed":
            raise AssertionError(
                f"ASSERTION FAILED: webhook record should be 'processed', got {record.status if record else None} ({record.error if record else None})"
            )

        balance = await ledger.balance(local_customer_id, None, clock.now())
        out("ledger balance after order.paid webhook", {"available": balance.available})
        if balance.available != plan.credits_per_period:
            raise AssertionError(
                f"ASSERTION FAILED: expected balance.available={plan.credits_per_period}, got {balance.available}"
            )
        out("assert credits granted from mock-produced webhook", "OK")

        print("POLAR-MOCK ROUND TRIP OK")


if __name__ == "__main__":
    asyncio.run(main())
