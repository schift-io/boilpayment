"""spec: packages/lifecycle/spec/lifecycle.pseudo.md [EC:A9]"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from boilpayment_core import (
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    LedgerReference,
    Money,
    NewLedgerEntry,
    Payment,
    Period,
    Plan,
    PlanPrice,
    SequentialIdGen,
    Subscription,
    resolve_policy,
)
from boilpayment_lifecycle import ConvertTrialInput, convert_trial

PLAN = Plan(
    id="plan_paid",
    name="Paid",
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


def mk_sub() -> Subscription:
    return Subscription(
        id="sub_1",
        customer_id="cust_1",
        plan_id="plan_trial",
        provider="stripe",
        provider_ref="stripe_sub_1",
        status="trialing",
        current_period=PERIOD,
        anchor_day=1,
        cancel_at_period_end=False,
        grace_until=None,
        billing_key=None,
        scheduled_plan_id=None,
        created_at=PERIOD.start,
    )


def mk_payment() -> Payment:
    return Payment(
        id="pay_1",
        customer_id="cust_1",
        provider="stripe",
        provider_ref="pi_1",
        subscription_id="sub_1",
        amount=Money(amount_minor=1000, currency="USD"),
        status="succeeded",
        kind="subscription",
        period=PERIOD,
        occurred_at=PERIOD.start,
        failure=None,
    )


async def setup(trial_balance: int):
    clock = FixedClock(PERIOD.start)
    ledger = InMemoryLedger(SequentialIdGen("led_"))
    repo = InMemoryRepo()
    await repo.plans.put(PLAN)
    if trial_balance > 0:
        await ledger.append(
            NewLedgerEntry(
                customer_id="cust_1",
                pool="trial",
                kind="grant",
                amount=trial_balance,
                source="trial",
                reference=LedgerReference(),
                idempotency_key="trial_seed",
                actor="system",
            )
        )
    return clock, ledger, repo


def test_grant_full_default_grants_paid_discards_trial():
    async def scenario():
        clock, ledger, repo = await setup(50)
        sub = mk_sub()
        policy = resolve_policy()

        res = await convert_trial(
            ConvertTrialInput(
                sub=sub,
                plan=PLAN,
                payment=mk_payment(),
                policy=policy,
                ledger=ledger,
                repo=repo,
                clock=clock,
            )
        )
        assert res.sub.status == "active"
        assert res.sub.plan_id == PLAN.id
        assert res.grant.amount == 100
        assert res.trial_revoked.amount == -50
        paid_bal = await ledger.balance("cust_1", "paid", clock.now())
        trial_bal = await ledger.balance("cust_1", "trial", clock.now())
        assert paid_bal.available == 100
        assert trial_bal.available == 0

    run(scenario())


def test_grant_full_keep_trial_leaves_trial_pool_alone():
    async def scenario():
        clock, ledger, repo = await setup(50)
        sub = mk_sub()
        policy = resolve_policy(
            {"trial": {"creditsOnConvert": "grant_full_keep_trial"}}
        )

        res = await convert_trial(
            ConvertTrialInput(
                sub=sub,
                plan=PLAN,
                payment=mk_payment(),
                policy=policy,
                ledger=ledger,
                repo=repo,
                clock=clock,
            )
        )
        assert res.grant.amount == 100
        assert res.trial_revoked is None
        trial_bal = await ledger.balance("cust_1", "trial", clock.now())
        assert trial_bal.available == 50

    run(scenario())


def test_no_grant_until_next_period_grants_nothing_now():
    async def scenario():
        clock, ledger, repo = await setup(50)
        sub = mk_sub()
        policy = resolve_policy(
            {"trial": {"creditsOnConvert": "no_grant_until_next_period"}}
        )

        res = await convert_trial(
            ConvertTrialInput(
                sub=sub,
                plan=PLAN,
                payment=mk_payment(),
                policy=policy,
                ledger=ledger,
                repo=repo,
                clock=clock,
            )
        )
        assert res.grant is None
        assert res.trial_revoked is None
        assert res.sub.status == "active"
        paid_bal = await ledger.balance("cust_1", "paid", clock.now())
        assert paid_bal.available == 0
        trial_bal = await ledger.balance("cust_1", "trial", clock.now())
        assert trial_bal.available == 50

    run(scenario())


def test_sb_03_first_paid_invoice_after_trial_grants_once():
    async def scenario():
        clock, ledger, repo = await setup(0)
        trial_plan = Plan(
            id=PLAN.id,
            name=PLAN.name,
            interval=PLAN.interval,
            credits_per_period=PLAN.credits_per_period,
            usage_included=PLAN.usage_included,
            trial_days=14,
            prices=PLAN.prices,
        )
        sub = Subscription(
            id="sub_1",
            customer_id="cust_1",
            plan_id=trial_plan.id,
            provider="stripe",
            provider_ref="stripe_sub_1",
            status="trialing",
            current_period=PERIOD,
            anchor_day=1,
            cancel_at_period_end=False,
            grace_until=None,
            billing_key=None,
            scheduled_plan_id=None,
            created_at=PERIOD.start,
        )

        assert sub.status == "trialing"
        assert (await ledger.balance(sub.customer_id, "paid", clock.now())).available == 0

        input = ConvertTrialInput(
            sub=sub,
            plan=trial_plan,
            payment=mk_payment(),
            policy=resolve_policy(),
            ledger=ledger,
            repo=repo,
            clock=clock,
        )
        first = await convert_trial(input)
        replay = await convert_trial(input)

        assert first.grant.amount == trial_plan.credits_per_period
        assert replay.grant.id == first.grant.id
        assert (
            await ledger.balance(sub.customer_id, "paid", clock.now())
        ).available == trial_plan.credits_per_period

    run(scenario())
