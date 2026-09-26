"""[EC:A27] Postgres accepts the non-entitled subscription statuses (migration 0011)."""
from __future__ import annotations

import asyncio
from datetime import UTC, datetime

import pytest
from boilpayment_core import Customer, Period, Plan, PlanPrice, Subscription
from boilpayment_schema_postgres import PostgresRepo
from db_helper import create_test_db, drop_test_db


@pytest.mark.parametrize("status", ["paused", "incomplete"])
def test_ec_a27_status_round_trip(status: str) -> None:
    async def run():
        db = await create_test_db(f"py_substatus_{status}")
        try:
            repo = PostgresRepo(db.dsn)
            await repo.plans.put(Plan(id="p", name="P", interval="month", credits_per_period=0, usage_included=0, trial_days=0,
                                      prices=[PlanPrice(currency="USD", amount_minor=100)]))
            await repo.customers.put(Customer(id="c", email=None, provider_refs=[], status="active", created_at=datetime.now(UTC)))
            await repo.subscriptions.put(Subscription(id="s", customer_id="c", plan_id="p", provider="stripe", provider_ref="sub_x",
                                                      status=status, current_period=Period(start=datetime(2026, 1, 1, tzinfo=UTC), end=datetime(2026, 2, 1, tzinfo=UTC)),
                                                      anchor_day=1, cancel_at_period_end=False, grace_until=None, billing_key=None,
                                                      scheduled_plan_id=None, created_at=datetime(2026, 1, 1, tzinfo=UTC)))
            return (await repo.subscriptions.get("s")).status
        finally:
            await drop_test_db(db)

    assert asyncio.run(run()) == status
