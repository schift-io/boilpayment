"""Runs the real credits.* code path against core's InMemoryLedger. No test framework — prints
balances at each step; compare byte-for-byte against ts/examples/smoke.ts's stdout.

Run: .venv/bin/python packages/credits/py/examples/smoke.py
"""

from __future__ import annotations

import asyncio
import dataclasses
from datetime import UTC, datetime

from boilpayment_core import (
    FixedClock,
    InMemoryLedger,
    LedgerReference,
    Money,
    Payment,
    Period,
    Plan,
    PlanPrice,
    SequentialIdGen,
    Subscription,
    resolve_policy,
)
from boilpayment_credits import (
    ClawbackInput,
    ConsumeCreditsInput,
    ExpireDueInput,
    GrantForPeriodInput,
    GrantPoolInput,
    ManualAdjustInput,
    TopupInput,
    clawback,
    consume,
    expire_due,
    grant_for_period,
    grant_promo,
    grant_trial,
    manual_grant,
    manual_revoke,
    topup,
)


async def main() -> None:
    clock = FixedClock(datetime(2024, 1, 1, tzinfo=UTC))
    ledger = InMemoryLedger(SequentialIdGen("led_"))
    policy = resolve_policy()  # DEFAULT_POLICY: rollover='none'

    plan = Plan(
        id="plan_a",
        name="Plan A",
        interval="month",
        credits_per_period=100,
        usage_included=0,
        trial_days=0,
        prices=[PlanPrice(currency="USD", amount_minor=1000)],
    )

    period = Period(
        start=datetime(2024, 1, 1, tzinfo=UTC),
        end=datetime(2024, 2, 1, tzinfo=UTC),
    )

    sub = Subscription(
        id="sub_1",
        customer_id="cust_1",
        plan_id=plan.id,
        provider="stripe",
        provider_ref="stripe_sub_1",
        status="active",
        current_period=period,
        anchor_day=1,
        cancel_at_period_end=False,
        grace_until=None,
        billing_key=None,
        scheduled_plan_id=None,
        created_at=datetime(2024, 1, 1, tzinfo=UTC),
    )

    payment = Payment(
        id="pay_1",
        customer_id="cust_1",
        provider="stripe",
        provider_ref="pi_1",
        subscription_id=sub.id,
        amount=Money(amount_minor=1000, currency="USD"),
        status="succeeded",
        kind="subscription",
        period=period,
        occurred_at=clock.now(),
        failure=None,
    )

    async def show(label: str) -> None:
        balance = await ledger.balance("cust_1", None, clock.now())
        print(f"{label}: balance={balance.available}")

    await grant_for_period(
        GrantForPeriodInput(
            sub=sub,
            plan=plan,
            period=period,
            payment=payment,
            policy=policy,
            ledger=ledger,
            clock=clock,
        )
    )
    await show("01_grant_for_period")

    await consume(
        ConsumeCreditsInput(
            customer_id="cust_1",
            amount=30,
            policy=policy,
            ledger=ledger,
            clock=clock,
            idempotency_key="consume_1",
        )
    )
    await show("02_consume_30")

    topup_payment = dataclasses.replace(
        payment,
        id="pay_topup_1",
        provider_ref="pi_topup_1",
        kind="topup",
        amount=Money(amount_minor=500, currency="USD"),
    )
    await topup(
        TopupInput(
            customer_id="cust_1",
            payment=topup_payment,
            credits=50,
            policy=policy,
            ledger=ledger,
            clock=clock,
        )
    )
    await show("03_topup_50")

    await grant_promo(
        GrantPoolInput(
            customer_id="cust_1",
            amount=20,
            ledger=ledger,
            clock=clock,
            idempotency_key="promo_1",
        )
    )
    await show("04_grant_promo_20")

    await grant_trial(
        GrantPoolInput(
            customer_id="cust_1",
            amount=10,
            ledger=ledger,
            clock=clock,
            idempotency_key="trial_1",
        )
    )
    await show("05_grant_trial_10")

    await manual_grant(
        ManualAdjustInput(
            customer_id="cust_1",
            pool="paid",
            amount=5,
            reason="goodwill",
            actor="admin",
            ledger=ledger,
            clock=clock,
            idempotency_key="manual_grant_1",
        )
    )
    await show("06_manual_grant_5")

    await clawback(
        ClawbackInput(
            customer_id="cust_1",
            amount=15,
            policy=policy,
            ledger=ledger,
            clock=clock,
            reason="chargeback",
            reference=LedgerReference(subscription_id=sub.id),
            actor="system",
            idempotency_key="revoke:chargeback:1",
            shortfall="clamp_to_zero",
        )
    )
    await show("07_clawback_15")

    await manual_revoke(
        ManualAdjustInput(
            customer_id="cust_1",
            pool="promo",
            amount=5,
            reason="abuse",
            actor="admin",
            ledger=ledger,
            clock=clock,
            idempotency_key="manual_revoke_1",
        )
    )
    await show("08_manual_revoke_5")

    before = await expire_due(
        ExpireDueInput(ledger=ledger, clock=clock, customer_id="cust_1")
    )
    print(f"09_expire_due_before_expiry: entries={len(before.entries)}")

    clock.advance(32 * 86_400_000)  # past Feb 1 — the Jan grant's expires_at
    await show("10_after_advance_past_expiry")

    after = await expire_due(
        ExpireDueInput(ledger=ledger, clock=clock, customer_id="cust_1")
    )
    print(f"11_expire_due_after_expiry: entries={len(after.entries)}")
    await show("12_final")


if __name__ == "__main__":
    asyncio.run(main())
