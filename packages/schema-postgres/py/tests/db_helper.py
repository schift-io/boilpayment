"""Shared test-only helper: creates/drops a throwaway `paykit_test_*` database per test module and
applies the full migration set. Never touches any database outside that naming pattern.
"""

from __future__ import annotations

import os
import subprocess
import uuid
from dataclasses import dataclass

from schift_payment_kit_schema_postgres import migrate
from schift_payment_kit_schema_postgres.tx import close_pools

ALL_MODULES = ["core", "credits", "usage", "webhook", "refund", "cs"]
PG_HOST = "127.0.0.1"


@dataclass
class TestDb:
    db_name: str
    dsn: str


def unique_db_name(label: str) -> str:
    return f"paykit_test_{label}_{os.getpid()}_{uuid.uuid4().hex[:8]}"


async def create_test_db(label: str) -> TestDb:
    db_name = unique_db_name(label)
    subprocess.run(["createdb", "-h", PG_HOST, db_name], check=True)  # noqa: ASYNC221 -- createdb/dropdb once per session
    dsn = f"host={PG_HOST} dbname={db_name}"
    await migrate(conninfo=dsn, modules=ALL_MODULES)
    return TestDb(db_name=db_name, dsn=dsn)


async def drop_test_db(db: TestDb) -> None:
    # PostgresRepo/PostgresLedgerStore check connections out of a process-wide
    # AsyncConnectionPool cached per DSN (tx.py get_pool, min_size=1) that outlives any single
    # test's asyncio.run() call. Without closing it first, `dropdb` fails with
    # "database is being accessed by other users" because that pool still holds an idle
    # connection open to this exact throwaway database.
    await close_pools()
    subprocess.run(["dropdb", "-h", PG_HOST, db.db_name], check=True)  # noqa: ASYNC221 -- createdb/dropdb once per session
