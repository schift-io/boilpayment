"""spec: packages/credits/spec/credits.pseudo.md [EC:B1] [EC:B2]

Regression: examples/e2e/FINDINGS.md #2 -- bank-cap excess must NOT be double-subtracted from
balance. Fixed 2026-09-09 (team lead resolution): rollover_on_renewal no longer writes an
unattributed 'expire' row for the portion over bank_cap; the source grants just lapse on their
own expires_at. Expected: new_period_grant(300) + min(carried_over=270, bank_cap=50) = 350.
"""

from __future__ import annotations

import asyncio
import dataclasses
from datetime import UTC, datetime

from boilpayment_core import (
    ConsumeInput,
    FixedClock,
    InMemoryLedger,
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
from boilpayment_credits import (
    GrantForPeriodInput,
    RolloverInput,
    grant_for_period,
    rollover_on_renewal,
)

PERIOD1 = Period(
    start=datetime(2024, 1, 1, tzinfo=UTC), end=datetime(2024, 2, 1, tzinfo=UTC)
)
PERIOD2 = Period(
    start=datetime(2024, 2, 1, tzinfo=UTC), end=datetime(2024, 3, 1, tzinfo=UTC)
)

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
        "current_period": PERIOD1,
        "anchor_day": 1,
        "cancel_at_period_end": False,
        "grace_until": None,
        "billing_key": None,
        "scheduled_plan_id": None,
        "created_at": PERIOD1.start,
    }
    base.update(overrides)
    return Subscription(**base)


def mk_payment(period: Period, amount_minor: int) -> Payment:
    return Payment(
        id=f"pay_{period.start.isoformat()}",
        customer_id="cust_1",
        provider="stripe",
        provider_ref="pi_1",
        subscription_id="sub_1",
        amount=Money(amount_minor=amount_minor, currency="USD"),
        status="succeeded",
        kind="subscription",
        period=period,
        occurred_at=period.start,
        failure=None,
    )


def test_rollover_none_is_a_no_op_regardless_of_leftover():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        clock = FixedClock(PERIOD2.start)
        policy = resolve_policy({"credits": {"rollover": "none"}})
        sub = mk_sub()
        await ledger.append(
            NewLedgerEntry(
                customer_id="cust_1",
                pool="paid",
                kind="grant",
                amount=100,
                source="subscription",
                reference=LedgerReference(
                    subscription_id=sub.id, period_start=PERIOD1.start
                ),
                idempotency_key="g1",
                actor="system",
                expires_at=PERIOD1.end,
            )
        )
        res = await rollover_on_renewal(
            RolloverInput(
                sub=sub, policy=policy, ledger=ledger, clock=clock, new_period=PERIOD2
            )
        )
        assert res.entries == []
        assert res.banked == 0
        assert res.expired == 0

    run(scenario())


def test_rollover_full_is_a_no_op():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        clock = FixedClock(PERIOD2.start)
        policy = resolve_policy({"credits": {"rollover": "full"}})
        sub = mk_sub()
        res = await rollover_on_renewal(
            RolloverInput(
                sub=sub, policy=policy, ledger=ledger, clock=clock, new_period=PERIOD2
            )
        )
        assert res.entries == []
        assert res.banked == 0
        assert res.expired == 0

    run(scenario())


def test_rollover_banked_regression_300_plus_min_270_50_equals_350():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        clock = FixedClock(PERIOD1.start)
        policy = resolve_policy({"credits": {"rollover": "banked", "bankCap": 50}})
        sub = mk_sub()

        await grant_for_period(
            GrantForPeriodInput(
                sub=sub,
                plan=PLAN_A,
                period=PERIOD1,
                payment=mk_payment(PERIOD1, 1000),
                policy=policy,
                ledger=ledger,
                clock=clock,
            )
        )
        await ledger.consume(
            ConsumeInput(
                customer_id="cust_1",
                pool_order=["paid"],
                amount=30,
                idempotency_key="consume_1",
                meta=LedgerReference(),
                now=clock.now(),
                negative_balance="block",
                negative_floor=0,
            )
        )

        await ledger.append(
            NewLedgerEntry(
                customer_id="cust_1",
                pool="paid",
                kind="grant",
                amount=200,
                source="subscription",
                reference=LedgerReference(
                    subscription_id=sub.id, period_start=PERIOD1.start
                ),
                idempotency_key="grant:upgrade:sub_1",
                actor="system",
                expires_at=PERIOD1.end,
                reason="upgrade:plan_a->plan_b",
            )
        )
        # total carried-over leftover = 70 + 200 = 270

        clock.advance(31 * 86_400_000)  # Jan1 -> Feb1 == PERIOD2.start

        rollover = await rollover_on_renewal(
            RolloverInput(
                sub=dataclasses.replace(sub, plan_id=PLAN_B.id),
                policy=policy,
                ledger=ledger,
                clock=clock,
                new_period=PERIOD2,
            )
        )
        assert rollover.banked == 50
        assert rollover.expired == 220  # 270 - 50, NOT written as a ledger entry
        assert len(rollover.entries) == 1

        all_entries = await ledger.entries("cust_1")
        assert [e for e in all_entries if e.kind == "expire"] == []

        await grant_for_period(
            GrantForPeriodInput(
                sub=dataclasses.replace(sub, plan_id=PLAN_B.id, current_period=PERIOD2),
                plan=PLAN_B,
                period=PERIOD2,
                payment=mk_payment(PERIOD2, 3000),
                policy=policy,
                ledger=ledger,
                clock=clock,
            )
        )

        bal = await ledger.balance("cust_1", None, clock.now())
        assert bal.available == 350  # 300 + min(270, 50)

    run(scenario())


def test_rollover_already_banked_prevents_double_banking_on_retry():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        clock = FixedClock(PERIOD1.start)
        policy = resolve_policy({"credits": {"rollover": "banked", "bankCap": 50}})
        sub = mk_sub()

        await grant_for_period(
            GrantForPeriodInput(
                sub=sub,
                plan=PLAN_A,
                period=PERIOD1,
                payment=mk_payment(PERIOD1, 1000),
                policy=policy,
                ledger=ledger,
                clock=clock,
            )
        )
        await ledger.consume(
            ConsumeInput(
                customer_id="cust_1",
                pool_order=["paid"],
                amount=30,
                idempotency_key="consume_1",
                meta=LedgerReference(),
                now=clock.now(),
                negative_balance="block",
                negative_floor=0,
            )
        )
        await ledger.append(
            NewLedgerEntry(
                customer_id="cust_1",
                pool="paid",
                kind="grant",
                amount=200,
                source="subscription",
                reference=LedgerReference(
                    subscription_id=sub.id, period_start=PERIOD1.start
                ),
                idempotency_key="grant:upgrade:sub_1",
                actor="system",
                expires_at=PERIOD1.end,
            )
        )
        clock.advance(31 * 86_400_000)

        first = await rollover_on_renewal(
            RolloverInput(
                sub=sub, policy=policy, ledger=ledger, clock=clock, new_period=PERIOD2
            )
        )
        assert first.banked == 50
        assert len(first.entries) == 1

        second = await rollover_on_renewal(
            RolloverInput(
                sub=sub, policy=policy, ledger=ledger, clock=clock, new_period=PERIOD2
            )
        )
        assert second.banked == 0
        assert len(second.entries) == 0

        rollover_grants = [
            e
            for e in await ledger.entries("cust_1")
            if e.kind == "grant" and e.source == "rollover"
        ]
        assert len(rollover_grants) == 1
        assert rollover_grants[0].amount == 50

    run(scenario())
