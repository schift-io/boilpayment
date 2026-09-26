"""[EC:J4 L4] prune_retention() -- real Postgres proof: old operations (done/failed) and old
audit_log rows are deleted; in_progress operations and fresh rows of both survive; dry_run
deletes nothing; batching deletes more rows than a single batch_size.
"""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import replace
from datetime import UTC, datetime, timedelta

from boilpayment_core import DEFAULT_POLICY, Customer, FixedClock, Operation
from boilpayment_schema_postgres import (
    PostgresLogger,
    PostgresRepo,
    connection,
    prune_retention,
)
from db_helper import create_test_db, drop_test_db

CLOCK = FixedClock(datetime(2026, 6, 1, tzinfo=UTC))
POLICY = replace(
    DEFAULT_POLICY,
    retention=replace(DEFAULT_POLICY.retention, operation_days=7, audit_log_days=90),
)


def run(coro):
    return asyncio.run(coro)


def _mk_op(**overrides) -> Operation:
    key = overrides.pop("key", f"op_{uuid.uuid4()}")
    defaults = {
        "id": key,
        "key": key,
        "kind": "lifecycle.upgrade",
        "payload_hash": "hash",
        "status": "done",
        "created_at": CLOCK.now(),
    }
    defaults.update(overrides)
    return Operation(**defaults)


def test_ec_j4_deletes_done_failed_operations_older_than_operation_days_keeps_fresh_and_in_progress():
    async def scenario():
        db = await create_test_db("py_retention_ops")
        try:
            repo = PostgresRepo(db.dsn)
            await repo.customers.put(
                Customer(
                    id="cust_retention",
                    email=None,
                    provider_refs=[],
                    status="active",
                    created_at=CLOCK.now(),
                )
            )

            old = CLOCK.now() - timedelta(days=8)  # past the 7-day window
            fresh = CLOCK.now() - timedelta(days=1)  # within window

            old_done = await repo.operations.put(_mk_op(status="done", created_at=old))
            old_failed = await repo.operations.put(
                _mk_op(status="failed", created_at=old)
            )
            old_in_progress = await repo.operations.put(
                _mk_op(status="in_progress", created_at=old)
            )
            fresh_done = await repo.operations.put(
                _mk_op(status="done", created_at=fresh)
            )

            result = await prune_retention(dsn=db.dsn, policy=POLICY, clock=CLOCK)
            assert result.operations_deleted == 2

            assert await repo.operations.get(old_done.id) is None
            assert await repo.operations.get(old_failed.id) is None
            assert (
                await repo.operations.get(old_in_progress.id) is not None
            )  # EC:J4 -- never pruned regardless of status
            assert await repo.operations.get(fresh_done.id) is not None
        finally:
            await drop_test_db(db)

    run(scenario())


def test_ec_l4_deletes_audit_log_rows_older_than_audit_log_days_keeps_fresh():
    async def scenario():
        db = await create_test_db("py_retention_audit")
        try:
            repo = PostgresRepo(db.dsn)
            await repo.customers.put(
                Customer(
                    id="cust_retention",
                    email=None,
                    provider_refs=[],
                    status="active",
                    created_at=CLOCK.now(),
                )
            )
            logger = PostgresLogger(db.dsn)

            old = CLOCK.now() - timedelta(days=91)  # past the 90-day window
            fresh = CLOCK.now() - timedelta(days=1)

            await logger.log(
                {"level": "info", "event": "test.old_1", "at": old, "customerId": "cust_retention"}
            )
            await logger.log(
                {"level": "info", "event": "test.old_2", "at": old, "customerId": "cust_retention"}
            )
            await logger.log(
                {"level": "info", "event": "test.fresh", "at": fresh, "customerId": "cust_retention"}
            )

            result = await prune_retention(dsn=db.dsn, policy=POLICY, clock=CLOCK)
            assert result.audit_log_deleted >= 2

            async with connection(db.dsn) as conn, conn.cursor() as cur:
                await cur.execute(
                    "select event from audit_log where event like 'test.%' order by event"
                )
                rows = await cur.fetchall()
            assert [r["event"] for r in rows] == ["test.fresh"]
        finally:
            await drop_test_db(db)

    run(scenario())


def test_dry_run_returns_would_be_counts_without_deleting():
    async def scenario():
        db = await create_test_db("py_retention_dryrun")
        try:
            repo = PostgresRepo(db.dsn)
            await repo.customers.put(
                Customer(
                    id="cust_retention",
                    email=None,
                    provider_refs=[],
                    status="active",
                    created_at=CLOCK.now(),
                )
            )
            logger = PostgresLogger(db.dsn)

            old = CLOCK.now() - timedelta(days=8)
            op = await repo.operations.put(_mk_op(status="done", created_at=old))
            await logger.log(
                {
                    "level": "info",
                    "event": "test.dry_run_old",
                    "at": CLOCK.now() - timedelta(days=91),
                    "customerId": "cust_retention",
                }
            )

            result = await prune_retention(
                dsn=db.dsn, policy=POLICY, clock=CLOCK, dry_run=True
            )
            assert result.operations_deleted >= 1
            assert result.audit_log_deleted >= 1

            assert await repo.operations.get(op.id) is not None
            async with connection(db.dsn) as conn, conn.cursor() as cur:
                await cur.execute(
                    "select count(*)::int as n from audit_log where event = 'test.dry_run_old'"
                )
                row = await cur.fetchone()
            assert row["n"] == 1

            real = await prune_retention(dsn=db.dsn, policy=POLICY, clock=CLOCK)
            assert real.operations_deleted >= 1
        finally:
            await drop_test_db(db)

    run(scenario())


def test_batches_deletes_so_a_backlog_larger_than_batch_size_is_fully_removed():
    async def scenario():
        db = await create_test_db("py_retention_batch")
        try:
            repo = PostgresRepo(db.dsn)
            await repo.customers.put(
                Customer(
                    id="cust_retention",
                    email=None,
                    provider_refs=[],
                    status="active",
                    created_at=CLOCK.now(),
                )
            )

            old = CLOCK.now() - timedelta(days=8)
            ops = [
                await repo.operations.put(_mk_op(status="done", created_at=old))
                for _ in range(5)
            ]

            result = await prune_retention(
                dsn=db.dsn, policy=POLICY, clock=CLOCK, batch_size=2
            )
            assert result.operations_deleted >= 5

            for op in ops:
                assert await repo.operations.get(op.id) is None
        finally:
            await drop_test_db(db)

    run(scenario())


def test_entitlement_evidence_survives_operation_ttl():
    async def scenario():
        db = await create_test_db("py_entitlement_retention")
        try:
            repo = PostgresRepo(db.dsn)
            for kind in ["checkout.entitlement", "purchase.entitlement", "refund.provider"]:
                await repo.operations.put(_mk_op(kind=kind, created_at=datetime(2020, 1, 1, tzinfo=UTC)))
            assert (await prune_retention(dsn=db.dsn, policy=POLICY, clock=CLOCK, dry_run=True)).operations_deleted == 0
            assert (await prune_retention(dsn=db.dsn, policy=POLICY, clock=CLOCK)).operations_deleted == 0
            for kind in ["checkout.entitlement", "purchase.entitlement", "refund.provider"]:
                assert len(await repo.operations.list(kind=kind)) == 1
        finally:
            await drop_test_db(db)
    asyncio.run(scenario())
