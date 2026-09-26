"""spec: packages/lifecycle/spec/lifecycle.pseudo.md [EC:A7] [EC:A15] [EC:A17] [EC:B12]"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from schift_payment_kit_core import (
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    Money,
    Payment,
    Period,
    Plan,
    PlanPrice,
    SequentialIdGen,
    Subscription,
    resolve_policy,
)
from schift_payment_kit_lifecycle import OnRenewalPaidInput, on_renewal_paid

PLAN = Plan(
    id="plan_a",
    name="Plan A",
    interval="month",
    credits_per_period=100,
    usage_included=0,
    trial_days=0,
    prices=[PlanPrice(currency="USD", amount_minor=1000)],
)
PERIOD = Period(
    start=datetime(2024, 1, 1, tzinfo=UTC), end=datetime(2024, 2, 1, tzinfo=UTC)
)


def run(coro):
    return asyncio.run(coro)


def mk_sub(**overrides) -> Subscription:
    base = {
        "id": "sub_1",
        "customer_id": "cust_1",
        "plan_id": PLAN.id,
        "provider": "stripe",
        "provider_ref": "stripe_sub_1",
        "status": "active",
        "current_period": PERIOD,
        "anchor_day": 1,
        "cancel_at_period_end": False,
        "grace_until": None,
        "billing_key": None,
        "scheduled_plan_id": None,
        "created_at": PERIOD.start,
    }
    base.update(overrides)
    return Subscription(**base)


def mk_payment(**overrides) -> Payment:
    base = {
        "id": "pay_1",
        "customer_id": "cust_1",
        "provider": "stripe",
        "provider_ref": "pi_1",
        "subscription_id": "sub_1",
        "amount": Money(amount_minor=1000, currency="USD"),
        "status": "succeeded",
        "kind": "subscription",
        "period": None,
        "occurred_at": PERIOD.start,
        "failure": None,
    }
    base.update(overrides)
    return Payment(**base)


async def setup():
    clock = FixedClock(PERIOD.start)
    ledger = InMemoryLedger(SequentialIdGen("led_"))
    repo = InMemoryRepo()
    await repo.plans.put(PLAN)
    return clock, ledger, repo


def test_ec_a7_b12_second_call_same_period_does_not_double_grant():
    async def scenario():
        clock, ledger, repo = await setup()
        sub = mk_sub()
        await repo.subscriptions.put(sub)
        policy = resolve_policy()

        first = await on_renewal_paid(
            OnRenewalPaidInput(
                sub=sub,
                payment=mk_payment(),
                policy=policy,
                ledger=ledger,
                repo=repo,
                clock=clock,
            )
        )
        assert first.duplicated is False
        assert first.grant.entry.amount == 100

        second = await on_renewal_paid(
            OnRenewalPaidInput(
                sub=first.sub,
                payment=mk_payment(id="pay_2", provider_ref="pi_2"),
                policy=policy,
                ledger=ledger,
                repo=repo,
                clock=clock,
            )
        )
        assert second.duplicated is True
        assert second.grant.duplicated is True
        assert second.grant.entry.id == first.grant.entry.id

        bal = await ledger.balance("cust_1", None, clock.now())
        assert bal.available == 100

    run(scenario())


def test_ec_a17_recovered_true_when_sub_was_past_due():
    async def scenario():
        clock, ledger, repo = await setup()
        sub = mk_sub(status="past_due", grace_until=datetime(2024, 1, 8, tzinfo=UTC))
        await repo.subscriptions.put(sub)
        policy = resolve_policy()

        res = await on_renewal_paid(
            OnRenewalPaidInput(
                sub=sub,
                payment=mk_payment(),
                policy=policy,
                ledger=ledger,
                repo=repo,
                clock=clock,
            )
        )
        assert res.recovered is True
        assert res.sub.status == "active"
        assert res.sub.grace_until is None

    run(scenario())


def test_recovered_false_on_normal_renewal():
    async def scenario():
        clock, ledger, repo = await setup()
        sub = mk_sub()
        await repo.subscriptions.put(sub)
        policy = resolve_policy()

        res = await on_renewal_paid(
            OnRenewalPaidInput(
                sub=sub,
                payment=mk_payment(),
                policy=policy,
                ledger=ledger,
                repo=repo,
                clock=clock,
            )
        )
        assert res.recovered is False

    run(scenario())


def test_ec_a15_forces_active_so_grant_is_not_deferred_for_stale_past_due():
    async def scenario():
        clock, ledger, repo = await setup()
        sub = mk_sub(status="past_due")
        await repo.subscriptions.put(sub)
        policy = resolve_policy()  # default grant_during_grace='defer_until_paid'

        res = await on_renewal_paid(
            OnRenewalPaidInput(
                sub=sub,
                payment=mk_payment(),
                policy=policy,
                ledger=ledger,
                repo=repo,
                clock=clock,
            )
        )
        assert res.grant.deferred is False
        assert res.grant.entry.amount == 100

    run(scenario())
