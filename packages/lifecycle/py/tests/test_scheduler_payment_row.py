"""[EC:A26] Self-scheduled renewals store the charged payment (Toss sends no webhook for billing
payments), so refunds, settlement, timeline and recovery see it."""
from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from boilpayment_core import (
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    Money,
    Payment,
    SequentialIdGen,
    resolve_policy,
)
from boilpayment_lifecycle.scheduler import SchedulerTickInput, tick
from helpers import FakeSelfSchedulingProvider
from test_scheduler import PLAN, mk_sub

CLOCK_AT = datetime(2024, 2, 1, tzinfo=UTC)


async def _tick(repo, ledger, provider) -> None:
    await tick(SchedulerTickInput(provider=provider, repo=repo, policy=resolve_policy(), ledger=ledger,
                                  clock=FixedClock(CLOCK_AT), ids=SequentialIdGen("id_")))


def test_ec_a26_succeeded_charge_stored_and_grant_points_at_it() -> None:
    async def run():
        repo, ledger = InMemoryRepo(), InMemoryLedger(SequentialIdGen("led_"))
        await repo.plans.put(PLAN)
        await repo.subscriptions.put(mk_sub())
        await _tick(repo, ledger, FakeSelfSchedulingProvider())
        rows = await repo.payments.list(subscription_id="sub_1")
        grants = await ledger.entries("cust_1", kind="grant")
        return ([(p.status, p.kind, p.customer_id, p.provider, p.period.start if p.period else None) for p in rows],
                [g.reference.payment_id for g in grants] == [rows[0].id] if rows else None)

    assert asyncio.run(run()) == ([("succeeded", "subscription", "cust_1", "toss", CLOCK_AT)], True)


def test_ec_a26_retried_charge_reuses_stored_row() -> None:
    async def run():
        repo, ledger = InMemoryRepo(), InMemoryLedger(SequentialIdGen("led_"))
        await repo.plans.put(PLAN)
        sub = mk_sub()
        await repo.subscriptions.put(sub)
        key = f"charge:{sub.id}:{sub.current_period.end.isoformat()}"
        await repo.payments.put(Payment(id="pay_local_earlier", customer_id="cust_1", provider="toss", provider_ref=key,
                                        subscription_id=sub.id, amount=Money(amount_minor=1000, currency="USD"),
                                        status="succeeded", kind="subscription", period=None, occurred_at=CLOCK_AT, failure=None))
        await _tick(repo, ledger, FakeSelfSchedulingProvider())
        return [p.id for p in await repo.payments.list(subscription_id=sub.id)]

    assert asyncio.run(run()) == ["pay_local_earlier"]


def test_ec_a34_declined_charge_is_recorded_as_failed_attempt() -> None:
    async def run():
        repo, ledger = InMemoryRepo(), InMemoryLedger(SequentialIdGen("led_"))
        await repo.plans.put(PLAN)
        await repo.subscriptions.put(mk_sub())
        provider = FakeSelfSchedulingProvider()
        provider.next_charge_status = "failed"
        await _tick(repo, ledger, provider)
        return ([(p.status, p.period.start.isoformat() if p.period else None) for p in await repo.payments.list()],
                (await repo.subscriptions.get("sub_1")).status)

    assert asyncio.run(run()) == ([("failed", "2024-02-01T00:00:00+00:00")], "past_due")
