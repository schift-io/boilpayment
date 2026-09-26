"""Round-5 audit regressions (bp-audit5.md): EC:A47 A49 A39 A50 A38 A48. Mirrors test/round5.test.ts."""

from __future__ import annotations

import asyncio
import dataclasses
from datetime import UTC, datetime, timedelta

from boilpayment_core import (
    CollectingNotifier,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    Money,
    OutboxItem,
    Payment,
    Period,
    Plan,
    PlanPrice,
    SequentialIdGen,
    Subscription,
    resolve_policy,
)
from boilpayment_lifecycle import dunning, scheduler
from boilpayment_lifecycle.charge_attempt import ATTEMPT_LEASE, with_attempt_lease
from helpers import FakeSelfSchedulingProvider


def d(s: str) -> datetime:
    return datetime.fromisoformat(s).astimezone(UTC)


BASIC = Plan(
    id="basic",
    name="Basic",
    interval="month",
    credits_per_period=100,
    usage_included=0,
    trial_days=0,
    prices=[PlanPrice(currency="KRW", amount_minor=5000, provider_price_refs={})],
)


def mk_sub(start: str, end: str, status: str = "active") -> Subscription:
    return Subscription(
        id="sub_1",
        customer_id="c1",
        plan_id="basic",
        provider="toss",
        provider_ref=None,
        status=status,  # type: ignore[arg-type]
        current_period=Period(start=d(start), end=d(end)),
        anchor_day=1,
        cancel_at_period_end=False,
        grace_until=d("2024-02-08T01:00:00Z") if status == "past_due" else None,
        billing_key="bk",
        scheduled_plan_id=None,
        version=0,
        currency="KRW",
        created_at=d(start),
    )


def retry_item(attempt: int, status: str, created: str, due: str) -> OutboxItem:
    return OutboxItem(
        id=f"dunning-retry-item:sub_1:{attempt}",
        kind="dunning.retry",
        payload={"subscriptionId": "sub_1", "attempt": attempt, "dueAt": due},
        status=status,  # type: ignore[arg-type]
        attempts=1 if status == "sent" else 0,
        next_attempt_at=d(due),
        created_at=d(created),
    )


class T:
    def __init__(self, sub: Subscription, missed: str = "skip_and_notify") -> None:
        self._sub = sub
        self.repo = InMemoryRepo()
        self.ledger = InMemoryLedger(SequentialIdGen("l_"))
        self.notifier = CollectingNotifier()
        self.provider = FakeSelfSchedulingProvider()
        self.provider.lookups = []
        self.policy = resolve_policy({"subscription": {"missed_periods": missed}} if missed != "skip_and_notify" else None)

    async def init(self) -> T:
        await self.repo.plans.put(BASIC)
        await self.repo.subscriptions.put(self._sub)
        return self

    def clk(self, at: str) -> FixedClock:
        self.provider.now = d(at)
        return FixedClock(d(at))

    async def tick(self, at: str):  # type: ignore[no-untyped-def]
        return await scheduler.tick(
            scheduler.SchedulerTickInput(
                provider=self.provider,
                repo=self.repo,
                ledger=self.ledger,
                policy=self.policy,
                clock=self.clk(at),
                ids=SequentialIdGen("i_"),
                notifier=self.notifier,
            )
        )

    async def retries(self, at: str) -> list[str]:
        out = []
        for item in await dunning.retry_due(
            dunning.RetryDueInput(repo=self.repo, clock=self.clk(at))
        ):
            r = await dunning.run_retry(
                dunning.RunRetryInput(
                    item=item,
                    provider=self.provider,
                    repo=self.repo,
                    ledger=self.ledger,
                    policy=self.policy,
                    notifier=self.notifier,
                    clock=self.clk(at),
                )
            )
            out.append(r.outcome)
        return out

    async def cur(self) -> Subscription:
        s = await self.repo.subscriptions.get("sub_1")
        assert s is not None
        return s

    async def usable(self, at: str) -> int:
        return (await self.ledger.balance("c1", None, d(at))).available

    def notices(self, kind: str) -> list:  # type: ignore[type-arg]
        return [
            n
            for n in self.notifier.sent
            if isinstance(n.payload, dict) and n.payload.get("kind") == kind
        ]

    def moved(self, period: str) -> int:
        return len([k for k in self.provider.money_moved if period in k])


def run(coro) -> None:  # type: ignore[no-untyped-def]
    asyncio.run(coro)


def test_a47_backlog_charged_once_for_current_period() -> None:
    async def body() -> None:
        t = await T(mk_sub("2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z")).init()
        for at in [
            "2026-05-15T09:00:00Z",
            "2026-05-15T09:10:00Z",
            "2026-05-15T09:20:00Z",
            "2026-05-15T09:30:00Z",
            "2026-05-15T09:40:00Z",
        ]:
            await t.tick(at)
        assert len(t.provider.money_moved) == 1
        assert t.moved("2026-05-01") == 1
        assert (await t.cur()).current_period.start == d("2026-05-01T00:00:00Z")
        assert await t.usable("2026-05-15T10:00:00Z") == 100
        cases = t.notices("missed_periods_skipped")
        assert len(cases) == 1
        assert cases[0].payload["skipped"] == [
            "2026-02-01T00:00:00.000Z",
            "2026-03-01T00:00:00.000Z",
            "2026-04-01T00:00:00.000Z",
        ]

    run(body())


def test_a47_needs_human_only_parks() -> None:
    async def body() -> None:
        t = await T(
            mk_sub("2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"),
            missed="needs_human_only",
        ).init()
        for at in [
            "2026-05-15T09:00:00Z",
            "2026-05-15T09:10:00Z",
            "2026-05-20T09:00:00Z",
        ]:
            await t.tick(at)
        assert t.provider.order_ids == []
        sub = await t.cur()
        assert sub.status == "past_due" and sub.grace_until is None
        assert len(t.notices("missed_periods_parked")) == 1

    run(body())


def test_a47_one_period_behind_is_ordinary() -> None:
    async def body() -> None:
        t = await T(mk_sub("2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z")).init()
        await t.tick("2026-02-10T09:00:00Z")
        assert t.moved("2026-02-01") == 1
        assert t.notices("missed_periods_skipped") == []

    run(body())


def test_a49_lost_answer_after_16_days_settled_by_lookup() -> None:
    async def body() -> None:
        t = await T(mk_sub("2024-01-01T00:00:00Z", "2024-02-01T00:00:00Z")).init()
        t.provider.lose_next_answer = True
        await t.tick("2024-02-01T01:00:00Z")
        await t.tick("2024-02-17T01:00:00Z")
        await t.retries("2024-02-19T01:00:00Z")
        await t.tick("2024-02-20T01:00:00Z")
        assert t.moved("2024-02-01") == 1
        assert len(t.provider.order_ids) == 1
        assert [p.status for p in await t.repo.payments.list()] == ["succeeded"]
        assert await t.usable("2024-02-20T02:00:00Z") == 100

    run(body())


def test_a49_duplicate_order_never_a_decline() -> None:
    async def body() -> None:
        t = await T(mk_sub("2024-01-01T00:00:00Z", "2024-02-01T00:00:00Z")).init()
        t.provider.lose_next_answer = True
        await t.tick("2024-02-01T01:00:00Z")
        t.provider.lookup_throws = True
        await t.tick("2024-02-17T01:00:00Z")
        await t.retries("2024-02-19T01:00:00Z")
        assert t.moved("2024-02-01") == 1
        assert len(t.provider.order_ids) == 1
        assert [p.status for p in await t.repo.payments.list()] == ["pending"]
        t.provider.lookup_throws = False
        await t.tick("2024-02-21T01:00:00Z")
        assert [p.status for p in await t.repo.payments.list()] == ["succeeded"]
        assert t.moved("2024-02-01") == 1

    run(body())


def test_a39_past_due_legacy_charge_not_charged_again() -> None:
    async def body() -> None:
        t = await T(
            mk_sub("2024-01-01T00:00:00Z", "2024-02-01T00:00:00Z", "past_due")
        ).init()
        await t.repo.outbox.put(
            retry_item(1, "sent", "2024-02-01T01:30:00Z", "2024-02-02T02:00:00Z")
        )
        await t.repo.outbox.put(
            retry_item(2, "pending", "2024-02-02T02:00:00Z", "2024-02-05T05:00:00Z")
        )
        t.provider.seed_order("dunning-retry:sub_1:1", "succeeded")
        assert await t.retries("2024-02-05T05:00:00Z") == ["recovered"]
        assert t.provider.order_ids == []
        assert (await t.cur()).status == "active"
        assert await t.usable("2024-02-05T06:00:00Z") == 100
        await t.tick("2024-03-01T01:00:00Z")
        assert len(t.provider.money_moved) == 2

    run(body())


def test_a39_expired_legacy_charge_gets_row_period_notice() -> None:
    async def body() -> None:
        t = await T(
            mk_sub("2023-12-01T00:00:00Z", "2024-01-01T00:00:00Z", "expired")
        ).init()
        await t.repo.outbox.put(
            retry_item(1, "sent", "2024-01-01T01:00:00Z", "2024-01-02T01:00:00Z")
        )
        t.provider.seed_order("dunning-retry:sub_1:1", "succeeded")
        await t.tick("2024-02-06T01:00:00Z")
        await t.tick("2024-02-07T01:00:00Z")
        rows = await t.repo.payments.list()
        assert [p.status for p in rows] == ["succeeded"]
        assert rows[0].period is not None and rows[0].period.start == d(
            "2024-01-01T00:00:00Z"
        )
        assert len(t.notices("renewal_settled_after_end")) == 1
        assert (await t.cur()).status == "expired"
        assert t.provider.order_ids == []

    run(body())


def test_a50_lookup_mismatch_goes_to_a_person() -> None:
    async def body() -> None:
        for bad in [
            {"amount": Money(amount_minor=4000, currency="KRW")},
            {"amount": Money(amount_minor=5000, currency="USD")},
            {"customer_id": "someone_else"},
            {"status": "partially_refunded"},
        ]:
            t = await T(mk_sub("2024-01-01T00:00:00Z", "2024-02-01T00:00:00Z")).init()
            await t.repo.outbox.put(
                retry_item(1, "sent", "2024-02-01T01:00:00Z", "2024-02-02T01:00:00Z")
            )
            t.provider.seed_order("dunning-retry:sub_1:1", "succeeded")
            t.provider.lookup_override = lambda _id, found, bad=bad: (
                dataclasses.replace(found, **bad) if found is not None else None
            )
            r = await t.tick("2024-02-02T03:00:00Z")
            await t.tick("2024-02-03T03:00:00Z")
            assert t.provider.order_ids == []
            assert await t.usable("2024-02-03T04:00:00Z") == 0
            assert len(t.notices("attempt_lookup_mismatch")) == 1
            assert r.errors

    run(body())


def test_a38_pending_row_of_a_passed_period_is_settled() -> None:
    async def body() -> None:
        t = await T(mk_sub("2024-02-01T00:00:00Z", "2024-03-01T00:00:00Z")).init()
        t.provider.seed_order("ord_left_pending", "succeeded")
        await t.repo.payments.put(
            Payment(
                id="pay_rn_left",
                customer_id="c1",
                provider="toss",
                provider_ref="ord_left_pending",
                subscription_id="sub_1",
                amount=Money(amount_minor=5000, currency="KRW"),
                status="pending",
                kind="subscription",
                period=Period(
                    start=d("2024-02-01T00:00:00Z"), end=d("2024-03-01T00:00:00Z")
                ),
                occurred_at=d("2024-02-01T01:00:00Z"),
                failure=None,
                cash_receipt=None,
                raw={
                    "boilpaymentAttemptKey": "charge:sub_1:2024-02-01T00:00:00.000Z",
                    "boilpaymentLegacyOrderId": "ord_left_pending",
                },
            )
        )
        await t.tick("2024-02-10T01:00:00Z")
        row = await t.repo.payments.get("pay_rn_left")
        assert row is not None and row.status == "succeeded"
        assert t.provider.order_ids == []

    run(body())


def test_a48_stale_lease_taken_over_once_and_never_released_by_old_holder() -> None:
    async def body() -> None:
        repo = InMemoryRepo()
        t0 = d("2024-02-01T00:00:00Z")
        clock = FixedClock(t0)
        later = FixedClock(t0 + ATTEMPT_LEASE + timedelta(minutes=1))
        state = {"inside": 0, "max": 0}

        async def body_fn() -> None:
            state["inside"] += 1
            state["max"] = max(state["max"], state["inside"])
            await asyncio.sleep(0.005)
            state["inside"] -= 1

        release_a = asyncio.Event()

        async def hang() -> None:
            state["inside"] += 1
            state["max"] = max(state["max"], state["inside"])
            await release_a.wait()
            state["inside"] -= 1

        a_task = asyncio.create_task(with_attempt_lease(repo, clock, "k", hang))
        await asyncio.sleep(0.001)
        (b_held, _), (c_held, _) = await asyncio.gather(
            with_attempt_lease(repo, later, "k", body_fn),
            with_attempt_lease(repo, later, "k", body_fn),
        )
        assert [b_held, c_held].count(True) == 1

        async def slow() -> None:
            await asyncio.sleep(0.02)

        d_task = asyncio.create_task(with_attempt_lease(repo, later, "k", slow))
        await asyncio.sleep(0.001)
        release_a.set()
        await a_task
        e_held, _ = await with_attempt_lease(repo, later, "k", body_fn)
        assert e_held is False
        await d_task
        assert state["max"] <= 2

    run(body())
