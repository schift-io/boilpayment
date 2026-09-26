"""Forward schema upgrade preserves genuine self-scheduled subscriptions."""
from __future__ import annotations

import asyncio
from datetime import UTC, datetime

import pytest
from boilpayment_core import Customer, Period, Plan, Subscription
from boilpayment_schema_postgres import (
    PostgresRepo,
    connection,
    load_migrations,
    migrate,
    verify_schema,
)
from db_helper import create_test_db, drop_test_db

FOLLOWUP = "0007_subscription_provider_ref_nullable.sql"


def test_core_always_selects_provider_ref_followup():
    assert [file.name for file in load_migrations(["core"])] == [
        "0001_core.sql",
        FOLLOWUP,
        "0011_subscription_status_paused_incomplete.sql",
    ]
    assert FOLLOWUP in [file.name for file in load_migrations(["credits"])]


def test_upgrade_and_self_subscription_null_roundtrip():
    async def scenario():
        db = await create_test_db("py_nullable_provider_ref")
        try:
            async with connection(db.dsn) as conn, conn.cursor() as cur:
                await cur.execute("alter table subscriptions alter column provider_ref set not null")
                await cur.execute("delete from paykit_migrations where name=%s", (FOLLOWUP,))
            with pytest.raises(RuntimeError, match=FOLLOWUP):
                await verify_schema(conninfo=db.dsn)
            assert (await migrate(conninfo=db.dsn))["applied"] == [FOLLOWUP]
            assert (await verify_schema(conninfo=db.dsn)).ok
            assert (await migrate(conninfo=db.dsn))["applied"] == []
            repo = PostgresRepo(db.dsn)
            start = datetime(2026, 1, 1, tzinfo=UTC)
            await repo.customers.put(Customer(id="customer", email=None, provider_refs=[], status="active", created_at=start))
            await repo.plans.put(Plan(id="plan", name="Plan", interval="month", credits_per_period=100, usage_included=0, trial_days=0, prices=[]))
            await repo.subscriptions.put(Subscription(id="self", customer_id="customer", plan_id="plan", provider="toss", provider_ref=None, status="active", current_period=Period(start=start, end=datetime(2026, 2, 1, tzinfo=UTC)), anchor_day=1, cancel_at_period_end=False, grace_until=None, billing_key="billing-key", scheduled_plan_id=None, created_at=start))
            assert (await repo.subscriptions.get("self")).provider_ref is None
            async with connection(db.dsn) as conn, conn.cursor() as cur:
                await cur.execute("select is_nullable from information_schema.columns where table_schema='public' and table_name='payments' and column_name='provider_ref'")
                assert (await cur.fetchone())["is_nullable"] == "NO"
        finally:
            await drop_test_db(db)
    asyncio.run(scenario())
