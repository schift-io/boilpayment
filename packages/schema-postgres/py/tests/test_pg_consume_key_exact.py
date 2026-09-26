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
