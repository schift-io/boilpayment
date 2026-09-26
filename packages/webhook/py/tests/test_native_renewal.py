"""EC:E16 -- a native provider (Stripe/Polar) renews on its own and sends payment.succeeded for
a NEW invoice. No local Payment row exists for it yet; the local subscription does.
Mirrors packages/webhook/ts/test/native-renewal.test.ts."""

from __future__ import annotations

import asyncio
import dataclasses
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

PERIOD2 = Period(start=datetime(2026, 3, 1, tzinfo=UTC), end=datetime(2026, 4, 1, tzinfo=UTC))


def _setup(**remote_overrides):
    clock = FixedClock(datetime(2026, 3, 1, 0, 5, tzinfo=UTC))
    repo = InMemoryRepo()
    notifier = CollectingNotifier()
    sub = Subscription(
        id="sub_local", customer_id="cust_1", plan_id="plan_pro", provider="stripe",
        provider_ref="sub_123", status="active",
        current_period=Period(start=datetime(2026, 2, 1, tzinfo=UTC), end=PERIOD2.start),
        anchor_day=1, cancel_at_period_end=False, grace_until=None, billing_key=None,
        scheduled_plan_id=None, version=0, created_at=clock.now(),
    )
    remote = Payment(
        id="in_renew_2", customer_id="", provider="stripe", provider_ref="in_renew_2",
        subscription_id="sub_123", amount=Money(amount_minor=2000, currency="USD"),
        status="succeeded", kind="subscription", period=PERIOD2, occurred_at=clock.now(),
    )
    remote = dataclasses.replace(remote, **remote_overrides)
    provider = FakeProvider(
        verify=json_verify("stripe"), name="stripe",
        get_payment_impl=lambda ref: remote,
        get_subscription_impl=lambda ref: dataclasses.replace(sub, current_period=PERIOD2),
    )
    renewed: list[tuple[str, Payment]] = []

    class FakeDunning:
        async def on_payment_failed(self, **kwargs):
            return None

    class FakeLifecycle:
        dunning = FakeDunning()

        async def on_renewal_paid(self, *, sub, payment, policy, ledger, repo, clock):
            renewed.append((sub.id, payment))

    handlers = default_handlers(
        policy=DEFAULT_POLICY, ledger=InMemoryLedger(SequentialIdGen("led_")), repo=repo,
        notifier=notifier, clock=clock, ids=SequentialIdGen("pay_"), lifecycle=FakeLifecycle(),
    )

    async def deliver(event_id: str):
        raw_body = json.dumps({
            "id": event_id, "type": "payment.succeeded", "occurredAt": clock.now().isoformat(),
            "customerRef": "cus_1", "subscriptionRef": "sub_123", "paymentRef": "in_renew_2",
        })
        r = await receive(provider=provider, headers={"x-sig": "ok"}, raw_body=raw_body, repo=repo, clock=clock)
        await process(event_id=r.event_id, providers={"stripe": provider}, handlers=handlers, repo=repo, clock=clock)
        return await repo.webhook_events.get(r.event_id)

    return repo, sub, notifier, renewed, deliver


def test_ec_e16_records_renewal_invoice_and_renews():
    async def run():
        repo, sub, notifier, renewed, deliver = _setup()
        await repo.subscriptions.put(sub)
        record = await deliver("evt_renew_1")
        assert record.error is None
        assert record.status == "processed"
        payments = await repo.payments.list(provider_ref="in_renew_2")
        assert len(payments) == 1
        p = payments[0]
        assert (p.customer_id, p.subscription_id, p.kind, p.status) == ("cust_1", "sub_local", "subscription", "succeeded")
        assert p.amount == Money(amount_minor=2000, currency="USD")
        assert [s for s, _ in renewed] == ["sub_local"]
        assert renewed[0][1].id == p.id
        assert notifier.sent == []

    asyncio.run(run())


def test_ec_e16_redelivery_does_not_create_second_row():
    async def run():
        repo, sub, _, _, deliver = _setup()
        await repo.subscriptions.put(sub)
        await deliver("evt_renew_1")
        await deliver("evt_renew_1_again")
        assert len(await repo.payments.list(provider_ref="in_renew_2")) == 1

    asyncio.run(run())


def test_ec_e16_payment_of_another_subscription_is_refused():
    async def run():
        repo, sub, _, renewed, deliver = _setup(subscription_id="sub_OTHER")
        await repo.subscriptions.put(sub)
        record = await deliver("evt_renew_foreign")
        assert record.status == "failed"
        assert record.error == "unknown_provider_ref"
        assert await repo.payments.list(provider_ref="in_renew_2") == []
        assert renewed == []

    asyncio.run(run())


def test_ec_e16_unknown_subscription_still_fails_as_unknown_payment():
    async def run():
        repo, _, notifier, _, deliver = _setup()
        record = await deliver("evt_renew_nosub")
        assert record.error == "unknown_provider_ref"
        assert notifier.sent[0].type == "reconcile.mismatch"
        assert notifier.sent[0].payload["kind"] == "payment"
        assert await repo.payments.list() == []

    asyncio.run(run())
