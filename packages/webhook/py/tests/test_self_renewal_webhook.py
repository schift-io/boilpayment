"""EC:A45 (round-4 audit A4-9) -- PortOne Transaction.Paid for the renewal charge our scheduler made
completes that renewal, never the top-up branch. Mirrors self-renewal-webhook.test.ts."""

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


_KEEP = object()


def _setup(remote_status: str, remote_period=_KEEP):
    clock = FixedClock(datetime(2026, 3, 1, 0, 5, tzinfo=UTC))
    repo = InMemoryRepo()
    sub = Subscription(
        id="sub_local", customer_id="cust_1", plan_id="plan_pro", provider="portone", provider_ref=None, status="active",
        current_period=Period(start=datetime(2026, 2, 1, tzinfo=UTC), end=PERIOD2.start), anchor_day=1,
        cancel_at_period_end=False, grace_until=None, billing_key="bk", scheduled_plan_id=None, version=0, created_at=clock.now(),
    )
    row = Payment(
        id="pay_rn_1", customer_id="cust_1", provider="portone", provider_ref="ord_abc", subscription_id="sub_local",
        amount=Money(amount_minor=5000, currency="KRW"), status="pending", kind="subscription", period=PERIOD2,
        occurred_at=clock.now(), raw={"boilpaymentAttemptKey": "charge:sub_local:2026-03-01T00:00:00.000Z"},
    )
    remote = dataclasses.replace(row, id="remote", customer_id="", subscription_id=None, status=remote_status,
                                 period=row.period if remote_period is _KEEP else remote_period)
    provider = FakeProvider(verify=json_verify("portone"), name="portone", get_payment_impl=lambda ref: remote)
    renewed: list[str] = []
    topups: list[str] = []

    class FakeDunning:
        async def on_payment_failed(self, **kwargs):
            return None

    class FakeLifecycle:
        dunning = FakeDunning()

        async def on_renewal_paid(self, *, sub, payment, policy, ledger, repo, clock):
            renewed.append(f"{sub.id}:{payment.period.start.isoformat() if payment.period else None}")

    class FakeCredits:
        async def topup(self, **kwargs):
            topups.append("topup")

    handlers = default_handlers(
        policy=DEFAULT_POLICY, ledger=InMemoryLedger(SequentialIdGen("led_")), repo=repo, notifier=CollectingNotifier(),
        clock=clock, ids=SequentialIdGen("p_"), lifecycle=FakeLifecycle(), credits=FakeCredits(),
    )

    async def deliver(event_id: str):
        raw_body = json.dumps({"id": event_id, "type": "payment.succeeded", "occurredAt": clock.now().isoformat(),
                               "customerRef": None, "subscriptionRef": None, "paymentRef": "ord_abc"})
        r = await receive(provider=provider, headers={"x-sig": "ok"}, raw_body=raw_body, repo=repo, clock=clock)
        await process(event_id=r.event_id, providers={"portone": provider}, handlers=handlers, repo=repo, clock=clock)
        return await repo.webhook_events.get(r.event_id)

    return repo, sub, row, renewed, topups, deliver


def test_ec_a45_completes_renewal_not_topup() -> None:
    async def run() -> None:
        repo, sub, row, renewed, topups, deliver = _setup("succeeded")
        await repo.subscriptions.put(sub)
        await repo.payments.put(row)
        record = await deliver("evt_paid_1")
        assert record.error is None and record.status == "processed"
        assert (await repo.payments.get("pay_rn_1")).status == "succeeded"
        assert renewed == ["sub_local:2026-03-01T00:00:00+00:00"]
        assert topups == []

    asyncio.run(run())


def test_ec_a45_not_succeeded_fails_record() -> None:
    async def run() -> None:
        repo, sub, row, renewed, topups, deliver = _setup("pending")
        await repo.subscriptions.put(sub)
        await repo.payments.put(row)
        record = await deliver("evt_paid_2")
        assert record.status == "failed"
        assert renewed == [] and topups == []

    asyncio.run(run())


def test_ec_a51_pays_the_stored_attempt_period_when_provider_has_none() -> None:
    async def run() -> None:
        repo, sub, row, renewed, _topups, deliver = _setup("succeeded", None)
        await repo.subscriptions.put(sub)
        await repo.payments.put(row)
        record = await deliver("evt_paid_3")
        assert record.status == "processed"
        assert renewed == ["sub_local:2026-03-01T00:00:00+00:00"]

    asyncio.run(run())


def test_ec_a51_no_stored_period_records_only() -> None:
    async def run() -> None:
        repo, sub, row, renewed, _topups, deliver = _setup("succeeded", None)
        await repo.subscriptions.put(sub)
        await repo.payments.put(dataclasses.replace(row, period=None))
        record = await deliver("evt_paid_4")
        assert record.status == "processed"
        assert renewed == []
        assert (await repo.payments.get("pay_rn_1")).status == "succeeded"

    asyncio.run(run())
