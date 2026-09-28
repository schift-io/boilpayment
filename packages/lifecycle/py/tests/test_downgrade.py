"""spec: packages/lifecycle/spec/lifecycle.pseudo.md [EC:A3] [EC:A4] [EC:F]"""

from __future__ import annotations

import asyncio
import dataclasses
from datetime import UTC, datetime
from typing import TypedDict, Unpack

import pytest
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
from boilpayment_lifecycle import (
    DowngradeInput,
    OnRenewalPaidInput,
    downgrade,
    on_renewal_paid,
)
from helpers import FakeNativeProvider, FakeSelfSchedulingProvider

PLAN_A = Plan(
    id="plan_a",
    name="Plan A",
    interval="month",
    credits_per_period=100,
    usage_included=0,
    trial_days=0,
    prices=[
        PlanPrice(
            currency="USD",
            amount_minor=1000,
            provider_price_refs={"stripe": "price_stripe_a", "polar": "price_polar_a"},
        )
    ],
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


class ScheduledChange(TypedDict):
    new_price_ref: str
    proration: str
    reset_anchor: bool


class SchedulingNativeProvider(FakeNativeProvider):
    def __init__(self) -> None:
        super().__init__()
        self.last_change: ScheduledChange | None = None

    async def change_subscription(
        self, provider_ref: str, **kwargs: Unpack[ScheduledChange]
    ) -> Subscription:
        self.last_change = kwargs
        return await super().change_subscription(provider_ref, **kwargs)


@pytest.mark.parametrize("provider_name", ["stripe", "polar"])
def test_sb_14_end_of_period_schedules_lower_provider_price_and_renews_lower_plan(
    provider_name: str,
):
    async def scenario():
        clock, ledger, repo, ids = await setup(300)
        sub = mk_sub(
            provider=provider_name, provider_ref=f"{provider_name}_sub_1"
        )
        await repo.subscriptions.put(sub)
        provider = SchedulingNativeProvider()
        provider.set_dummy_sub(dataclasses.replace(sub, plan_id=PLAN_A.id))

        downgraded = await downgrade(
            DowngradeInput(
                sub=sub,
                new_plan=PLAN_A,
                policy=resolve_policy(),
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )

        assert provider.last_change is not None
        assert provider.last_change["new_price_ref"] == f"price_{provider_name}_a"
        assert provider.last_change["proration"] == "none"
        assert provider.last_change["reset_anchor"] is False
        assert downgraded.sub.plan_id == PLAN_B.id
        assert downgraded.sub.scheduled_plan_id == PLAN_A.id
        assert (await ledger.balance(sub.customer_id, "paid", clock.now())).available == 300

        next_period = Period(
            start=sub.current_period.end, end=datetime(2024, 3, 1, tzinfo=UTC)
        )
        renewal = Payment(
            id=f"pay_{provider_name}_renewal",
            customer_id=sub.customer_id,
            provider=provider_name,
            provider_ref=f"{provider_name}_renewal",
            subscription_id=sub.id,
            amount=Money(amount_minor=1000, currency="USD"),
            status="succeeded",
            kind="subscription",
            period=next_period,
            occurred_at=next_period.start,
            failure=None,
        )
        renewed = await on_renewal_paid(
            OnRenewalPaidInput(
                sub=downgraded.sub,
                payment=renewal,
                policy=resolve_policy(),
                ledger=ledger,
                repo=repo,
                clock=clock,
            )
        )
        assert renewed.sub.plan_id == PLAN_A.id
        assert renewed.grant.entry.amount == PLAN_A.credits_per_period

    run(scenario())


def test_end_of_period_keeps_grants_and_schedules_native_provider():
    async def scenario():
        clock, ledger, repo, ids = await setup(300)
        sub = mk_sub()
        await repo.subscriptions.put(sub)
        provider = FakeNativeProvider()
        provider.set_dummy_sub(dataclasses.replace(sub, plan_id=PLAN_A.id))
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
        assert provider.change_subscription_called == 1
        bal = await ledger.balance("cust_1", None, clock.now())
        assert bal.available == 300

    run(scenario())


def test_end_of_period_self_scheduled_provider_stays_local_only():
    async def scenario():
        clock, ledger, repo, ids = await setup(300, "cust_toss_schedule")
        sub = mk_sub(
            id="sub_toss_schedule",
            customer_id="cust_toss_schedule",
            provider="toss",
            provider_ref=None,
        )
        await repo.subscriptions.put(sub)
        result = await downgrade(DowngradeInput(
            sub=sub,
            new_plan=PLAN_A,
            policy=resolve_policy(),
            provider=FakeSelfSchedulingProvider(),
            ledger=ledger,
            repo=repo,
            clock=clock,
            ids=ids,
        ))
        assert result.sub.plan_id == PLAN_B.id
        assert result.sub.scheduled_plan_id == PLAN_A.id

    run(scenario())


def test_sb_14_unsupported_apple_native_provider_stays_local_only():
    async def scenario():
        clock, ledger, repo, ids = await setup(0, "cust_apple_schedule")
        sub = mk_sub(
            id="sub_apple_schedule",
            customer_id="cust_apple_schedule",
            provider="apple",
            provider_ref="apple_sub",
        )
        await repo.subscriptions.put(sub)
        provider = FakeNativeProvider()

        result = await downgrade(DowngradeInput(
            sub=sub,
            new_plan=PLAN_A,
            policy=resolve_policy(),
            provider=provider,
            ledger=ledger,
            repo=repo,
            clock=clock,
            ids=ids,
        ))

        assert provider.change_subscription_called == 0
        assert result.sub.scheduled_plan_id == PLAN_A.id

    run(scenario())


def test_sb_14_mismatch_grants_charged_plan_and_opens_needs_human_case():
    async def scenario():
        clock, ledger, repo, _ids = await setup(0)
        sub = mk_sub(scheduled_plan_id=PLAN_A.id)
        await repo.subscriptions.put(sub)
        next_period = Period(
            start=sub.current_period.end, end=datetime(2024, 3, 1, tzinfo=UTC)
        )
        payment = Payment(
            id="pay_wrong_price",
            customer_id=sub.customer_id,
            provider="stripe",
            provider_ref="in_wrong_price",
            subscription_id=sub.id,
            amount=Money(amount_minor=3000, currency="USD"),
            status="succeeded",
            kind="subscription",
            period=next_period,
            occurred_at=next_period.start,
            failure=None,
        )

        renewed = await on_renewal_paid(OnRenewalPaidInput(
            sub=sub,
            payment=payment,
            policy=resolve_policy(),
            ledger=ledger,
            repo=repo,
            clock=clock,
        ))

        assert renewed.grant.entry.amount == PLAN_B.credits_per_period
        assert renewed.sub.plan_id == PLAN_B.id
        assert renewed.sub.scheduled_plan_id is None
        case = await repo.cs_cases.get(f"reconcile_mismatch:{payment.id}")
        assert case.status == "needs_human"

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
