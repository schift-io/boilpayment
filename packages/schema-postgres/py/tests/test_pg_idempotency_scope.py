"""[EC:B20] Postgres: idempotency keys are unique per customer (migrations 0009, 0010)."""
from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime

from boilpayment_core import ConsumeInput, Customer, LedgerReference, NewLedgerEntry, UsageEvent
from boilpayment_schema_postgres import PostgresLedgerStore, PostgresRepo
from db_helper import create_test_db, drop_test_db


async def _customer(repo: PostgresRepo, ledger: PostgresLedgerStore) -> str:
    cid = f"cust_{uuid.uuid4()}"
    await repo.customers.put(Customer(id=cid, email=None, provider_refs=[], status="active", created_at=datetime.now(UTC)))
    await ledger.append(NewLedgerEntry(customer_id=cid, pool="paid", kind="grant", amount=100, unit_price_minor=None,
                                       currency=None, expires_at=None, source="manual", reference=LedgerReference(),
                                       idempotency_key=f"g:{cid}", actor="test"))
    return cid


def _consume(ledger: PostgresLedgerStore, cid: str, amount: int, key: str):
    return ledger.consume(ConsumeInput(customer_id=cid, pool_order=["paid"], amount=amount, idempotency_key=key,
                                       meta=LedgerReference(), now=datetime.now(UTC), negative_balance="block", negative_floor=0))


def test_ec_b20_other_customer_same_key_is_charged() -> None:
    async def run():
        db = await create_test_db("py_idemscope")
        try:
            ledger, repo = PostgresLedgerStore(db.dsn), PostgresRepo(db.dsn)
            a, b = await _customer(repo, ledger), await _customer(repo, ledger)
            key = f"req-{uuid.uuid4()}"
            await _consume(ledger, a, 30, key)
            rb = await _consume(ledger, b, 50, key)
            again = await _consume(ledger, b, 50, key)
            now = datetime.now(UTC)
            return (rb.duplicated, all(e.customer_id == b for e in rb.entries), again.duplicated,
                    (await ledger.balance(a, None, now)).available, (await ledger.balance(b, None, now)).available)
        finally:
            await drop_test_db(db)

    assert asyncio.run(run()) == (False, True, True, 70, 50)


def test_ec_b20_usage_events_same_key_two_customers() -> None:
    async def run():
        db = await create_test_db("py_idemscope_usage")
        try:
            ledger, repo = PostgresLedgerStore(db.dsn), PostgresRepo(db.dsn)
            a, b = await _customer(repo, ledger), await _customer(repo, ledger)
            key = f"evt-{uuid.uuid4()}"
            now = datetime.now(UTC)
            for cid in (a, b):
                await repo.usage_events.put(UsageEvent(id=f"u_{uuid.uuid4()}", customer_id=cid, meter="api", quantity=1,
                                                       occurred_at=now, received_at=now, period_start=datetime(2026, 1, 1, tzinfo=UTC),
                                                       idempotency_key=key, meta={}))
            return len(await repo.usage_events.list(idempotency_key=key))
        finally:
            await drop_test_db(db)

    assert asyncio.run(run()) == 2
