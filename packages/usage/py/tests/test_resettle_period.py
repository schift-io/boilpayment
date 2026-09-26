"""EC:C2 C9 -- see spec/usage.pseudo.md
Mirrors packages/usage/ts/test/resettlePeriod.test.ts (same cases, same expected numbers).
Regression for audit gap #3: usage landing inside the late-report window AFTER close_period() ran
was never billed.

pytest-asyncio is not installed -- every test wraps its async body with asyncio.run(...).
"""

from __future__ import annotations

import asyncio
import dataclasses
from datetime import UTC, datetime

import pytest
from fixtures import mk_sub
from schift_payment_kit_core import (
    DEFAULT_POLICY,
    FixedClock,
    InMemoryRepo,
    SequentialIdGen,
)
from schift_payment_kit_usage import (
    UsageEventInput,
    close_period,
    record,
    resettle_period,
)

BILLED = dataclasses.replace(
    DEFAULT_POLICY,
    usage=dataclasses.replace(
        DEFAULT_POLICY.usage,
        included_quantity=100,
        overage="bill_overage",
        overage_unit_price_minor=5,
        late_report_window_hours=48,
    ),
)


def harness(now: datetime | None = None):
    ids = SequentialIdGen("id_")
    clock = FixedClock(now or datetime(2026, 6, 1, 6, tzinfo=UTC))
    return ids, clock, InMemoryRepo()


class _UsagePeriods:
    """A usage_periods table like schema-postgres has; core's Repo does not declare one."""

    def __init__(self) -> None:
        self.rows: list[dict] = []

    async def put(self, row: dict) -> dict:
        for i, r in enumerate(self.rows):
            if (
                r["subscription_id"] == row["subscription_id"]
                and r["period_start"] == row["period_start"]
            ):
                self.rows[i] = row
                return row
        self.rows.append(row)
        return row

    async def list(self, **f):
        return [
            {"total": r["total"]}
            for r in self.rows
            if ("subscription_id" not in f or r["subscription_id"] == f["subscription_id"])
            and ("period_start" not in f or r["period_start"] == f["period_start"])
        ]


class _RepoWithPeriods(InMemoryRepo):
    def __init__(self) -> None:
        super().__init__()
        self.usage_periods = _UsagePeriods()


async def _rec(sub, policy, repo, clock, ids, qty: int, occurred: datetime, key: str):
    await record(
        event=UsageEventInput(
            customer_id=sub.customer_id,
            meter="api",
            quantity=qty,
            occurred_at=occurred,
            idempotency_key=key,
        ),
        sub=sub,
        policy=policy,
        repo=repo,
        clock=clock,
        ids=ids,
    )


def test_c9_bills_usage_that_arrived_after_close_period():
    async def run():
        ids, clock, repo = harness()
        sub = mk_sub()
        await _rec(sub, BILLED, repo, clock, ids, 120, datetime(2026, 5, 20, tzinfo=UTC), "e1")
        closed = await close_period(sub=sub, policy=BILLED, repo=repo, clock=clock, ids=ids, currency="USD")
        assert closed.total == 120
        assert closed.overage == 20

        await _rec(sub, BILLED, repo, clock, ids, 30, datetime(2026, 5, 31, 23, tzinfo=UTC), "e2")

        r = await resettle_period(
            sub=sub,
            period_start=sub.current_period.start,
            policy=BILLED,
            repo=repo,
            clock=clock,
            settled_total=closed.total,
            currency="KRW",
        )
        assert r.total == 150
        assert r.newly_reported == 30  # silently dropped before the fix
        assert r.additional_overage == 30
        assert r.additional_overage_amount.amount_minor == 150
        assert r.additional_overage_amount.currency == "KRW"
        assert r.window_open is True

    asyncio.run(run())


def test_c9_only_the_part_above_included_is_newly_billable():
    async def run():
        ids, clock, repo = harness()
        sub = mk_sub()
        await _rec(sub, BILLED, repo, clock, ids, 80, datetime(2026, 5, 20, tzinfo=UTC), "e1")
        await _rec(sub, BILLED, repo, clock, ids, 40, datetime(2026, 5, 31, 23, tzinfo=UTC), "e2")
        r = await resettle_period(
            sub=sub,
            period_start=sub.current_period.start,
            policy=BILLED,
            repo=repo,
            clock=clock,
            settled_total=80,
            currency="USD",
        )
        assert r.newly_reported == 40
        assert r.additional_overage == 20
        assert r.additional_overage_amount.amount_minor == 100

    asyncio.run(run())


def test_c9_idempotent_through_the_usage_periods_table():
    async def run():
        ids, clock, _ = harness()
        repo = _RepoWithPeriods()
        sub = mk_sub()
        await _rec(sub, BILLED, repo, clock, ids, 120, datetime(2026, 5, 20, tzinfo=UTC), "e1")
        await close_period(sub=sub, policy=BILLED, repo=repo, clock=clock, ids=ids, currency="USD")
        await _rec(sub, BILLED, repo, clock, ids, 30, datetime(2026, 5, 31, 23, tzinfo=UTC), "e2")

        first = await resettle_period(
            sub=sub, period_start=sub.current_period.start, policy=BILLED, repo=repo, clock=clock, currency="USD"
        )
        assert (first.settled_total, first.total, first.newly_reported) == (120, 150, 30)

        second = await resettle_period(
            sub=sub, period_start=sub.current_period.start, policy=BILLED, repo=repo, clock=clock, currency="USD"
        )
        assert (second.settled_total, second.total, second.newly_reported) == (150, 150, 0)
        assert second.additional_overage == 0
        assert second.additional_overage_amount is None

    asyncio.run(run())


def test_c2_window_open_false_after_late_report_window():
    async def run():
        ids, clock, repo = harness(datetime(2026, 6, 4, tzinfo=UTC))
        sub = mk_sub()
        await _rec(sub, BILLED, repo, clock, ids, 120, datetime(2026, 5, 20, tzinfo=UTC), "e1")
        r = await resettle_period(
            sub=sub,
            period_start=sub.current_period.start,
            policy=BILLED,
            repo=repo,
            clock=clock,
            settled_total=120,
        )
        assert r.window_open is False
        assert r.newly_reported == 0

    asyncio.run(run())


def test_c9_raises_without_settled_total_or_table():
    async def run():
        _, clock, repo = harness()
        sub = mk_sub()
        with pytest.raises(ValueError, match="settled_total is required"):
            await resettle_period(
                sub=sub,
                period_start=sub.current_period.start,
                policy=BILLED,
                repo=repo,
                clock=clock,
            )

    asyncio.run(run())
