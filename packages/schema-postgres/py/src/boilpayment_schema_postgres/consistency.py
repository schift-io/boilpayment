"""EC:H4 — daily consistency check: ledger sum vs credit_balances snapshot, per (customer, pool)."""

from __future__ import annotations

from dataclasses import dataclass

import psycopg
from psycopg.rows import dict_row


@dataclass(kw_only=True, slots=True)
class BalanceMismatch:
    customer_id: str
    pool: str
    ledger_sum: int
    snapshot_available: int
    diff: int


async def consistency_check(
    conninfo_or_conn: str | psycopg.AsyncConnection,
) -> list[BalanceMismatch]:
    owns_conn = isinstance(conninfo_or_conn, str)
    conn = (
        await psycopg.AsyncConnection.connect(
            conninfo_or_conn, autocommit=True, row_factory=dict_row
        )
        if owns_conn
        else conninfo_or_conn
    )
    try:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                select le.customer_id, le.pool,
                       sum(le.amount) - paykit_expired_remaining(le.customer_id, le.pool, now()) as ledger_sum,
                       coalesce(cb.available, 0) as snapshot_available
                from ledger_entries le
                left join credit_balances cb on cb.customer_id = le.customer_id and cb.pool = le.pool
                group by le.customer_id, le.pool, cb.available
                having sum(le.amount) - paykit_expired_remaining(le.customer_id, le.pool, now()) <> coalesce(cb.available, 0)
                """
            )
            rows = await cur.fetchall()
            return [
                BalanceMismatch(
                    customer_id=r["customer_id"],
                    pool=r["pool"],
                    ledger_sum=int(r["ledger_sum"]),
                    snapshot_available=int(r["snapshot_available"]),
                    diff=int(r["ledger_sum"]) - int(r["snapshot_available"]),
                )
                for r in rows
            ]
    finally:
        if owns_conn:
            await conn.close()
