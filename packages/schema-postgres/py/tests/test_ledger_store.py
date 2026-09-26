"""[EC:B12 B14 B3 B4 B15 H3 H4] PostgresLedgerStore + consistency_check regression coverage.

pytest-asyncio is not installed -> every test wraps its async body with asyncio.run().
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime, timedelta

import psycopg
from db_helper import create_test_db, drop_test_db
from schift_payment_kit_core import Customer, LedgerReference, NewLedgerEntry
from schift_payment_kit_schema_postgres import (
    PostgresLedgerStore,
    PostgresRepo,
    consistency_check,
)


async def _make_customer(repo: PostgresRepo) -> str:
    customer_id = f"cust_{uuid.uuid4()}"
    await repo.customers.put(
        Customer(
            id=customer_id,
            email=None,
            provider_refs=[],
            status="active",
            created_at=datetime.now(UTC),
        )
    )
    return customer_id


def test_append_duplicate_idempotency_key_returns_existing_row():
    async def run():
        db = await create_test_db("py_ledger_append")
        try:
            ledger = PostgresLedgerStore(db.dsn)
            repo = PostgresRepo(db.dsn)
            customer_id = await _make_customer(repo)
            key = f"grant:{uuid.uuid4()}"
            first = await ledger.append(
                NewLedgerEntry(
                    customer_id=customer_id,
                    pool="paid",
                    kind="grant",
                    amount=100,
                    unit_price_minor=10,
                    currency="USD",
                    expires_at=None,
                    source="subscription",
                    reference=LedgerReference(),
                    idempotency_key=key,
                    actor="system",
                )
            )
            second = await ledger.append(
                NewLedgerEntry(
                    customer_id=customer_id,
                    pool="paid",
                    kind="grant",
                    amount=999,
                    unit_price_minor=999,
                    currency="USD",
                    expires_at=None,
                    source="subscription",
                    reference=LedgerReference(),
                    idempotency_key=key,
                    actor="system",
                )
            )
            assert first.duplicated is False
            assert second.duplicated is True
            assert second.entry.id == first.entry.id
            assert (
                second.entry.amount == 100
            )  # not 999 -- proves no second row was written

            conn = await psycopg.AsyncConnection.connect(db.dsn, autocommit=True)
            try:
                async with conn.cursor() as cur:
                    await cur.execute(
                        "select count(*) from ledger_entries where idempotency_key = %s",
                        (key,),
                    )
                    (count,) = await cur.fetchone()
                assert count == 1
            finally:
                await conn.close()
        finally:
            await drop_test_db(db)

    asyncio.run(run())


def test_consume_duplicate_idempotency_key_returns_existing_rows():
    async def run():
        db = await create_test_db("py_ledger_consume_dup")
        try:
            ledger = PostgresLedgerStore(db.dsn)
            repo = PostgresRepo(db.dsn)
            customer_id = await _make_customer(repo)
            await ledger.append(
                NewLedgerEntry(
                    customer_id=customer_id,
                    pool="paid",
                    kind="grant",
                    amount=100,
                    unit_price_minor=1,
                    currency="USD",
                    expires_at=None,
                    source="subscription",
                    reference=LedgerReference(),
                    idempotency_key=f"grant:{uuid.uuid4()}",
                    actor="system",
                )
            )
            key = f"consume:{uuid.uuid4()}"
            now = datetime.now(UTC)

            from schift_payment_kit_core import ConsumeInput

            first = await ledger.consume(
                ConsumeInput(
                    customer_id=customer_id,
                    pool_order=["paid"],
                    amount=30,
                    idempotency_key=key,
                    meta=LedgerReference(),
                    now=now,
                    negative_balance="block",
                    negative_floor=0,
                )
            )
            second = await ledger.consume(
                ConsumeInput(
                    customer_id=customer_id,
                    pool_order=["paid"],
                    amount=30,
                    idempotency_key=key,
                    meta=LedgerReference(),
                    now=now,
                    negative_balance="block",
                    negative_floor=0,
                )
            )
            assert first.duplicated is False
            assert second.duplicated is True
            assert [e.id for e in second.entries] == [e.id for e in first.entries]
        finally:
            await drop_test_db(db)

    asyncio.run(run())


def test_consume_fifo_by_expiry_skips_already_expired_grants():
    async def run():
        db = await create_test_db("py_ledger_fifo")
        try:
            from schift_payment_kit_core import ConsumeInput

            ledger = PostgresLedgerStore(db.dsn)
            repo = PostgresRepo(db.dsn)
            customer_id = await _make_customer(repo)
            now = datetime.now(UTC)
            past = now - timedelta(minutes=1)
            soon = now + timedelta(minutes=1)
            later = now + timedelta(hours=1)

            await ledger.append(
                NewLedgerEntry(
                    customer_id=customer_id,
                    pool="paid",
                    kind="grant",
                    amount=40,
                    unit_price_minor=1,
                    currency="USD",
                    expires_at=past,
                    source="subscription",
                    reference=LedgerReference(),
                    idempotency_key=f"g_expired_{uuid.uuid4()}",
                    actor="system",
                )
            )
            g_soon = await ledger.append(
                NewLedgerEntry(
                    customer_id=customer_id,
                    pool="paid",
                    kind="grant",
                    amount=20,
                    unit_price_minor=1,
                    currency="USD",
                    expires_at=soon,
                    source="subscription",
                    reference=LedgerReference(),
                    idempotency_key=f"g_soon_{uuid.uuid4()}",
                    actor="system",
                )
            )
            g_later = await ledger.append(
                NewLedgerEntry(
                    customer_id=customer_id,
                    pool="paid",
                    kind="grant",
                    amount=20,
                    unit_price_minor=1,
                    currency="USD",
                    expires_at=later,
                    source="subscription",
                    reference=LedgerReference(),
                    idempotency_key=f"g_later_{uuid.uuid4()}",
                    actor="system",
                )
            )

            result = await ledger.consume(
                ConsumeInput(
                    customer_id=customer_id,
                    pool_order=["paid"],
                    amount=25,
                    idempotency_key=f"consume_{uuid.uuid4()}",
                    meta=LedgerReference(),
                    now=now,
                    negative_balance="block",
                    negative_floor=0,
                )
            )
            assert result.ok is True
            assert result.shortfall == 0
            assert len(result.entries) == 2
            assert result.entries[0].reference.grant_id == g_soon.entry.id
            assert result.entries[0].amount == -20
            assert result.entries[1].reference.grant_id == g_later.entry.id
            assert result.entries[1].amount == -5
        finally:
            await drop_test_db(db)

    asyncio.run(run())


def test_negative_balance_block_rejects_atomically():
    async def run():
        db = await create_test_db("py_ledger_block")
        try:
            from schift_payment_kit_core import ConsumeInput

            ledger = PostgresLedgerStore(db.dsn)
            repo = PostgresRepo(db.dsn)
            customer_id = await _make_customer(repo)
            await ledger.append(
                NewLedgerEntry(
                    customer_id=customer_id,
                    pool="paid",
                    kind="grant",
                    amount=10,
                    unit_price_minor=1,
                    currency="USD",
                    expires_at=None,
                    source="subscription",
                    reference=LedgerReference(),
                    idempotency_key=f"g_{uuid.uuid4()}",
                    actor="system",
                )
            )
            before = await ledger.balance(customer_id, None, datetime.now(UTC))
            result = await ledger.consume(
                ConsumeInput(
                    customer_id=customer_id,
                    pool_order=["paid"],
                    amount=999,
                    idempotency_key=f"consume_{uuid.uuid4()}",
                    meta=LedgerReference(),
                    now=datetime.now(UTC),
                    negative_balance="block",
                    negative_floor=0,
                )
            )
            assert result.ok is False
            assert result.entries == []
            assert result.shortfall == 989
            after = await ledger.balance(customer_id, None, datetime.now(UTC))
            assert after.available == before.available
        finally:
            await drop_test_db(db)

    asyncio.run(run())


def test_h3_direct_update_rejected():
    async def run():
        db = await create_test_db("py_ledger_h3_update")
        try:
            ledger = PostgresLedgerStore(db.dsn)
            repo = PostgresRepo(db.dsn)
            customer_id = await _make_customer(repo)
            result = await ledger.append(
                NewLedgerEntry(
                    customer_id=customer_id,
                    pool="paid",
                    kind="grant",
                    amount=10,
                    unit_price_minor=1,
                    currency="USD",
                    expires_at=None,
                    source="subscription",
                    reference=LedgerReference(),
                    idempotency_key=f"g_{uuid.uuid4()}",
                    actor="system",
                )
            )
            conn = await psycopg.AsyncConnection.connect(db.dsn, autocommit=True)
            try:
                raised = False
                try:
                    async with conn.cursor() as cur:
                        await cur.execute(
                            "update ledger_entries set amount = 999999 where id = %s",
                            (result.entry.id,),
                        )
                except psycopg.errors.IntegrityConstraintViolation as e:
                    raised = True
                    assert "append-only" in str(e)
                assert raised, "expected UPDATE to be rejected"
            finally:
                await conn.close()
        finally:
            await drop_test_db(db)

    asyncio.run(run())


def test_h3_direct_delete_rejected():
    async def run():
        db = await create_test_db("py_ledger_h3_delete")
        try:
            ledger = PostgresLedgerStore(db.dsn)
            repo = PostgresRepo(db.dsn)
            customer_id = await _make_customer(repo)
            result = await ledger.append(
                NewLedgerEntry(
                    customer_id=customer_id,
                    pool="paid",
                    kind="grant",
                    amount=10,
                    unit_price_minor=1,
                    currency="USD",
                    expires_at=None,
                    source="subscription",
                    reference=LedgerReference(),
                    idempotency_key=f"g_{uuid.uuid4()}",
                    actor="system",
                )
            )
            conn = await psycopg.AsyncConnection.connect(db.dsn, autocommit=True)
            try:
                raised = False
                try:
                    async with conn.cursor() as cur:
                        await cur.execute(
                            "delete from ledger_entries where id = %s",
                            (result.entry.id,),
                        )
                except psycopg.errors.IntegrityConstraintViolation as e:
                    raised = True
                    assert "append-only" in str(e)
                assert raised, "expected DELETE to be rejected"
            finally:
                await conn.close()
        finally:
            await drop_test_db(db)

    asyncio.run(run())


def test_credit_balances_fully_drained_expiring_lot_resets_to_empty():
    async def run():
        db = await create_test_db("py_ledger_drain")
        try:
            from schift_payment_kit_core import ConsumeInput

            ledger = PostgresLedgerStore(db.dsn)
            repo = PostgresRepo(db.dsn)
            customer_id = await _make_customer(repo)
            soon = datetime.now(UTC) + timedelta(minutes=1)
            await ledger.append(
                NewLedgerEntry(
                    customer_id=customer_id,
                    pool="paid",
                    kind="grant",
                    amount=10,
                    unit_price_minor=1,
                    currency="USD",
                    expires_at=soon,
                    source="subscription",
                    reference=LedgerReference(),
                    idempotency_key=f"g_{uuid.uuid4()}",
                    actor="system",
                )
            )
            mid = await ledger.balance(customer_id, "paid", datetime.now(UTC))
            assert len(mid.expiring) == 1
            assert mid.expiring[0].amount == 10

            await ledger.consume(
                ConsumeInput(
                    customer_id=customer_id,
                    pool_order=["paid"],
                    amount=10,
                    idempotency_key=f"consume_{uuid.uuid4()}",
                    meta=LedgerReference(),
                    now=datetime.now(UTC),
                    negative_balance="block",
                    negative_floor=0,
                )
            )
            final = await ledger.balance(customer_id, "paid", datetime.now(UTC))
            assert final.available == 0
            assert (
                final.expiring == []
            )  # regression: must not keep the stale pre-drain bucket
        finally:
            await drop_test_db(db)

    asyncio.run(run())


def test_consistency_check_zero_mismatches_after_activity():
    async def run():
        db = await create_test_db("py_ledger_consistency")
        try:
            from schift_payment_kit_core import ConsumeInput

            ledger = PostgresLedgerStore(db.dsn)
            repo = PostgresRepo(db.dsn)
            customer_id = await _make_customer(repo)
            past = datetime.now(UTC) - timedelta(minutes=1)
            await ledger.append(
                NewLedgerEntry(
                    customer_id=customer_id,
                    pool="paid",
                    kind="grant",
                    amount=50,
                    unit_price_minor=1,
                    currency="USD",
                    expires_at=None,
                    source="subscription",
                    reference=LedgerReference(),
                    idempotency_key=f"g1_{uuid.uuid4()}",
                    actor="system",
                )
            )
            await ledger.append(
                NewLedgerEntry(
                    customer_id=customer_id,
                    pool="promo",
                    kind="grant",
                    amount=20,
                    unit_price_minor=0,
                    currency="USD",
                    expires_at=past,
                    source="promo",
                    reference=LedgerReference(),
                    idempotency_key=f"g2_{uuid.uuid4()}",
                    actor="system",
                )
            )
            await ledger.consume(
                ConsumeInput(
                    customer_id=customer_id,
                    pool_order=["paid"],
                    amount=15,
                    idempotency_key=f"consume_{uuid.uuid4()}",
                    meta=LedgerReference(),
                    now=datetime.now(UTC),
                    negative_balance="block",
                    negative_floor=0,
                )
            )
            mismatches = await consistency_check(db.dsn)
            mine = [m for m in mismatches if m.customer_id == customer_id]
            assert mine == []
        finally:
            await drop_test_db(db)

    asyncio.run(run())
