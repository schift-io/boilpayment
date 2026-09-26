"""[EC:B21] Postgres consume idempotency is an exact match on the caller's key."""
from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime

from boilpayment_core import ConsumeInput, Customer, LedgerReference, NewLedgerEntry
from boilpayment_schema_postgres import PostgresLedgerStore, PostgresRepo
from db_helper import create_test_db, drop_test_db


async def _customer(repo, ledger, grants: list[tuple[str, int]]) -> str:
    cid = f"cust_{uuid.uuid4()}"
    await repo.customers.put(Customer(id=cid, email=None, provider_refs=[], status="active", created_at=datetime.now(UTC)))
    for key, amount in grants:
        await ledger.append(NewLedgerEntry(customer_id=cid, pool="paid", kind="grant", amount=amount, unit_price_minor=None,
                                           currency=None, expires_at=None, source="topup", reference=LedgerReference(),
                                           idempotency_key=key, actor="test"))
    return cid


def _consume(ledger, cid: str, amount: int, key: str):
    return ledger.consume(ConsumeInput(customer_id=cid, pool_order=["paid"], amount=amount, idempotency_key=key,
                                       meta=LedgerReference(), now=datetime.now(UTC), negative_balance="block", negative_floor=0))


def test_ec_b21_prefix_and_wildcard_keys_are_charged() -> None:
    async def run():
        db = await create_test_db("py_consumekey")
        try:
            ledger, repo = PostgresLedgerStore(db.dsn), PostgresRepo(db.dsn)
            c = await _customer(repo, ledger, [("topup:pay_1", 300)])
            out = [(r.ok, r.duplicated) for r in [await _consume(ledger, c, 60, k) for k in ("topup", "t%", "%", "_")]]
            split = await _customer(repo, ledger, [("g1", 50), ("g2", 50)])
            first = await _consume(ledger, split, 80, "job")
            other = await _consume(ledger, split, 10, "job:1")
            again = await _consume(ledger, split, 80, "job")
            now = datetime.now(UTC)
            return (out, (await ledger.balance(c, None, now)).available, len(first.entries),
                    (other.ok, other.duplicated), (again.ok, again.duplicated), (await ledger.balance(split, None, now)).available)
        finally:
            await drop_test_db(db)

    assert asyncio.run(run()) == ([(True, False)] * 4, 60, 2, (True, False), (True, True), 10)


async def _legacy_customer(db, repo, ledger) -> str:
    """What the pre-0013 build wrote for consume('job', 80) over two grants: 'job' and 'job:1'."""
    cid = await _customer(repo, ledger, [("g", 100)])
    import psycopg
    # One transaction, so both rows get the same now() -- with microseconds, as the old build wrote them.
    async with await psycopg.AsyncConnection.connect(db.dsn) as conn:
        async with conn.transaction():
            for key, amount in (("job", -50), ("job:1", -30)):
                await conn.execute(
                    "insert into ledger_entries (id, customer_id, pool, kind, amount, source, reference, idempotency_key, actor) "
                    "values (%s, %s, 'paid', 'consume', %s, 'usage', '{}'::jsonb, %s, 'app')",
                    (f"le_{uuid.uuid4()}", cid, amount, key))
        await conn.execute("select paykit_refresh_balance(%s)", (cid,))
    return cid


def _consume_unbounded(ledger, cid: str, amount: int, key: str):
    return ledger.consume(ConsumeInput(customer_id=cid, pool_order=["paid"], amount=amount, idempotency_key=key,
                                       meta=LedgerReference(), now=datetime.now(UTC), negative_balance="allow_unbounded", negative_floor=0))


def test_ec_b22_legacy_split_consume_rows_after_upgrade() -> None:
    async def run():
        db = await create_test_db("py_consumelegacy")
        try:
            ledger, repo = PostgresLedgerStore(db.dsn), PostgresRepo(db.dsn)
            a = await _legacy_customer(db, repo, ledger)
            new = await _consume_unbounded(ledger, a, 20, "job:1")
            b = await _legacy_customer(db, repo, ledger)
            retry = await _consume_unbounded(ledger, b, 80, "job")
            now = datetime.now(UTC)
            return ((new.ok, new.duplicated, sum(e.amount for e in new.entries)), (await ledger.balance(a, None, now)).available,
                    (retry.ok, retry.duplicated, sum(e.amount for e in retry.entries), len(retry.entries)),
                    (await ledger.balance(b, None, now)).available)
        finally:
            await drop_test_db(db)
    assert asyncio.run(run()) == ((True, False, -20), 0, (True, True, -80, 2), 20)


def test_ec_b23_consume_key_conflicts_match_memory() -> None:
    import pytest
    from boilpayment_core import PaymentKitError

    async def run():
        db = await create_test_db("py_consumeconflict")
        try:
            ledger, repo = PostgresLedgerStore(db.dsn), PostgresRepo(db.dsn)
            same = await _customer(repo, ledger, [("k", 50)])
            r = await _consume(ledger, same, 10, "k")
            held = await _customer(repo, ledger, [("g", 50), ("k#0", 50)])
            with pytest.raises(PaymentKitError) as err:
                await _consume(ledger, held, 10, "k")
            return (r.ok, r.duplicated), err.value.code, (await ledger.balance(held, None, datetime.now(UTC))).available
        finally:
            await drop_test_db(db)
    assert asyncio.run(run()) == ((True, False), "idempotency_key_conflict", 100)
