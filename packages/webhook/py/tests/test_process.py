"""Phase 6 regression tests -- packages/webhook/py/src/boilpayment_webhook/process.py
+ handlers.py wiring. Ground truth measured via
`.venv/bin/python packages/webhook/py/examples/smoke.py` this session."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime

from _helpers import FakeProvider, json_verify
from boilpayment_core import (
    DEFAULT_POLICY,
    CollectingNotifier,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    Money,
    Payment,
    Period,
    SequentialIdGen,
    Subscription,
)
from boilpayment_webhook import default_handlers, process, receive


def _setup():
    clock = FixedClock(datetime(2026, 2, 2, tzinfo=UTC))
    repo = InMemoryRepo()
    return clock, repo


def test_ec_process_dispatches_to_registered_handler_and_marks_processed():
    async def run():
        clock, repo = _setup()
        provider = FakeProvider(verify=json_verify())
        raw_body = json.dumps(
            {
                "id": "evt_dispatch",
                "type": "payment.succeeded",
                "occurredAt": clock.now().isoformat(),
            }
        )
        r = await receive(
            provider=provider,
            headers={"x-sig": "ok"},
            raw_body=raw_body,
            repo=repo,
            clock=clock,
        )

        calls = []

        async def handler(ctx):
            calls.append(ctx)

        handlers = {"payment.succeeded": handler}
        await process(
            event_id=r.event_id,
            providers={"stripe": provider},
            handlers=handlers,
            repo=repo,
            clock=clock,
        )

        record = await repo.webhook_events.get(r.event_id)
        assert record.status == "processed"
        assert record.processed_at is not None
        assert record.error is None
        assert record.attempts == 1
        assert len(calls) == 1
        assert calls[0].event.id == "evt_dispatch"

    asyncio.run(run())


def test_ec_process_marks_failed_on_handler_error_and_retry_increments_attempts():
    async def run():
        clock, repo = _setup()
        provider = FakeProvider(verify=json_verify())
        raw_body = json.dumps(
            {
                "id": "evt_retry",
                "type": "payment.succeeded",
                "occurredAt": clock.now().isoformat(),
            }
        )
        r = await receive(
            provider=provider,
            headers={"x-sig": "ok"},
            raw_body=raw_body,
            repo=repo,
            clock=clock,
        )

        async def failing_handler(ctx):
            raise RuntimeError("boom")

        handlers = {"payment.succeeded": failing_handler}
        await process(
            event_id=r.event_id,
            providers={"stripe": provider},
            handlers=handlers,
            repo=repo,
            clock=clock,
        )

        record = await repo.webhook_events.get(r.event_id)
        assert record.status == "failed"
        assert record.error == "boom"
        assert record.attempts == 1

        async def ok_handler(ctx):
            return None

        handlers["payment.succeeded"] = ok_handler
        await process(
            event_id=r.event_id,
            providers={"stripe": provider},
            handlers=handlers,
            repo=repo,
            clock=clock,
        )

        record = await repo.webhook_events.get(r.event_id)
        assert record.status == "processed"
        assert record.error is None
        assert record.attempts == 2

    asyncio.run(run())


def test_ec_e3_unknown_provider_ref_fails_record_and_notifies_reconcile_mismatch():
    async def run():
        clock, repo = _setup()
        provider = FakeProvider(verify=json_verify("stripe"), name="stripe")
        notifier = CollectingNotifier()
        ledger = InMemoryLedger(SequentialIdGen("led_"))

        raw_body = json.dumps(
            {
                "id": "evt_unknown_ref",
                "type": "payment.succeeded",
                "occurredAt": clock.now().isoformat(),
                "paymentRef": "pi_UNKNOWN",
                "subscriptionRef": "sub_UNKNOWN",
            }
        )
        r = await receive(
            provider=provider,
            headers={"x-sig": "ok"},
            raw_body=raw_body,
            repo=repo,
            clock=clock,
        )

        handlers = default_handlers(
            policy=DEFAULT_POLICY,
            ledger=ledger,
            repo=repo,
            notifier=notifier,
            clock=clock,
            ids=SequentialIdGen("id_"),
        )
        await process(
            event_id=r.event_id,
            providers={"stripe": provider},
            handlers=handlers,
            repo=repo,
            clock=clock,
        )

        record = await repo.webhook_events.get(r.event_id)
        assert record.status == "failed"
        assert record.error == "unknown_provider_ref"

        assert len(notifier.sent) == 1
        n = notifier.sent[0]
        assert n.type == "reconcile.mismatch"
        assert n.customer_id is None
        assert n.payload == {
            "kind": "payment",
            "providerRef": "pi_UNKNOWN",
            "provider": "stripe",
        }

    asyncio.run(run())


def test_ec_f_native_subscriptions_false_skips_get_subscription_for_subscription_linked_event():
    async def run():
        clock, repo = _setup()
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        notifier = CollectingNotifier()

        period = Period(
            start=datetime(2026, 2, 1, tzinfo=UTC), end=datetime(2026, 3, 1, tzinfo=UTC)
        )
        sub = Subscription(
            id="sub_local",
            customer_id="cust_1",
            plan_id="plan_pro",
            provider="toss",
            provider_ref="toss_sub_1",
            status="active",
            current_period=period,
            anchor_day=1,
            cancel_at_period_end=False,
            grace_until=None,
            billing_key="bk_1",
            scheduled_plan_id=None,
            created_at=clock.now(),
        )
        payment = Payment(
            id="pay_local",
            customer_id="cust_1",
            provider="toss",
            provider_ref="toss_pi_1",
            subscription_id=sub.id,
            amount=Money(amount_minor=1000, currency="KRW"),
            status="succeeded",
            kind="subscription",
            period=period,
            occurred_at=clock.now(),
            failure=None,
        )
        await repo.subscriptions.put(sub)
        await repo.payments.put(payment)

        def get_subscription_impl(ref):
            raise RuntimeError(
                "get_subscription must never be called when native_subscriptions=False"
            )

        provider = FakeProvider(
            verify=json_verify("toss"),
            name="toss",
            native_subscriptions=False,
            get_payment_impl=lambda ref: payment,
            get_subscription_impl=get_subscription_impl,
        )

        lifecycle_calls = []

        class FakeDunning:
            async def on_payment_failed(self, **kwargs):
                return None

        class FakeLifecycle:
            dunning = FakeDunning()

            async def on_renewal_paid(
                self, *, sub, payment, policy, ledger, repo, clock
            ):
                lifecycle_calls.append(sub.id)

        handlers = default_handlers(
            policy=DEFAULT_POLICY,
            ledger=ledger,
            repo=repo,
            notifier=notifier,
            clock=clock,
            ids=SequentialIdGen("id_"),
            lifecycle=FakeLifecycle(),
        )

        raw_body = json.dumps(
            {
                "id": "evt_toss_sub",
                "type": "payment.succeeded",
                "occurredAt": clock.now().isoformat(),
                "paymentRef": payment.provider_ref,
                "subscriptionRef": sub.provider_ref,
            }
        )
        r = await receive(
            provider=provider,
            headers={"x-sig": "ok"},
            raw_body=raw_body,
            repo=repo,
            clock=clock,
        )
        # process() must not raise even though get_subscription_impl would raise if called
        await process(
            event_id=r.event_id,
            providers={"toss": provider},
            handlers=handlers,
            repo=repo,
            clock=clock,
        )

        record = await repo.webhook_events.get(r.event_id)
        assert record.status == "processed"
        assert provider.get_subscription_called is False
        assert provider.get_payment_called is True
        assert lifecycle_calls == ["sub_local"]

    asyncio.run(run())


def test_ec_f_payment_only_event_still_processes_with_native_subscriptions_false():
    async def run():
        clock, repo = _setup()
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        notifier = CollectingNotifier()

        payment = Payment(
            id="pay_local2",
            customer_id="cust_1",
            provider="toss",
            provider_ref="toss_pi_2",
            subscription_id=None,
            amount=Money(amount_minor=500, currency="KRW"),
            status="succeeded",
            kind="topup",
            period=None,
            occurred_at=clock.now(),
            failure=None,
        )
        await repo.payments.put(payment)

        def get_subscription_impl(ref):
            raise RuntimeError("get_subscription must never be called")

        provider = FakeProvider(
            verify=json_verify("toss"),
            name="toss",
            native_subscriptions=False,
            get_payment_impl=lambda ref: payment,
            get_subscription_impl=get_subscription_impl,
        )

        # no lifecycle/credits deps -- payment-only event with no subscription_ref is a no-op past resolution.
        handlers = default_handlers(
            policy=DEFAULT_POLICY,
            ledger=ledger,
            repo=repo,
            notifier=notifier,
            clock=clock,
            ids=SequentialIdGen("id_"),
        )

        raw_body = json.dumps(
            {
                "id": "evt_toss_payment_only",
                "type": "payment.succeeded",
                "occurredAt": clock.now().isoformat(),
                "paymentRef": payment.provider_ref,
            }
        )
        r = await receive(
            provider=provider,
            headers={"x-sig": "ok"},
            raw_body=raw_body,
            repo=repo,
            clock=clock,
        )
        await process(
            event_id=r.event_id,
            providers={"toss": provider},
            handlers=handlers,
            repo=repo,
            clock=clock,
        )

        record = await repo.webhook_events.get(r.event_id)
        assert record.status == "processed"
        assert provider.get_subscription_called is False

    asyncio.run(run())
