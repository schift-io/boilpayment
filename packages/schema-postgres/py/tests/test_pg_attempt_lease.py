"""[EC:A37] Two workers renewing the same self-scheduled subscriptions on Postgres call the provider once
per (subscription, period) and never leave a succeeded attempt pending. Mirrors the TS sdk round4-pg test
(round-4 audit A4-4, which was reproduced in TS only)."""
from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from boilpayment_core import (
    CollectingNotifier,
    Customer,
    FixedClock,
    Payment,
    Period,
    Plan,
    PlanPrice,
    ProviderCapabilities,
    SequentialIdGen,
    Subscription,
    resolve_policy,
)
from boilpayment_lifecycle import scheduler
from boilpayment_schema_postgres import PostgresLedgerStore, PostgresRepo
from db_helper import create_test_db, drop_test_db


class _FakeToss:
    name = "toss"

    def __init__(self) -> None:
        self.calls = 0
        self.answers: dict[str, Payment] = {}
        self.moved: dict[str, int] = {}

    def capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(native_subscriptions=False, partial_refund=True, meters=False, scheduling="self", webhook_signature=False)

    async def charge_billing_key(self, **kw) -> Payment:
        self.calls += 1
        await asyncio.sleep(0.005)
        key = kw["idempotency_key"]
        if key in self.answers:
            return self.answers[key]
        p = Payment(id="x", customer_id=kw["customer_ref"], provider="toss", provider_ref="pk_" + kw["order_id"], subscription_id=None,
                    amount=kw["amount"], status="succeeded", kind="subscription", period=None, occurred_at=datetime.now(UTC))
        self.answers[key] = p
        self.moved[kw["customer_ref"]] = self.moved.get(kw["customer_ref"], 0) + 1
        return p


def _d(s: str) -> datetime:
    return datetime.fromisoformat(s)


def test_ec_a37_two_workers_one_provider_call_per_attempt() -> None:
    async def run() -> None:
        db = await create_test_db("py_lease")
        try:
            provider = _FakeToss()
            workers = [(PostgresRepo(db.dsn), PostgresLedgerStore(db.dsn)) for _ in range(2)]
            repo = workers[0][0]
            await repo.plans.put(Plan(id="basic", name="Basic", interval="month", credits_per_period=100, usage_included=0, trial_days=0,
                                      prices=[PlanPrice(currency="KRW", amount_minor=5000, provider_price_refs={})]))
            n = 20
            for i in range(n):
                await repo.customers.put(Customer(id=f"c{i}", email=None, provider_refs=[], status="active", created_at=_d("2024-01-01T00:00:00+00:00")))
                await repo.subscriptions.put(Subscription(
                    id=f"sub_{i}", customer_id=f"c{i}", plan_id="basic", provider="toss", provider_ref=None, status="active",
                    current_period=Period(start=_d("2024-01-01T00:00:00+00:00"), end=_d("2024-02-01T00:00:00+00:00")), anchor_day=1,
                    cancel_at_period_end=False, grace_until=None, billing_key="bk", scheduled_plan_id=None, version=0, currency="KRW",
                    created_at=_d("2024-01-01T00:00:00+00:00")))
            policy = resolve_policy()

            async def tick(w: int, at: str):
                r, lg = workers[w]
                return await scheduler.tick(scheduler.SchedulerTickInput(provider=provider, repo=r, ledger=lg, policy=policy,
                                                                        clock=FixedClock(_d(at)), ids=SequentialIdGen(f"w{w}_"), notifier=CollectingNotifier()))

            errors = []
            for at in ["2024-02-01T01:00:00+00:00", "2024-03-01T01:00:00+00:00"]:
                ra, rb = await asyncio.gather(tick(0, at), tick(1, at))
                errors += [e.code for e in ra.errors + rb.errors]
            await tick(0, "2024-03-02T01:00:00+00:00")
            bad = []
            for i in range(n):
                rows = await repo.payments.list(subscription_id=f"sub_{i}")
                if sorted(r.status for r in rows) != ["succeeded", "succeeded"] or provider.moved.get(f"c{i}") != 2:
                    bad.append((i, [r.status for r in rows], provider.moved.get(f"c{i}")))
            assert bad == []
            assert errors == []
            assert provider.calls == 2 * n
        finally:
            await drop_test_db(db)

    asyncio.run(run())


def test_ec_a48_stale_lease_taken_over_once_old_holder_cannot_release() -> None:
    """Round-5 audit A5-7: compare-and-set takeover and release (mirrors sdk/ts round5-pg.test.ts)."""
    import dataclasses
    from datetime import timedelta

    from boilpayment_core import Operation
    from boilpayment_lifecycle.charge_attempt import ATTEMPT_LEASE, with_attempt_lease

    async def run() -> None:
        db = await create_test_db("py_lease5")
        try:
            t0 = _d("2024-02-01T00:00:00+00:00")
            later = FixedClock(t0 + ATTEMPT_LEASE + timedelta(minutes=1))
            for rnd in range(5):
                key = f"r5-lease-{rnd}"
                ra, rb, rc = (PostgresRepo(db.dsn) for _ in range(3))
                claimed = await ra.operations.claim(Operation(
                    id=f"charge-lease:{key}", key=f"charge-lease:{key}", kind="lifecycle.charge_attempt", payload_hash="charge-attempt-lease",
                    status="in_progress", created_at=t0, result=None, error=None, completed_at=None, attempts=0))
                assert claimed is not None
                a_held = dataclasses.replace(claimed, result={"leaseUntil": (t0 + ATTEMPT_LEASE).isoformat(), "token": "A"})
                assert await ra.operations.compare_and_set(claimed, a_held) is True
                state = {"inside": 0, "max": 0}

                async def body() -> None:
                    state["inside"] += 1
                    state["max"] = max(state["max"], state["inside"])
                    await asyncio.sleep(0.03)
                    state["inside"] -= 1

                (b_held, _), (c_held, _) = await asyncio.gather(with_attempt_lease(rb, later, key, body), with_attempt_lease(rc, later, key, body))
                assert [b_held, c_held].count(True) == 1
                assert state["max"] == 1

                async def slow() -> None:
                    await asyncio.sleep(0.04)

                d_task = asyncio.create_task(with_attempt_lease(rb, later, key, slow))
                await asyncio.sleep(0.01)
                released = dataclasses.replace(a_held, status="failed", result=None, completed_at=later.now())
                assert await ra.operations.compare_and_set(a_held, released) is False
                e_held, _ = await with_attempt_lease(rc, later, key, body)
                assert e_held is False
                d_held, _ = await d_task
                assert d_held is True
        finally:
            await drop_test_db(db)

    asyncio.run(run())
