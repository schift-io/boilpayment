"""[EC:B12 B14 B3 B4 B15 H3 H4] PostgresLedgerStore + consistency_check regression coverage.

pytest-asyncio is not installed -> every test wraps its async body with asyncio.run().
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime, timedelta

import psycopg
from boilpayment_core import Customer, LedgerReference, NewLedgerEntry
from boilpayment_schema_postgres import (
    PostgresLedgerStore,
    PostgresRepo,
    consistency_check,
)
from db_helper import create_test_db, drop_test_db


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

            from boilpayment_core import ConsumeInput

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
            from boilpayment_core import ConsumeInput

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


def test_sb_07_sb_08_balance_and_consume_honor_grace_extension_and_recovery_end():
    async def run():
        from boilpayment_core import ConsumeInput

        db = await create_test_db("py_ledger_sb07")
        try:
            ledger = PostgresLedgerStore(db.dsn)
            repo = PostgresRepo(db.dsn)
            customer_id = await _make_customer(repo)
            now = datetime.now(UTC)
            original_expiry = now + timedelta(minutes=1)
            grace_until = now + timedelta(days=7)
            grant = (
                await ledger.append(
                    NewLedgerEntry(
                        customer_id=customer_id,
                        pool="paid",
                        kind="grant",
                        amount=100,
                        unit_price_minor=10,
                        currency="USD",
                        expires_at=original_expiry,
                        source="subscription",
                        reference=LedgerReference(),
                        idempotency_key=f"grant:{uuid.uuid4()}",
                        actor="system",
                    )
                )
            ).entry
            await ledger.append(
                NewLedgerEntry(
                    customer_id=customer_id,
                    pool="paid",
                    kind="adjust",
                    amount=0,
                    unit_price_minor=None,
                    currency="USD",
                    expires_at=grace_until,
                    source="subscription",
                    reference=LedgerReference(grant_id=grant.id),
                    idempotency_key=f"adjust:{uuid.uuid4()}",
                    actor="system",
                    reason="SB-07 grace_expiry_extension",
                )
            )
            during_grace = original_expiry + timedelta(minutes=1)

            balance = await ledger.balance(customer_id, "paid", during_grace)
            assert [(item.expires_at, item.amount) for item in balance.expiring] == [
                (grace_until, 100)
            ]
            result = await ledger.consume(
                ConsumeInput(
                    customer_id=customer_id,
                    pool_order=["paid"],
                    amount=10,
                    idempotency_key=f"consume:{uuid.uuid4()}",
                    meta=LedgerReference(),
                    now=during_grace,
                    negative_balance="block",
                    negative_floor=0,
                )
            )
            assert result.ok is True
            await ledger.append(
                NewLedgerEntry(
                    customer_id=customer_id,
                    pool="paid",
                    kind="adjust",
                    amount=0,
                    unit_price_minor=None,
                    currency="USD",
                    expires_at=during_grace,
                    source="subscription",
                    reference=LedgerReference(grant_id=grant.id),
                    idempotency_key=f"adjust:end:{grant.id}",
                    actor="system",
                    reason="SB-08 grace_expiry_end",
                )
            )
            await ledger.append(
                NewLedgerEntry(
                    customer_id=customer_id,
                    pool="paid",
                    kind="adjust",
                    amount=0,
                    unit_price_minor=None,
                    currency="USD",
                    expires_at=during_grace + timedelta(days=1),
                    source="subscription",
                    reference=LedgerReference(grant_id=grant.id),
                    idempotency_key=f"adjust:end-later:{grant.id}",
                    actor="system",
                    reason="SB-08 grace_expiry_end",
                )
            )
            assert (
                await ledger.balance(customer_id, "paid", during_grace)
            ).available == 0
        finally:
            await drop_test_db(db)

    asyncio.run(run())


def test_negative_balance_block_rejects_atomically():
    async def run():
        db = await create_test_db("py_ledger_block")
        try:
            from boilpayment_core import ConsumeInput

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
            from boilpayment_core import ConsumeInput

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
            from boilpayment_core import ConsumeInput

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
