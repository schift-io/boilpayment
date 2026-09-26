"""EC:C2 (late-report period attribution) EC:C3 (UTC) EC:C4 (outbox enqueue) EC:C7 (meta stored)
spec: packages/usage/spec/usage.pseudo.md
Mirrors packages/usage/ts/test/record.test.ts (same cases, same expected numbers).

pytest-asyncio is not installed -- every test wraps its async body with asyncio.run(...).
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

from boilpayment_core import FixedClock, InMemoryRepo, Plan, SequentialIdGen
from boilpayment_usage import UsageEventInput, record
from fixtures import BASE_POLICY, FakeProvider, mk_sub

PLAN = Plan(
    id="plan_pro",
    name="Pro",
    interval="month",
    credits_per_period=0,
    usage_included=5,
    trial_days=0,
    prices=[],
)


def test_c2_on_time_event_attributes_to_current_period():
    async def run():
        ids = SequentialIdGen("id_")
        clock = FixedClock(datetime(2026, 5, 15, tzinfo=UTC))
        repo = InMemoryRepo()
        sub = mk_sub()

        r = await record(
            event=UsageEventInput(
                customer_id=sub.customer_id,
                meter="api_call",
                quantity=3,
                occurred_at=datetime(2026, 5, 15, tzinfo=UTC),
                idempotency_key="evt_ontime",
            ),
            sub=sub,
            policy=BASE_POLICY,
            repo=repo,
            clock=clock,
            ids=ids,
        )
        assert r.duplicated is False
        assert r.event.period_start == sub.current_period.start

    asyncio.run(run())


def test_c2_late_report_within_window_no_plan_uses_length_approximation():
    async def run():
        ids = SequentialIdGen("id_")
        clock = FixedClock(
            datetime(2026, 5, 2, tzinfo=UTC)
        )  # 24h after current_period.start
        repo = InMemoryRepo()
        sub = mk_sub()

        r = await record(
            event=UsageEventInput(
                customer_id=sub.customer_id,
                meter="api_call",
                quantity=2,
                occurred_at=datetime(2026, 4, 15, tzinfo=UTC),
                idempotency_key="evt_late_approx",
            ),
            sub=sub,
            policy=BASE_POLICY,
            repo=repo,
            clock=clock,
            ids=ids,  # no plan -> approximation path
        )
        period_length = sub.current_period.end - sub.current_period.start
        expected = sub.current_period.start - period_length
        assert r.event.period_start == expected
        assert r.event.period_start.isoformat() == "2026-03-31T00:00:00+00:00"

    asyncio.run(run())


def test_c2_late_report_within_window_with_plan_uses_exact_period_containing():
    async def run():
        ids = SequentialIdGen("id_")
        clock = FixedClock(datetime(2026, 5, 2, tzinfo=UTC))
        repo = InMemoryRepo()
        sub = mk_sub()  # created_at = 2026-01-01, anchor_day = 1

        r = await record(
            event=UsageEventInput(
                customer_id=sub.customer_id,
                meter="api_call",
                quantity=2,
                occurred_at=datetime(2026, 4, 15, tzinfo=UTC),
                idempotency_key="evt_late_exact",
            ),
            sub=sub,
            policy=BASE_POLICY,
            repo=repo,
            clock=clock,
            ids=ids,
            plan=PLAN,
        )
        assert r.event.period_start.isoformat() == "2026-04-01T00:00:00+00:00"
        assert r.event.period_start.isoformat() != "2026-03-31T00:00:00+00:00"

    asyncio.run(run())


def test_c2_boundary_at_48h_is_still_within_window():
    async def run():
        ids = SequentialIdGen("id_")
        boundary = mk_sub().current_period.start + timedelta(hours=48)
        clock = FixedClock(boundary)
        repo = InMemoryRepo()
        sub = mk_sub()

        r = await record(
            event=UsageEventInput(
                customer_id=sub.customer_id,
                meter="api_call",
                quantity=1,
                occurred_at=datetime(2026, 4, 20, tzinfo=UTC),
                idempotency_key="evt_boundary_in",
            ),
            sub=sub,
            policy=BASE_POLICY,
            repo=repo,
            clock=clock,
            ids=ids,
        )
        assert r.event.period_start.isoformat() == "2026-03-31T00:00:00+00:00"

    asyncio.run(run())


def test_c2_just_past_48h_boundary_attributes_to_current_period():
    async def run():
        ids = SequentialIdGen("id_")
        past_boundary = mk_sub().current_period.start + timedelta(
            hours=48, milliseconds=1
        )
        clock = FixedClock(past_boundary)
        repo = InMemoryRepo()
        sub = mk_sub()

        r = await record(
            event=UsageEventInput(
                customer_id=sub.customer_id,
                meter="api_call",
                quantity=1,
                occurred_at=datetime(2026, 4, 20, tzinfo=UTC),
                idempotency_key="evt_boundary_out",
            ),
            sub=sub,
            policy=BASE_POLICY,
            repo=repo,
            clock=clock,
            ids=ids,
        )
        assert r.event.period_start == sub.current_period.start

    asyncio.run(run())


def test_c2_late_report_outside_window_attributes_to_current_period_even_with_plan():
    async def run():
        ids = SequentialIdGen("id_")
        clock = FixedClock(
            datetime(2026, 5, 10, tzinfo=UTC)
        )  # 9 days = 216h > 48h late
        repo = InMemoryRepo()
        sub = mk_sub()

        r = await record(
            event=UsageEventInput(
                customer_id=sub.customer_id,
                meter="api_call",
                quantity=4,
                occurred_at=datetime(2026, 4, 15, tzinfo=UTC),
                idempotency_key="evt_late_outside",
            ),
            sub=sub,
            policy=BASE_POLICY,
            repo=repo,
            clock=clock,
            ids=ids,
            plan=PLAN,
        )
        assert r.event.period_start == sub.current_period.start

    asyncio.run(run())


def test_c2_dedupe_by_idempotency_key():
    async def run():
        ids = SequentialIdGen("id_")
        clock = FixedClock(datetime(2026, 5, 15, tzinfo=UTC))
        repo = InMemoryRepo()
        sub = mk_sub()

        first = await record(
            event=UsageEventInput(
                customer_id=sub.customer_id,
                meter="api_call",
                quantity=4,
                occurred_at=datetime(2026, 5, 15, tzinfo=UTC),
                idempotency_key="evt_dup",
            ),
            sub=sub,
            policy=BASE_POLICY,
            repo=repo,
            clock=clock,
            ids=ids,
        )
        second = await record(
            event=UsageEventInput(
                customer_id=sub.customer_id,
                meter="api_call",
                quantity=999,
                occurred_at=datetime(2026, 5, 16, tzinfo=UTC),
                idempotency_key="evt_dup",
            ),
            sub=sub,
            policy=BASE_POLICY,
            repo=repo,
            clock=clock,
            ids=ids,
        )
        assert second.duplicated is True
        assert second.event.id == first.event.id
        assert second.event.quantity == 4
        all_events = await repo.usage_events.list(idempotency_key="evt_dup")
        assert len(all_events) == 1

    asyncio.run(run())


def test_c3_received_at_from_injected_clock():
    async def run():
        ids = SequentialIdGen("id_")
        fixed = datetime(2026, 5, 20, 12, 34, 56, tzinfo=UTC)
        clock = FixedClock(fixed)
        repo = InMemoryRepo()
        sub = mk_sub()

        r = await record(
            event=UsageEventInput(
                customer_id=sub.customer_id,
                meter="api_call",
                quantity=1,
                occurred_at=datetime(2026, 5, 20, tzinfo=UTC),
                idempotency_key="evt_utc",
            ),
            sub=sub,
            policy=BASE_POLICY,
            repo=repo,
            clock=clock,
            ids=ids,
        )
        assert r.event.received_at.isoformat() == "2026-05-20T12:34:56+00:00"

    asyncio.run(run())


def test_c7_meta_round_trips_verbatim():
    async def run():
        ids = SequentialIdGen("id_")
        clock = FixedClock(datetime(2026, 5, 15, tzinfo=UTC))
        repo = InMemoryRepo()
        sub = mk_sub()
        meta = {"requestId": "req_123", "ip": "1.2.3.4", "userAgent": "test-agent"}

        r = await record(
            event=UsageEventInput(
                customer_id=sub.customer_id,
                meter="api_call",
                quantity=1,
                occurred_at=datetime(2026, 5, 15, tzinfo=UTC),
                idempotency_key="evt_meta",
                meta=meta,
            ),
            sub=sub,
            policy=BASE_POLICY,
            repo=repo,
            clock=clock,
            ids=ids,
        )
        assert r.event.meta == meta

    asyncio.run(run())


def test_c7_meta_defaults_to_none():
    async def run():
        ids = SequentialIdGen("id_")
        clock = FixedClock(datetime(2026, 5, 15, tzinfo=UTC))
        repo = InMemoryRepo()
        sub = mk_sub()

        r = await record(
            event=UsageEventInput(
                customer_id=sub.customer_id,
                meter="api_call",
                quantity=1,
                occurred_at=datetime(2026, 5, 15, tzinfo=UTC),
                idempotency_key="evt_no_meta",
            ),
            sub=sub,
            policy=BASE_POLICY,
            repo=repo,
            clock=clock,
            ids=ids,
        )
        assert r.event.meta is None

    asyncio.run(run())


def test_c4_enqueues_outbox_item_when_provider_reports_meters():
    async def run():
        ids = SequentialIdGen("id_")
        clock = FixedClock(datetime(2026, 5, 15, tzinfo=UTC))
        repo = InMemoryRepo()
        sub = mk_sub()
        provider = FakeProvider(meters=True)

        await record(
            event=UsageEventInput(
                customer_id=sub.customer_id,
                meter="api_call",
                quantity=7,
                occurred_at=datetime(2026, 5, 15, tzinfo=UTC),
                idempotency_key="evt_meters",
            ),
            sub=sub,
            policy=BASE_POLICY,
            repo=repo,
            clock=clock,
            ids=ids,
            provider=provider,
        )
        outbox = await repo.outbox.list(kind="usage.report")
        assert len(outbox) == 1
        assert outbox[0].status == "pending"
        assert outbox[0].attempts == 0
        assert outbox[0].payload["customerId"] == "cust_1"
        assert outbox[0].payload["meter"] == "api_call"
        assert outbox[0].payload["quantity"] == 7
        assert outbox[0].payload["provider"] == "stripe"
        assert provider.report_usage_calls == []

    asyncio.run(run())


def test_c4_no_outbox_when_provider_does_not_report_meters():
    async def run():
        ids = SequentialIdGen("id_")
        clock = FixedClock(datetime(2026, 5, 15, tzinfo=UTC))
        repo = InMemoryRepo()
        sub = mk_sub()
        provider = FakeProvider(meters=False)

        await record(
            event=UsageEventInput(
                customer_id=sub.customer_id,
                meter="api_call",
                quantity=1,
                occurred_at=datetime(2026, 5, 15, tzinfo=UTC),
                idempotency_key="evt_no_meters",
            ),
            sub=sub,
            policy=BASE_POLICY,
            repo=repo,
            clock=clock,
            ids=ids,
            provider=provider,
        )
        outbox = await repo.outbox.list(kind="usage.report")
        assert outbox == []

    asyncio.run(run())


def test_c4_no_outbox_when_no_provider_passed():
    async def run():
        ids = SequentialIdGen("id_")
        clock = FixedClock(datetime(2026, 5, 15, tzinfo=UTC))
        repo = InMemoryRepo()
        sub = mk_sub()

        await record(
            event=UsageEventInput(
                customer_id=sub.customer_id,
                meter="api_call",
                quantity=1,
                occurred_at=datetime(2026, 5, 15, tzinfo=UTC),
                idempotency_key="evt_no_provider",
            ),
            sub=sub,
            policy=BASE_POLICY,
            repo=repo,
            clock=clock,
            ids=ids,
        )
        outbox = await repo.outbox.list(kind="usage.report")
        assert outbox == []

    asyncio.run(run())
