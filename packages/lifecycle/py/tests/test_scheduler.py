"""spec: packages/lifecycle/spec/lifecycle.pseudo.md [EC:F]"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from boilpayment_core import (
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    Period,
    Plan,
    PlanPrice,
    SequentialIdGen,
    Subscription,
    resolve_policy,
)
from boilpayment_lifecycle.scheduler import (
    DueSubscriptionsInput,
    SchedulerTickInput,
    due_subscriptions,
    tick,
)
from helpers import FakeNativeProvider, FakeSelfSchedulingProvider

PLAN = Plan(
    id="plan_a",
    name="Plan A",
    interval="month",
    credits_per_period=100,
    usage_included=0,
    trial_days=0,
    prices=[PlanPrice(currency="USD", amount_minor=1000)],
)


def run(coro):
    return asyncio.run(coro)


def mk_sub(**overrides) -> Subscription:
    base = {
        "id": "sub_1",
        "customer_id": "cust_1",
        "plan_id": PLAN.id,
        "provider": "toss",
        "provider_ref": "toss_sub_1",
        "status": "active",
        "current_period": Period(
            start=datetime(2024, 1, 1, tzinfo=UTC), end=datetime(2024, 2, 1, tzinfo=UTC)
        ),
        "anchor_day": 1,
        "cancel_at_period_end": False,
        "grace_until": None,
        "billing_key": "bk_1",
        "scheduled_plan_id": None,
        "created_at": datetime(2024, 1, 1, tzinfo=UTC),
    }
    base.update(overrides)
    return Subscription(**base)


def test_ec_f_due_subscriptions_filters_active_with_billing_key_and_elapsed_period():
    async def scenario():
        clock = FixedClock(datetime(2024, 2, 1, tzinfo=UTC))
        repo = InMemoryRepo()
        await repo.subscriptions.put(mk_sub(id="due_1"))
        await repo.subscriptions.put(
            mk_sub(
                id="not_due_yet",
                current_period=Period(
                    start=datetime(2024, 1, 15, tzinfo=UTC),
                    end=datetime(2024, 2, 15, tzinfo=UTC),
                ),
            )
        )
        await repo.subscriptions.put(mk_sub(id="no_billing_key", billing_key=None))
        await repo.subscriptions.put(mk_sub(id="canceled", status="canceled"))

        due = await due_subscriptions(DueSubscriptionsInput(repo=repo, clock=clock))
        assert [s.id for s in due] == ["due_1"]

    run(scenario())


def test_ec_f_tick_no_op_when_scheduling_is_provider():
    async def scenario():
        clock = FixedClock(datetime(2024, 2, 1, tzinfo=UTC))
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        repo = InMemoryRepo()
        ids = SequentialIdGen("id_")
        await repo.plans.put(PLAN)
        await repo.subscriptions.put(mk_sub())
        provider = (
            FakeNativeProvider()
        )  # scheduling='provider'; charge_billing_key raises if called
        policy = resolve_policy()

        res = await tick(
            SchedulerTickInput(
                provider=provider,
                repo=repo,
                policy=policy,
                ledger=ledger,
                clock=clock,
                ids=ids,
            )
        )
        assert res.charged == []
        assert res.failed == []

    run(scenario())


def test_ec_f_tick_charges_due_subs_and_drives_on_renewal_paid_on_success():
    async def scenario():
        clock = FixedClock(datetime(2024, 2, 1, tzinfo=UTC))
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        repo = InMemoryRepo()
        ids = SequentialIdGen("id_")
        await repo.plans.put(PLAN)
        await repo.subscriptions.put(mk_sub())
        provider = FakeSelfSchedulingProvider()
        provider.next_charge_status = "succeeded"
        policy = resolve_policy()

        res = await tick(
            SchedulerTickInput(
                provider=provider,
                repo=repo,
                policy=policy,
                ledger=ledger,
                clock=clock,
                ids=ids,
            )
        )
        assert len(res.charged) == 1
        assert len(res.failed) == 0
        assert res.charged[0].status == "active"
        assert res.charged[0].current_period.start == datetime(2024, 2, 1, tzinfo=UTC)
        bal = await ledger.balance("cust_1", None, clock.now())
        assert bal.available == 100

    run(scenario())


def test_ec_f_tick_drives_on_payment_failed_when_charge_fails():
    async def scenario():
        clock = FixedClock(datetime(2024, 2, 1, tzinfo=UTC))
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        repo = InMemoryRepo()
        ids = SequentialIdGen("id_")
        await repo.plans.put(PLAN)
        await repo.subscriptions.put(mk_sub())
        provider = FakeSelfSchedulingProvider()
        provider.next_charge_status = "failed"
        policy = resolve_policy()

        res = await tick(
            SchedulerTickInput(
                provider=provider,
                repo=repo,
                policy=policy,
                ledger=ledger,
                clock=clock,
                ids=ids,
            )
        )
        assert len(res.charged) == 0
        assert len(res.failed) == 1
        assert res.failed[0].status == "past_due"
        bal = await ledger.balance("cust_1", None, clock.now())
        assert bal.available == 0

    run(scenario())


def test_ec_f_tick_preserves_unknown_provider_outcome_without_dunning():
    async def scenario():
        clock = FixedClock(datetime(2024, 2, 1, tzinfo=UTC))
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        repo = InMemoryRepo()
        ids = SequentialIdGen("id_")
        await repo.plans.put(PLAN)
        await repo.subscriptions.put(mk_sub())
        provider = FakeSelfSchedulingProvider()
        provider.next_charge_throws = True
        policy = resolve_policy()

        # EC:A30 -- reported per subscription, not raised out of the whole tick.
        res = await tick(SchedulerTickInput(
            provider=provider, repo=repo, policy=policy, ledger=ledger,
            clock=clock, ids=ids,
        ))
        assert [(e.subscription_id, "provider unavailable" in e.message) for e in res.errors] == [("sub_1", True)]
        assert (await repo.subscriptions.get("sub_1")).status == "active"
        assert await repo.outbox.list() == []

    run(scenario())
