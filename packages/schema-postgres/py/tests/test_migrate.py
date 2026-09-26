"""[EC:schema-postgres Migrations] migrate() applies all 7 files, records paykit_migrations rows,
idempotent rerun. pytest-asyncio is not installed -> wrap async bodies with asyncio.run().
"""

from __future__ import annotations

import asyncio

import psycopg
from boilpayment_schema_postgres import load_migrations, migrate
from db_helper import create_test_db, drop_test_db
from psycopg.rows import dict_row

EXPECTED_TABLES = [
    "customers",
    "plans",
    "plan_prices",
    "subscriptions",
    "payments",
    "policy_snapshots",
    "operations",
    "ledger_entries",
    "credit_balances",
    "usage_events",
    "usage_periods",
    "usage_outbox",
    "webhook_events",
    "outbox",
    "refunds",
    "refund_attempts",
    "cs_cases",
    "cs_events",
    "churn_reasons",
    "notifications",
    "paykit_migrations",
]


def test_migrate_applies_all_files_and_is_idempotent():
    async def run():
        db = await create_test_db("py_migrate")
        try:
            conn = await psycopg.AsyncConnection.connect(
                db.dsn, autocommit=True, row_factory=dict_row
            )
            try:
                async with conn.cursor() as cur:
                    await cur.execute(
                        "select name from paykit_migrations order by name"
                    )
                    rows = await cur.fetchall()
                names = [r["name"] for r in rows]
                assert names == [file.name for file in load_migrations()]

                async with conn.cursor() as cur:
                    await cur.execute(
                        "select tablename from pg_tables where schemaname = 'public'"
                    )
                    rows = await cur.fetchall()
                tables = {r["tablename"] for r in rows}
                for t in EXPECTED_TABLES:
                    assert t in tables, f"expected table {t} to exist"

                # idempotent rerun
                result = await migrate(
                    conninfo=db.dsn,
                    modules=["core", "credits", "usage", "webhook", "refund", "cs"],
                )
                assert result["applied"] == []
                async with conn.cursor() as cur:
                    await cur.execute("select count(*) as n from paykit_migrations")
                    row = await cur.fetchone()
                assert row["n"] == 7
            finally:
                await conn.close()
        finally:
            await drop_test_db(db)

    asyncio.run(run())
