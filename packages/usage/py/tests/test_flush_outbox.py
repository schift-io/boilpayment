"""EC:C4 -- see spec/usage.pseudo.md
Mirrors packages/usage/ts/test/flushOutbox.test.ts (same cases, same expected numbers).

pytest-asyncio is not installed -- every test wraps its async body with asyncio.run(...).
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from fixtures import FakeProvider, mk_sub
from schift_payment_kit_core import (
    DEFAULT_POLICY,
    Customer,
    FixedClock,
    InMemoryRepo,
    ProviderRef,
    SequentialIdGen,
)
from schift_payment_kit_usage import UsageEventInput, flush_outbox, record


def harness():
    ids = SequentialIdGen("id_")
    clock = FixedClock(datetime(2026, 5, 1, tzinfo=UTC))
    repo = InMemoryRepo()
    return ids, clock, repo


LINKED_CUSTOMER = Customer(
    id="cust_1",
    email=None,
    provider_refs=[ProviderRef(provider="stripe", ref="cus_stripe_1")],
    status="active",
    created_at=datetime(2026, 1, 1, tzinfo=UTC),
)


def test_no_provider_ref_fails_immediately():
    async def run():
        ids, clock, repo = harness()
        sub = mk_sub()
        provider = FakeProvider(meters=True)
        # customer is NOT registered in repo.customers at all -> customer lookup returns None -> no providerRef
        await record(
            event=UsageEventInput(
                customer_id=sub.customer_id,
                meter="api_call",
                quantity=1,
                occurred_at=clock.now(),
                idempotency_key="evt_1",
            ),
            sub=sub,
            policy=DEFAULT_POLICY,
            repo=repo,
            clock=clock,
            ids=ids,
            provider=provider,
        )
        result = await flush_outbox(
            repo=repo, providers={"stripe": provider}, clock=clock
        )
        assert result.sent == 0
        assert result.failed == 1
        assert result.retried == 0
        items = await repo.outbox.list(kind="usage.report")
        item = items[0]
        assert item.status == "failed"
        assert item.attempts == 1
        assert item.payload["error"] == "no_provider_ref"
        assert provider.report_usage_calls == []

    asyncio.run(run())


def test_no_provider_ref_never_retried():
    async def run():
        ids, clock, repo = harness()
        sub = mk_sub()
        provider = FakeProvider(meters=True)
        await record(
            event=UsageEventInput(
                customer_id=sub.customer_id,
                meter="api_call",
                quantity=1,
                occurred_at=clock.now(),
                idempotency_key="evt_1",
            ),
            sub=sub,
            policy=DEFAULT_POLICY,
            repo=repo,
            clock=clock,
            ids=ids,
            provider=provider,
        )
        await flush_outbox(repo=repo, providers={"stripe": provider}, clock=clock)
        clock.advance(60 * 60 * 1000)
        second = await flush_outbox(
            repo=repo, providers={"stripe": provider}, clock=clock
        )
        assert second.sent == 0
        assert second.failed == 0
        assert second.retried == 0
        items = await repo.outbox.list(kind="usage.report")
        item = items[0]
        assert item.status == "failed"
        assert item.attempts == 1

    asyncio.run(run())


def test_success_path_moves_to_sent():
    async def run():
        ids, clock, repo = harness()
        sub = mk_sub()
        provider = FakeProvider(meters=True)  # never fails
        await repo.customers.put(LINKED_CUSTOMER)
        await record(
            event=UsageEventInput(
                customer_id="cust_1",
                meter="api_call",
                quantity=5,
                occurred_at=clock.now(),
                idempotency_key="evt_1",
            ),
            sub=sub,
            policy=DEFAULT_POLICY,
            repo=repo,
            clock=clock,
            ids=ids,
            provider=provider,
        )
        result = await flush_outbox(
            repo=repo, providers={"stripe": provider}, clock=clock
        )
        assert result.sent == 1
        assert result.failed == 0
        assert result.retried == 0
        items = await repo.outbox.list(kind="usage.report")
        item = items[0]
        assert item.status == "sent"
        assert item.attempts == 1
        # report_usage must be called with the PROVIDER-side customer_ref, never the internal customer_id
        assert provider.report_usage_calls == [
            {"customer_ref": "cus_stripe_1", "meter": "api_call", "quantity": 5}
        ]

    asyncio.run(run())


def test_future_next_attempt_is_skipped():
    async def run():
        ids, clock, repo = harness()
        sub = mk_sub()
        provider = FakeProvider(meters=True, always_fail=True)
        await repo.customers.put(LINKED_CUSTOMER)
        await record(
            event=UsageEventInput(
                customer_id="cust_1",
                meter="api_call",
                quantity=1,
                occurred_at=clock.now(),
                idempotency_key="evt_1",
            ),
            sub=sub,
            policy=DEFAULT_POLICY,
            repo=repo,
            clock=clock,
            ids=ids,
            provider=provider,
        )
        await flush_outbox(
            repo=repo, providers={"stripe": provider}, clock=clock
        )  # 1st attempt fails, backoff = 2min
        items = await repo.outbox.list(kind="usage.report")
        assert items[0].attempts == 1

        second = await flush_outbox(
            repo=repo, providers={"stripe": provider}, clock=clock
        )  # clock unchanged -- within backoff
        assert second.sent == 0
        assert second.failed == 0
        assert second.retried == 0
        items2 = await repo.outbox.list(kind="usage.report")
        assert items2[0].attempts == 1  # unchanged -- skipped entirely

    asyncio.run(run())


def test_exponential_backoff_capped_at_60_minutes():
    async def run():
        ids, clock, repo = harness()
        sub = mk_sub()
        provider = FakeProvider(meters=True, always_fail=True)
        await repo.customers.put(LINKED_CUSTOMER)
        await record(
            event=UsageEventInput(
                customer_id="cust_1",
                meter="api_call",
                quantity=1,
                occurred_at=clock.now(),
                idempotency_key="evt_1",
            ),
            sub=sub,
            policy=DEFAULT_POLICY,
            repo=repo,
            clock=clock,
            ids=ids,
            provider=provider,
        )
        expected_backoff_minutes = [2, 4, 8, 16, 32, 60, 60]
        for i, expected_min in enumerate(expected_backoff_minutes):
            before = clock.now()
            res = await flush_outbox(
                repo=repo, providers={"stripe": provider}, clock=clock, max_attempts=10
            )
            assert res.sent == 0
            assert res.failed == 0
            assert res.retried == 1
            items = await repo.outbox.list(kind="usage.report")
            item = items[0]
            assert item.attempts == i + 1
            assert item.status == "pending"
            delta_min = (item.next_attempt_at - before).total_seconds() / 60
            assert delta_min == expected_min
            clock.advance(
                int((item.next_attempt_at - clock.now()).total_seconds() * 1000)
            )
        assert len(provider.report_usage_calls) == len(expected_backoff_minutes)

    asyncio.run(run())


def test_max_attempts_exhaustion_gives_up():
    async def run():
        ids, clock, repo = harness()
        sub = mk_sub()
        provider = FakeProvider(meters=True, always_fail=True)
        await repo.customers.put(LINKED_CUSTOMER)
        await record(
            event=UsageEventInput(
                customer_id="cust_1",
                meter="api_call",
                quantity=1,
                occurred_at=clock.now(),
                idempotency_key="evt_1",
            ),
            sub=sub,
            policy=DEFAULT_POLICY,
            repo=repo,
            clock=clock,
            ids=ids,
            provider=provider,
        )
        max_attempts = 3
        for _ in range(2):
            res = await flush_outbox(
                repo=repo,
                providers={"stripe": provider},
                clock=clock,
                max_attempts=max_attempts,
            )
            assert res.sent == 0
            assert res.failed == 0
            assert res.retried == 1
            items = await repo.outbox.list(kind="usage.report")
            item = items[0]
            assert item.status == "pending"
            clock.advance(
                int((item.next_attempt_at - clock.now()).total_seconds() * 1000)
            )

        final_res = await flush_outbox(
            repo=repo,
            providers={"stripe": provider},
            clock=clock,
            max_attempts=max_attempts,
        )
        assert final_res.sent == 0
        assert final_res.failed == 1
        assert final_res.retried == 0
        items = await repo.outbox.list(kind="usage.report")
        final_item = items[0]
        assert final_item.status == "failed"
        assert final_item.attempts == 3

        clock.advance(24 * 60 * 60 * 1000)
        after_give_up = await flush_outbox(
            repo=repo,
            providers={"stripe": provider},
            clock=clock,
            max_attempts=max_attempts,
        )
        assert after_give_up.sent == 0
        assert after_give_up.failed == 0
        assert after_give_up.retried == 0
        assert len(provider.report_usage_calls) == 3  # no 4th call

    asyncio.run(run())
