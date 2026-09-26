"""spec: packages/lifecycle/spec/lifecycle.pseudo.md [EC:A3] [EC:A4] [EC:F]"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from helpers import FakeNativeProvider, FakeSelfSchedulingProvider
from schift_payment_kit_core import (
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    LedgerReference,
    NewLedgerEntry,
    Period,
    Plan,
    PlanPrice,
    SequentialIdGen,
    Subscription,
    resolve_policy,
)
from schift_payment_kit_lifecycle import DowngradeInput, downgrade

PLAN_A = Plan(
    id="plan_a",
    name="Plan A",
    interval="month",
    credits_per_period=100,
    usage_included=0,
    trial_days=0,
    prices=[PlanPrice(currency="USD", amount_minor=1000)],
)
PLAN_B = Plan(
    id="plan_b",
    name="Plan B",
    interval="month",
    credits_per_period=300,
    usage_included=0,
    trial_days=0,
    prices=[PlanPrice(currency="USD", amount_minor=3000)],
)


def run(coro):
    return asyncio.run(coro)


def mk_sub(**overrides) -> Subscription:
    base = {
        "id": "sub_1",
        "customer_id": "cust_1",
        "plan_id": PLAN_B.id,
        "provider": "stripe",
        "provider_ref": "stripe_sub_1",
        "status": "active",
        "current_period": Period(
            start=datetime(2024, 1, 1, tzinfo=UTC), end=datetime(2024, 2, 1, tzinfo=UTC)
        ),
        "anchor_day": 1,
        "cancel_at_period_end": False,
        "grace_until": None,
        "billing_key": None,
        "scheduled_plan_id": None,
        "created_at": datetime(2024, 1, 1, tzinfo=UTC),
    }
    base.update(overrides)
    return Subscription(**base)


async def setup(paid_balance: int, customer_id: str = "cust_1"):
    clock = FixedClock(datetime(2024, 1, 16, tzinfo=UTC))
    ledger = InMemoryLedger(SequentialIdGen("led_"))
    repo = InMemoryRepo()
    ids = SequentialIdGen("id_")
    await repo.plans.put(PLAN_A)
    await repo.plans.put(PLAN_B)
    if paid_balance > 0:
        await ledger.append(
            NewLedgerEntry(
                customer_id=customer_id,
                pool="paid",
                kind="grant",
                amount=paid_balance,
                source="subscription",
                reference=LedgerReference(),
                idempotency_key="seed_grant",
                actor="system",
            )
        )
    return clock, ledger, repo, ids


def test_end_of_period_keeps_grants_only_schedules():
    async def scenario():
        clock, ledger, repo, ids = await setup(300)
        sub = mk_sub()
        await repo.subscriptions.put(sub)
        provider = FakeNativeProvider()  # must not be called
        policy = resolve_policy()

        res = await downgrade(
            DowngradeInput(
                sub=sub,
                new_plan=PLAN_A,
                policy=policy,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )
        assert res.sub.scheduled_plan_id == PLAN_A.id
        assert res.sub.plan_id == PLAN_B.id
        assert res.clawback is None
        assert provider.change_subscription_called == 0
        bal = await ledger.balance("cust_1", None, clock.now())
        assert bal.available == 300

    run(scenario())


def test_immediate_keep_price_changes_now_grants_kept():
    async def scenario():
        clock, ledger, repo, ids = await setup(300)
        sub = mk_sub()
        await repo.subscriptions.put(sub)
        provider = FakeNativeProvider()
        provider.set_dummy_sub(sub)
        policy = resolve_policy({"downgrade": {"mode": "immediate_keep"}})

        res = await downgrade(
            DowngradeInput(
                sub=sub,
                new_plan=PLAN_A,
                policy=policy,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )
        assert res.sub.plan_id == PLAN_A.id
        assert res.sub.scheduled_plan_id is None
        assert res.clawback is None
        assert provider.change_subscription_called == 1
        bal = await ledger.balance("cust_1", None, clock.now())
        assert bal.available == 300

    run(scenario())


def test_immediate_clawback_claws_back_delta_when_balance_covers_it():
    async def scenario():
        clock, ledger, repo, ids = await setup(250)
        sub = mk_sub()
        await repo.subscriptions.put(sub)
        provider = FakeNativeProvider()
        provider.set_dummy_sub(sub)
        policy = resolve_policy({"downgrade": {"mode": "immediate_clawback"}})

        res = await downgrade(
            DowngradeInput(
                sub=sub,
                new_plan=PLAN_A,
                policy=policy,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )
        assert res.sub.plan_id == PLAN_A.id
        assert res.clawback.revoked == 200
        assert res.clawback.shortfall == 0
        bal = await ledger.balance("cust_1", None, clock.now())
        assert bal.available == 50

    run(scenario())


def test_ec_a4_clamp_to_zero_clamps_revoke_when_balance_short():
    async def scenario():
        clock, ledger, repo, ids = await setup(20)
        sub = mk_sub()
        await repo.subscriptions.put(sub)
        provider = FakeNativeProvider()
        provider.set_dummy_sub(sub)
        policy = resolve_policy(
            {
                "downgrade": {
                    "mode": "immediate_clawback",
                    "clawbackShortfall": "clamp_to_zero",
                }
            }
        )

        res = await downgrade(
            DowngradeInput(
                sub=sub,
                new_plan=PLAN_A,
                policy=policy,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )
        assert res.clawback.revoked == 20
        assert res.clawback.shortfall == 180
        bal = await ledger.balance("cust_1", None, clock.now())
        assert bal.available == 0

    run(scenario())


def test_ec_f_self_scheduling_downgrade_never_calls_change_subscription():
    async def scenario():
        clock, ledger, repo, ids = await setup(250, "cust_toss_1")
        sub = mk_sub(
            id="sub_toss_1",
            customer_id="cust_toss_1",
            provider="toss",
            provider_ref="toss_sub_1",
        )
        await repo.subscriptions.put(sub)
        provider = (
            FakeSelfSchedulingProvider()
        )  # change_subscription raises 'unsupported' if called
        policy = resolve_policy({"downgrade": {"mode": "immediate_clawback"}})

        res = await downgrade(
            DowngradeInput(
                sub=sub,
                new_plan=PLAN_A,
                policy=policy,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )
        assert res.sub.plan_id == PLAN_A.id
        assert res.clawback.revoked == 200
        bal = await ledger.balance("cust_toss_1", None, clock.now())
        assert bal.available == 50

    run(scenario())
