"""[EC:A28] Postgres stores the subscription currency (migration 0012); absent reads back as None."""
from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from boilpayment_core import Customer, Period, Plan, PlanPrice, Subscription
from boilpayment_schema_postgres import PostgresRepo
from db_helper import create_test_db, drop_test_db


def test_ec_a28_currency_round_trip() -> None:
    async def run():
        db = await create_test_db("py_subcurrency")
        try:
            repo = PostgresRepo(db.dsn)
            await repo.plans.put(Plan(id="p", name="P", interval="month", credits_per_period=0, usage_included=0, trial_days=0,
                                      prices=[PlanPrice(currency="KRW", amount_minor=13000)]))
            await repo.customers.put(Customer(id="c", email=None, provider_refs=[], status="active", created_at=datetime.now(UTC)))
            base = {"customer_id": "c", "plan_id": "p", "provider": "toss", "provider_ref": None, "status": "active",
                    "current_period": Period(start=datetime(2026, 1, 1, tzinfo=UTC), end=datetime(2026, 2, 1, tzinfo=UTC)),
                    "anchor_day": 1, "cancel_at_period_end": False, "grace_until": None, "scheduled_plan_id": None,
                    "created_at": datetime(2026, 1, 1, tzinfo=UTC)}
            await repo.subscriptions.put(Subscription(id="s1", billing_key="bk1", currency="KRW", **base))
            await repo.subscriptions.put(Subscription(id="s2", billing_key="bk2", **base))
            return (await repo.subscriptions.get("s1")).currency, (await repo.subscriptions.get("s2")).currency
        finally:
            await drop_test_db(db)

    assert asyncio.run(run()) == ("KRW", None)
