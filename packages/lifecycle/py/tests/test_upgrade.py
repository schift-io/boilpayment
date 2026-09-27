"""spec: packages/lifecycle/spec/lifecycle.pseudo.md [EC:A1] [EC:A2] [EC:F]"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

import pytest
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
from boilpayment_lifecycle import UpgradeInput, upgrade
from helpers import FakeNativeProvider, FakeSelfSchedulingProvider

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
        "plan_id": PLAN_A.id,
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


async def setup():
    clock = FixedClock(
        datetime(2024, 1, 16, tzinfo=UTC)
    )  # day 16 of a 31-day Jan period
    ledger = InMemoryLedger(SequentialIdGen("led_"))
    repo = InMemoryRepo()
    ids = SequentialIdGen("id_")
    await repo.plans.put(PLAN_A)
    await repo.plans.put(PLAN_B)
    return clock, ledger, repo, ids


def test_immediate_prorate_reset_anchor_full_delta():
    async def scenario():
        clock, ledger, repo, ids = await setup()
        sub = mk_sub()
        await repo.subscriptions.put(sub)
        provider = FakeNativeProvider()
        provider.set_dummy_sub(sub)
        policy = resolve_policy()

        res = await upgrade(
            UpgradeInput(
                sub=sub,
                new_plan=PLAN_B,
                policy=policy,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )
        assert res.credit_delta == 200
        assert res.sub.anchor_day == 16
        assert res.sub.current_period.start == datetime(2024, 1, 16, tzinfo=UTC)
        assert res.sub.current_period.end == datetime(2024, 2, 16, tzinfo=UTC)
        assert res.sub.plan_id == PLAN_B.id
        assert provider.change_subscription_called == 1
        bal = await ledger.balance("cust_1", None, clock.now())
        assert bal.available == 200

    run(scenario())


def test_immediate_prorate_keep_anchor_full_delta():
    async def scenario():
        clock, ledger, repo, ids = await setup()
        sub = mk_sub()
        await repo.subscriptions.put(sub)
        provider = FakeNativeProvider()
        provider.set_dummy_sub(sub)
        policy = resolve_policy({"upgrade": {"mode": "immediate_prorate_keep_anchor"}})

        res = await upgrade(
            UpgradeInput(
                sub=sub,
                new_plan=PLAN_B,
                policy=policy,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )
        assert res.credit_delta == 200
        assert res.sub.anchor_day == 1
        assert res.sub.current_period == sub.current_period
        assert provider.change_subscription_called == 1

    run(scenario())


def test_immediate_prorate_reset_anchor_prorated_delta():
    async def scenario():
        clock, ledger, repo, ids = await setup()
        sub = mk_sub()
        await repo.subscriptions.put(sub)
        provider = FakeNativeProvider()
        provider.set_dummy_sub(sub)
        policy = resolve_policy({"upgrade": {"creditDelta": "prorated_delta"}})

        res = await upgrade(
            UpgradeInput(
                sub=sub,
                new_plan=PLAN_B,
                policy=policy,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )
        assert res.credit_delta == 103  # floor(200 * 16/31)

    run(scenario())


def test_next_period_defers_the_switch():
    async def scenario():
        clock, ledger, repo, ids = await setup()
        sub = mk_sub()
        await repo.subscriptions.put(sub)
        provider = FakeNativeProvider()  # must NOT be called
        policy = resolve_policy({"upgrade": {"mode": "next_period"}})

        res = await upgrade(
            UpgradeInput(
                sub=sub,
                new_plan=PLAN_B,
                policy=policy,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )
        assert res.credit_delta == 0
        assert res.grant is None
        assert res.sub.scheduled_plan_id == PLAN_B.id
        assert res.sub.plan_id == PLAN_A.id
        assert provider.change_subscription_called == 0
        bal = await ledger.balance("cust_1", None, clock.now())
        assert bal.available == 0

    run(scenario())


def test_ec_f_self_scheduling_upgrade_charges_prorated_money_delta():
    async def scenario():
        clock, ledger, repo, ids = await setup()
        sub = mk_sub(
            id="sub_toss_1",
            customer_id="cust_toss_1",
            provider="toss",
            provider_ref="toss_sub_1",
            billing_key="bk_toss_1",
        )
        await repo.subscriptions.put(sub)
        provider = FakeSelfSchedulingProvider()
        policy = resolve_policy({"upgrade": {"mode": "immediate_prorate_keep_anchor"}})

        res = await upgrade(
            UpgradeInput(
                sub=sub,
                new_plan=PLAN_B,
                policy=policy,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )
        assert res.credit_delta == 200
        assert provider.last_charge is not None
        assert provider.last_charge["amount_minor"] == 1032
        assert provider.last_charge["currency"] == "USD"
        bal = await ledger.balance("cust_toss_1", None, clock.now())
        assert bal.available == 200

    run(scenario())


def test_ec_f_self_scheduling_upgrade_without_billing_key_raises():
    async def scenario():
        clock, ledger, repo, ids = await setup()
        sub = mk_sub(
            id="sub_toss_2",
            customer_id="cust_toss_2",
            provider="toss",
            provider_ref="toss_sub_2",
            billing_key=None,
        )
        await repo.subscriptions.put(sub)
        provider = FakeSelfSchedulingProvider()
        policy = resolve_policy()

        with pytest.raises(Exception):  # noqa: B017 -- fake raises a bare Exception on purpose
            await upgrade(
                UpgradeInput(
                    sub=sub,
                    new_plan=PLAN_B,
                    policy=policy,
                    provider=provider,
                    ledger=ledger,
                    repo=repo,
                    clock=clock,
                    ids=ids,
                )
            )

    run(scenario())


def test_j1_calling_upgrade_twice_with_default_key_grants_exactly_once():
    async def scenario():
        clock, ledger, repo, ids = await setup()
        sub = mk_sub()
        await repo.subscriptions.put(sub)
        provider = FakeNativeProvider()
        provider.set_dummy_sub(sub)
        policy = resolve_policy()

        first = await upgrade(
            UpgradeInput(
                sub=sub,
                new_plan=PLAN_B,
                policy=policy,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )
        second = await upgrade(
            UpgradeInput(
                sub=sub,
                new_plan=PLAN_B,
                policy=policy,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )

        assert second.credit_delta == first.credit_delta
        assert second.sub == first.sub
        assert (
            provider.change_subscription_called == 1
        )  # not re-charged at the provider
        bal = await ledger.balance("cust_1", None, clock.now())
        assert bal.available == 200  # granted exactly once, not 400

    run(scenario())


def test_j2_retried_upgrade_with_same_key_but_different_new_plan_raises_idempotency_key_reused():
    import dataclasses

    from boilpayment_core import PaymentKitError

    async def scenario():
        clock, ledger, repo, ids = await setup()
        sub = mk_sub()
        await repo.subscriptions.put(sub)
        provider = FakeNativeProvider()
        provider.set_dummy_sub(sub)
        policy = resolve_policy()

        await upgrade(
            UpgradeInput(
                sub=sub,
                new_plan=PLAN_B,
                policy=policy,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
                ids=ids,
                idempotency_key="upgrade:fixed",
            )
        )

        plan_c = dataclasses.replace(PLAN_B, id="plan_c", credits_per_period=500)
        try:
            await upgrade(
                UpgradeInput(
                    sub=sub,
                    new_plan=plan_c,
                    policy=policy,
                    provider=provider,
                    ledger=ledger,
                    repo=repo,
                    clock=clock,
                    ids=ids,
                    idempotency_key="upgrade:fixed",
                )
            )
            raise AssertionError("expected idempotency_key_reused")
        except PaymentKitError as err:
            assert err.code == "idempotency_key_reused"

    run(scenario())
