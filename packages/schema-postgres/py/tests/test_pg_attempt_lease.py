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
