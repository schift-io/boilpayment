"""[EC:B5] concurrent consume -- pg_advisory_xact_lock + FOR UPDATE must prevent overselling when
multiple connections race to consume from the same customer's balance.

Sets PAYKIT_PG_POOL_MAX before the first import of boilpayment_schema_postgres (module-level
constant, read once at import time) so the shared connection pool has enough headroom for 20
truly-concurrent consume() calls instead of queueing behind the default max of 10.

pytest-asyncio is not installed -> the test wraps its async body with asyncio.run().
"""

from __future__ import annotations

import os

os.environ.setdefault("PAYKIT_PG_POOL_MAX", "25")

import asyncio
import uuid
from datetime import UTC, datetime

from boilpayment_core import (
    ConsumeInput,
    Customer,
    LedgerReference,
    NewLedgerEntry,
)
from boilpayment_schema_postgres import PostgresLedgerStore, PostgresRepo
from db_helper import create_test_db, drop_test_db


def test_20_parallel_consumes_of_10_against_balance_100_exactly_10_succeed():
    async def run():
        db = await create_test_db("py_concur")
        try:
            repo = PostgresRepo(db.dsn)
            ledger = PostgresLedgerStore(db.dsn)
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
                    idempotency_key=f"grant_{customer_id}",
                    actor="system",
                )
            )

            now = datetime.now(UTC)

            async def attempt(i: int):
                return await ledger.consume(
                    ConsumeInput(
                        customer_id=customer_id,
                        pool_order=["paid"],
                        amount=10,
                        idempotency_key=f"concur_{customer_id}_{i}",
                        meta=LedgerReference(),
                        now=now,
                        negative_balance="block",
                        negative_floor=0,
                    )
                )

            results = await asyncio.gather(*(attempt(i) for i in range(20)))

            succeeded = [r for r in results if r.ok]
            failed = [r for r in results if not r.ok]
            assert len(succeeded) == 10
            assert len(failed) == 10
            for f in failed:
                assert f.shortfall > 0
                assert f.entries == []

            final_balance = await ledger.balance(customer_id, None, now)
            assert final_balance.available == 0
        finally:
            await drop_test_db(db)

    asyncio.run(run())
