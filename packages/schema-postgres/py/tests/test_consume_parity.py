"""Store-parity check: run the exact same consume() scenarios against PostgresLedgerStore and
InMemoryLedger (packages/core) and assert identical results.

NOTE: while building this, two genuine InMemoryLedger divergences from PostgresLedgerStore /
spec/schema-postgres.pseudo.md [EC:B5] were found by reading source (py/src/schift_payment_kit_core
memory.py mirrors the same logic as ts/src/memory.ts) -- see final report "bug list":
  Two historical divergences (allow_to_floor room after a partial bucket draw; expired-but-not-
  batched grant counted in Postgres available) were fixed on both sides and are pinned below as
  scenarios E and F.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime, timedelta

from db_helper import create_test_db, drop_test_db
from schift_payment_kit_core import (
    ConsumeInput,
    Customer,
    InMemoryLedger,
    LedgerReference,
    NewLedgerEntry,
)
from schift_payment_kit_schema_postgres import PostgresLedgerStore, PostgresRepo


def _simplify(entries):
    return [{"pool": e.pool, "amount": e.amount} for e in entries]


def test_scenario_a_fifo_multi_pool_consume_matches():
    async def run():
        db = await create_test_db("py_parity_a")
        try:
            pg = PostgresLedgerStore(db.dsn)
            repo = PostgresRepo(db.dsn)
            mem = InMemoryLedger()

            pg_id = f"cust_pg_{uuid.uuid4()}"
            mem_id = f"cust_mem_{uuid.uuid4()}"
            await repo.customers.put(
                Customer(
                    id=pg_id,
                    email=None,
                    provider_refs=[],
                    status="active",
                    created_at=datetime.now(UTC),
                )
            )

            now = datetime.now(UTC)
            in1h = now + timedelta(hours=1)
            in2h = now + timedelta(hours=2)

            for store, customer_id in [(pg, pg_id), (mem, mem_id)]:
                await store.append(
                    NewLedgerEntry(
                        customer_id=customer_id,
                        pool="promo",
                        kind="grant",
                        amount=40,
                        unit_price_minor=0,
                        currency="USD",
                        expires_at=in2h,
                        source="promo",
                        reference=LedgerReference(),
                        idempotency_key=f"gA1_{customer_id}",
                        actor="system",
                    )
                )
                await store.append(
                    NewLedgerEntry(
                        customer_id=customer_id,
                        pool="paid",
                        kind="grant",
                        amount=60,
                        unit_price_minor=5,
                        currency="USD",
                        expires_at=in1h,
                        source="subscription",
                        reference=LedgerReference(),
                        idempotency_key=f"gA2_{customer_id}",
                        actor="system",
                    )
                )

            pg_result = await pg.consume(
                ConsumeInput(
                    customer_id=pg_id,
                    pool_order=["promo", "paid"],
                    amount=70,
                    idempotency_key=f"cA_{pg_id}",
                    meta=LedgerReference(),
                    now=now,
                    negative_balance="block",
                    negative_floor=0,
                )
            )
            mem_result = await mem.consume(
                ConsumeInput(
                    customer_id=mem_id,
                    pool_order=["promo", "paid"],
                    amount=70,
                    idempotency_key=f"cA_{mem_id}",
                    meta=LedgerReference(),
                    now=now,
                    negative_balance="block",
                    negative_floor=0,
                )
            )

            assert pg_result.ok is True
            assert mem_result.ok is True
            assert pg_result.shortfall == 0
            assert mem_result.shortfall == 0
            assert _simplify(pg_result.entries) == _simplify(mem_result.entries)
            assert _simplify(pg_result.entries) == [
                {"pool": "promo", "amount": -40},
                {"pool": "paid", "amount": -30},
            ]

            pg_bal = await pg.balance(pg_id, None, now)
            mem_bal = await mem.balance(mem_id, None, now)
            assert pg_bal.available == mem_bal.available == 30
        finally:
            await drop_test_db(db)

    asyncio.run(run())


def test_scenario_b_negative_balance_block_matches():
    async def run():
        db = await create_test_db("py_parity_b")
        try:
            pg = PostgresLedgerStore(db.dsn)
            repo = PostgresRepo(db.dsn)
            mem = InMemoryLedger()

            pg_id = f"cust_pg_{uuid.uuid4()}"
            mem_id = f"cust_mem_{uuid.uuid4()}"
            await repo.customers.put(
                Customer(
                    id=pg_id,
                    email=None,
                    provider_refs=[],
                    status="active",
                    created_at=datetime.now(UTC),
                )
            )
            now = datetime.now(UTC)
            for store, customer_id in [(pg, pg_id), (mem, mem_id)]:
                await store.append(
                    NewLedgerEntry(
                        customer_id=customer_id,
                        pool="paid",
                        kind="grant",
                        amount=20,
                        unit_price_minor=1,
                        currency="USD",
                        expires_at=None,
                        source="subscription",
                        reference=LedgerReference(),
                        idempotency_key=f"gB_{customer_id}",
                        actor="system",
                    )
                )

            pg_result = await pg.consume(
                ConsumeInput(
                    customer_id=pg_id,
                    pool_order=["paid"],
                    amount=50,
                    idempotency_key=f"cB_{pg_id}",
                    meta=LedgerReference(),
                    now=now,
                    negative_balance="block",
                    negative_floor=0,
                )
            )
            mem_result = await mem.consume(
                ConsumeInput(
                    customer_id=mem_id,
                    pool_order=["paid"],
                    amount=50,
                    idempotency_key=f"cB_{mem_id}",
                    meta=LedgerReference(),
                    now=now,
                    negative_balance="block",
                    negative_floor=0,
                )
            )
            assert pg_result.ok is False
            assert mem_result.ok is False
            assert pg_result.shortfall == mem_result.shortfall == 30

            pg_bal = await pg.balance(pg_id, None, now)
            mem_bal = await mem.balance(mem_id, None, now)
            assert pg_bal.available == 20
            assert mem_bal.available == 20
        finally:
            await drop_test_db(db)

    asyncio.run(run())


def test_scenario_c_allow_to_floor_empty_pools_matches():
    async def run():
        db = await create_test_db("py_parity_c")
        try:
            pg = PostgresLedgerStore(db.dsn)
            repo = PostgresRepo(db.dsn)
            mem = InMemoryLedger()

            pg_id = f"cust_pg_{uuid.uuid4()}"
            mem_id = f"cust_mem_{uuid.uuid4()}"
            await repo.customers.put(
                Customer(
                    id=pg_id,
                    email=None,
                    provider_refs=[],
                    status="active",
                    created_at=datetime.now(UTC),
                )
            )
            now = datetime.now(UTC)

            pg_first = await pg.consume(
                ConsumeInput(
                    customer_id=pg_id,
                    pool_order=["paid"],
                    amount=500,
                    idempotency_key=f"cC1_{pg_id}",
                    meta=LedgerReference(),
                    now=now,
                    negative_balance="allow_to_floor",
                    negative_floor=-500,
                )
            )
            mem_first = await mem.consume(
                ConsumeInput(
                    customer_id=mem_id,
                    pool_order=["paid"],
                    amount=500,
                    idempotency_key=f"cC1_{mem_id}",
                    meta=LedgerReference(),
                    now=now,
                    negative_balance="allow_to_floor",
                    negative_floor=-500,
                )
            )
            assert pg_first.ok is True
            assert mem_first.ok is True
            pg_bal1 = await pg.balance(pg_id, None, now)
            mem_bal1 = await mem.balance(mem_id, None, now)
            assert pg_bal1.available == mem_bal1.available == -500

            pg_second = await pg.consume(
                ConsumeInput(
                    customer_id=pg_id,
                    pool_order=["paid"],
                    amount=1,
                    idempotency_key=f"cC2_{pg_id}",
                    meta=LedgerReference(),
                    now=now,
                    negative_balance="allow_to_floor",
                    negative_floor=-500,
                )
            )
            mem_second = await mem.consume(
                ConsumeInput(
                    customer_id=mem_id,
                    pool_order=["paid"],
                    amount=1,
                    idempotency_key=f"cC2_{mem_id}",
                    meta=LedgerReference(),
                    now=now,
                    negative_balance="allow_to_floor",
                    negative_floor=-500,
                )
            )
            assert pg_second.ok is False
            assert mem_second.ok is False
        finally:
            await drop_test_db(db)

    asyncio.run(run())


def test_scenario_d_allow_unbounded_with_bucket_draw_matches():
    async def run():
        db = await create_test_db("py_parity_d")
        try:
            pg = PostgresLedgerStore(db.dsn)
            repo = PostgresRepo(db.dsn)
            mem = InMemoryLedger()

            pg_id = f"cust_pg_{uuid.uuid4()}"
            mem_id = f"cust_mem_{uuid.uuid4()}"
            await repo.customers.put(
                Customer(
                    id=pg_id,
                    email=None,
                    provider_refs=[],
                    status="active",
                    created_at=datetime.now(UTC),
                )
            )
            now = datetime.now(UTC)
            for store, customer_id in [(pg, pg_id), (mem, mem_id)]:
                await store.append(
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
                        idempotency_key=f"gD_{customer_id}",
                        actor="system",
                    )
                )

            pg_result = await pg.consume(
                ConsumeInput(
                    customer_id=pg_id,
                    pool_order=["paid"],
                    amount=50,
                    idempotency_key=f"cD_{pg_id}",
                    meta=LedgerReference(),
                    now=now,
                    negative_balance="allow_unbounded",
                    negative_floor=0,
                )
            )
            mem_result = await mem.consume(
                ConsumeInput(
                    customer_id=mem_id,
                    pool_order=["paid"],
                    amount=50,
                    idempotency_key=f"cD_{mem_id}",
                    meta=LedgerReference(),
                    now=now,
                    negative_balance="allow_unbounded",
                    negative_floor=0,
                )
            )
            assert pg_result.ok is True
            assert mem_result.ok is True
            assert _simplify(pg_result.entries) == _simplify(mem_result.entries)
            assert _simplify(pg_result.entries) == [
                {"pool": "paid", "amount": -10},
                {"pool": "paid", "amount": -40},
            ]

            pg_bal = await pg.balance(pg_id, None, now)
            mem_bal = await mem.balance(mem_id, None, now)
            assert pg_bal.available == mem_bal.available == -40
        finally:
            await drop_test_db(db)

    asyncio.run(run())


def _grant(customer_id: str, amount: int, key: str, expires_at=None, source="subscription") -> NewLedgerEntry:
    return NewLedgerEntry(
        customer_id=customer_id, pool="paid", kind="grant", amount=amount, source=source,
        idempotency_key=key, actor="system", unit_price_minor=1, currency="USD", expires_at=expires_at,
    )


def _consume(customer_id: str, amount: int, key: str, now, negative_balance="block", negative_floor=0) -> ConsumeInput:
    return ConsumeInput(
        customer_id=customer_id, pool_order=["paid"], amount=amount, idempotency_key=key,
        meta=LedgerReference(), now=now, negative_balance=negative_balance, negative_floor=negative_floor,
    )


async def _pair(db):
    pg = PostgresLedgerStore(db.dsn)
    repo = PostgresRepo(db.dsn)
    mem = InMemoryLedger()
    pg_id = f"cust_pg_{uuid.uuid4()}"
    mem_id = f"cust_mem_{uuid.uuid4()}"
    await repo.customers.put(Customer(id=pg_id, email=None, provider_refs=[], status="active", created_at=datetime.now(UTC)))
    return pg, mem, pg_id, mem_id


def test_scenario_e_allow_to_floor_after_partial_draw_matches():
    """EC:B4/B5 -- grant 10, floor -1, consume 13: allowed = max(0, 10-10-(-1)) = 1 < 3 -> both reject."""

    async def run():
        db = await create_test_db("py_parity_e")
        try:
            pg, mem, pg_id, mem_id = await _pair(db)
            now = datetime.now(UTC)
            await pg.append(_grant(pg_id, 10, f"gE_{pg_id}"))
            await mem.append(_grant(mem_id, 10, f"gE_{mem_id}"))
            pg_res = await pg.consume(_consume(pg_id, 13, f"cE_{pg_id}", now, "allow_to_floor", -1))
            mem_res = await mem.consume(_consume(mem_id, 13, f"cE_{mem_id}", now, "allow_to_floor", -1))
            assert pg_res.ok is False and mem_res.ok is False
            assert pg_res.shortfall == mem_res.shortfall
            assert pg_res.entries == [] and mem_res.entries == []
            assert (await pg.balance(pg_id, None, now)).available == 10
            assert (await mem.balance(mem_id, None, now)).available == 10
            pg_ok = await pg.consume(_consume(pg_id, 11, f"cE2_{pg_id}", now, "allow_to_floor", -1))
            mem_ok = await mem.consume(_consume(mem_id, 11, f"cE2_{mem_id}", now, "allow_to_floor", -1))
            assert pg_ok.ok is True and mem_ok.ok is True
            assert (await pg.balance(pg_id, None, now)).available == -1
            assert (await mem.balance(mem_id, None, now)).available == -1
        finally:
            await drop_test_db(db)

    asyncio.run(run())


def test_scenario_f_expired_not_batched_grant_excluded_matches():
    """EC:B14 -- expired-but-not-yet-batched grant is excluded from available in both stores."""

    async def run():
        db = await create_test_db("py_parity_f")
        try:
            pg, mem, pg_id, mem_id = await _pair(db)
            now = datetime.now(UTC)
            past = now - timedelta(seconds=1)
            for store, cid in ((pg, pg_id), (mem, mem_id)):
                await store.append(_grant(cid, 100, f"gF_{cid}", expires_at=past))
                await store.append(_grant(cid, 5, f"gF2_{cid}", source="topup"))
            assert (await pg.balance(pg_id, None, now)).available == 5
            assert (await mem.balance(mem_id, None, now)).available == 5
            pg_res = await pg.consume(_consume(pg_id, 10, f"cF_{pg_id}", now))
            mem_res = await mem.consume(_consume(mem_id, 10, f"cF_{mem_id}", now))
            assert pg_res.ok is False and mem_res.ok is False
            assert pg_res.shortfall == 5 and mem_res.shortfall == 5
        finally:
            await drop_test_db(db)

    asyncio.run(run())
