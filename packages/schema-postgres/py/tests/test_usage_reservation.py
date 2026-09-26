"""[EC:C10] usage reservations on Postgres -- racing reserves for the last budget.

Mirrors packages/schema-postgres/ts/test/usage-reservation.test.ts. PAYKIT_PG_POOL_MAX is raised
before the first import (module-level constant) so the 10 reserves really run concurrently.
pytest-asyncio is not installed -> the test wraps its async body with asyncio.run().
"""

from __future__ import annotations

import os

os.environ.setdefault("PAYKIT_PG_POOL_MAX", "25")

import asyncio
import uuid
from datetime import UTC, datetime

from boilpayment_core import DEFAULT_POLICY, Customer, FixedClock, NewLedgerEntry
from boilpayment_schema_postgres import PostgresLedgerStore, PostgresRepo
from boilpayment_usage import commit, release, reserve, sweep_reservations
from db_helper import create_test_db, drop_test_db


def test_10_parallel_reserves_of_60_against_100_exactly_one_wins():
    async def run():
        db = await create_test_db("py_reserve")
        try:
            repo = PostgresRepo(db.dsn)
            ledger = PostgresLedgerStore(db.dsn)
            clock = FixedClock(datetime(2026, 5, 15, tzinfo=UTC))
            cid = f"cust_{uuid.uuid4()}"
            await repo.customers.put(
                Customer(id=cid, email=None, provider_refs=[], status="active", created_at=clock.now())
            )
            await ledger.append(
                NewLedgerEntry(
                    customer_id=cid, pool="paid", kind="grant", amount=100, source="manual",
                    idempotency_key=f"seed_{cid}", actor="test", reason="seed",
                )
            )
            deps = {"customer_id": cid, "policy": DEFAULT_POLICY, "ledger": ledger, "clock": clock}
            results = await asyncio.gather(*(reserve(**deps, job_id=f"job_{i}", amount=60) for i in range(10)))
            winners = [r for r in results if r.ok]
            losers = [r for r in results if not r.ok]
            after = (await ledger.balance(cid, None, clock.now())).available
            print(
                f"[EC:C10 pg race py] reserves=10 amount=60 budget=100 won={len(winners)} "
                f"refused={len(losers)} available_after={after}"
            )
            assert len(winners) == 1
            assert all((r.reason, r.need, r.available) == ("insufficient", 60, 40) for r in losers)

            await commit(**deps, job_id=winners[0].reservation.job_id, amount=25)
            assert (await ledger.balance(cid, None, clock.now())).available == 75
            await reserve(**deps, job_id="job_late", amount=50)
            clock.advance((DEFAULT_POLICY.usage.reservation_ttl_minutes + 1) * 60_000)
            assert await sweep_reservations(repo=repo, ledger=ledger, clock=clock) == {"expired": 1}
            assert (await ledger.balance(cid, None, clock.now())).available == 75
            assert (await release(**deps, job_id="job_late")).duplicated
        finally:
            await drop_test_db(db)

    asyncio.run(run())
