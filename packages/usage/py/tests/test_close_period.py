"""EC:C9 -- see spec/usage.pseudo.md
Mirrors packages/usage/ts/test/closePeriod.test.ts (same cases, same expected numbers).

pytest-asyncio is not installed -- every test wraps its async body with asyncio.run(...).
"""

from __future__ import annotations

import asyncio
import dataclasses
from datetime import UTC, datetime

from boilpayment_core import (
    DEFAULT_POLICY,
    FixedClock,
    InMemoryRepo,
    Plan,
    PlanPrice,
    SequentialIdGen,
)
from boilpayment_usage import UsageEventInput, close_period, record
from fixtures import mk_sub


def harness():
    ids = SequentialIdGen("id_")
    clock = FixedClock(datetime(2026, 5, 20, tzinfo=UTC))
    repo = InMemoryRepo()
    return ids, clock, repo


def with_usage_policy(**usage_overrides):
    usage = dataclasses.replace(DEFAULT_POLICY.usage, **usage_overrides)
    return dataclasses.replace(DEFAULT_POLICY, usage=usage)


def test_c9_overage_amount_none_when_within_included():
    async def run():
        ids, clock, repo = harness()
        sub = mk_sub()
        policy = with_usage_policy(
            included_quantity=5, overage="bill_overage", overage_unit_price_minor=250
        )
        await record(
            event=UsageEventInput(
                customer_id=sub.customer_id,
                meter="api_call",
                quantity=4,
                occurred_at=datetime(2026, 5, 2, tzinfo=UTC),
                idempotency_key="e1",
            ),
            sub=sub,
            policy=policy,
            repo=repo,
            clock=clock,
            ids=ids,
        )
        result = await close_period(
            sub=sub, policy=policy, repo=repo, clock=clock, ids=ids
        )
        assert result.total == 4
        assert result.overage == 0
        assert result.overage_amount is None

    asyncio.run(run())


def test_c9_overage_amount_none_when_mode_is_not_bill_overage():
    async def run():
        ids, clock, repo = harness()
        sub = mk_sub()
        policy = with_usage_policy(included_quantity=5, overage="hard_block")
        await record(
            event=UsageEventInput(
                customer_id=sub.customer_id,
                meter="api_call",
                quantity=8,
                occurred_at=datetime(2026, 5, 2, tzinfo=UTC),
                idempotency_key="e2",
            ),
            sub=sub,
            policy=policy,
            repo=repo,
            clock=clock,
            ids=ids,
        )
        result = await close_period(
            sub=sub, policy=policy, repo=repo, clock=clock, ids=ids
        )
        assert result.total == 8
        assert result.overage == 3
        assert result.overage_amount is None

    asyncio.run(run())


def test_c9_overage_amount_computed_when_bill_overage():
    async def run():
        ids, clock, repo = harness()
        sub = mk_sub()
        await repo.plans.put(
            Plan(
                id=sub.plan_id,
                name="Pro",
                interval="month",
                credits_per_period=0,
                usage_included=5,
                trial_days=0,
                prices=[PlanPrice(currency="KRW", amount_minor=10000)],
            )
        )
        policy = with_usage_policy(
            included_quantity=5, overage="bill_overage", overage_unit_price_minor=250
        )
        await record(
            event=UsageEventInput(
                customer_id=sub.customer_id,
                meter="api_call",
                quantity=8,
                occurred_at=datetime(2026, 5, 2, tzinfo=UTC),
                idempotency_key="e3",
            ),
            sub=sub,
            policy=policy,
            repo=repo,
            clock=clock,
            ids=ids,
        )
        result = await close_period(
            sub=sub, policy=policy, repo=repo, clock=clock, ids=ids
        )
        assert result.total == 8
        assert result.overage == 3
        assert result.overage_amount.amount_minor == 750
        assert result.overage_amount.currency == "KRW"

    asyncio.run(run())


def test_c9_total_sums_all_meters_together():
    async def run():
        ids, clock, repo = harness()
        sub = mk_sub()
        policy = with_usage_policy(
            included_quantity=5, overage="bill_overage", overage_unit_price_minor=250
        )
        await record(
            event=UsageEventInput(
                customer_id=sub.customer_id,
                meter="api_call",
                quantity=3,
                occurred_at=datetime(2026, 5, 2, tzinfo=UTC),
                idempotency_key="e4a",
            ),
            sub=sub,
            policy=policy,
            repo=repo,
            clock=clock,
            ids=ids,
        )
        await record(
            event=UsageEventInput(
                customer_id=sub.customer_id,
                meter="storage_gb",
                quantity=6,
                occurred_at=datetime(2026, 5, 3, tzinfo=UTC),
                idempotency_key="e4b",
            ),
            sub=sub,
            policy=policy,
            repo=repo,
            clock=clock,
            ids=ids,
        )
        result = await close_period(
            sub=sub, policy=policy, repo=repo, clock=clock, ids=ids, currency="USD"
        )
        assert result.total == 9
        assert result.overage == 4
        assert result.overage_amount.amount_minor == 1000

    asyncio.run(run())


def test_c9_late_attributed_events_excluded_from_total():
    async def run():
        ids = SequentialIdGen("id_")
        clock = FixedClock(
            datetime(2026, 5, 2, tzinfo=UTC)
        )  # 24h after current_period.start -- within 48h window
        repo = InMemoryRepo()
        sub = mk_sub()
        policy = with_usage_policy(included_quantity=5, overage="hard_block")
        # received while still within the late-report window -> attributed to the PREVIOUS period, excluded
        await record(
            event=UsageEventInput(
                customer_id=sub.customer_id,
                meter="api_call",
                quantity=100,
                occurred_at=datetime(2026, 4, 10, tzinfo=UTC),
                idempotency_key="e5b",
            ),
            sub=sub,
            policy=policy,
            repo=repo,
            clock=clock,
            ids=ids,
        )
        # on-time, counts
        await record(
            event=UsageEventInput(
                customer_id=sub.customer_id,
                meter="api_call",
                quantity=4,
                occurred_at=datetime(2026, 5, 2, tzinfo=UTC),
                idempotency_key="e5a",
            ),
            sub=sub,
            policy=policy,
            repo=repo,
            clock=clock,
            ids=ids,
        )
        clock.advance(
            18 * 24 * 60 * 60 * 1000
        )  # close the period later; doesn't change recorded period_start
        result = await close_period(
            sub=sub, policy=policy, repo=repo, clock=clock, ids=ids
        )
        assert result.total == 4  # the 100-qty late event is NOT counted

    asyncio.run(run())
