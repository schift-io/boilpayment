"""Per-customer transaction plumbing. Mirrors ts/src/tx.ts. EC:B5.

Connections come from one `psycopg_pool.AsyncConnectionPool` per DSN (lazily opened, process-wide),
so a request costs a pool checkout instead of a TCP+auth handshake. Nested calls for the same
customer reuse the outer transaction's connection via a `ContextVar` so they join the same
transaction rather than blocking on the outer advisory lock.
"""

from __future__ import annotations

import contextvars
import os
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import TypeVar

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

T = TypeVar("T")

_pools: dict[str, AsyncConnectionPool] = {}

# Tunables (env, so generated apps can size without code changes).
POOL_MIN = int(os.environ.get("PAYKIT_PG_POOL_MIN", "1"))
POOL_MAX = int(os.environ.get("PAYKIT_PG_POOL_MAX", "10"))
POOL_TIMEOUT = float(os.environ.get("PAYKIT_PG_POOL_TIMEOUT", "30"))


async def get_pool(dsn: str) -> AsyncConnectionPool:
    """One lazily-opened pool per DSN. `row_factory=dict_row` on every connection."""
    pool = _pools.get(dsn)
    if pool is None:
        pool = AsyncConnectionPool(
            dsn,
            min_size=POOL_MIN,
            max_size=POOL_MAX,
            timeout=POOL_TIMEOUT,
            kwargs={"row_factory": dict_row},
            open=False,
        )
        await pool.open()
        _pools[dsn] = pool
    return pool


async def close_pools() -> None:
    """Close every pool (call at app shutdown / end of tests)."""
    for dsn, pool in list(_pools.items()):
        await pool.close()
        _pools.pop(dsn, None)


@dataclass
class TxContext:
    conn: psycopg.AsyncConnection
    customer_id: str


_tx_var: contextvars.ContextVar[TxContext | None] = contextvars.ContextVar(
    "paykit_tx", default=None
)


def current_tx(customer_id: str | None = None) -> TxContext | None:
    ctx = _tx_var.get()
    if ctx is None:
        return None
    if customer_id is not None and ctx.customer_id != customer_id:
        return None
    return ctx


@asynccontextmanager
async def connection(
    dsn: str, customer_id: str | None = None
) -> AsyncIterator[psycopg.AsyncConnection]:
    """A connection to run a query on: the active per-customer transaction's connection if we're
    inside one for this exact customer_id, otherwise a pooled connection in autocommit mode that is
    returned to the pool after this single call."""
    ctx = current_tx(customer_id)
    if ctx is not None:
        yield ctx.conn
        return
    pool = await get_pool(dsn)
    async with pool.connection() as conn:
        await conn.set_autocommit(True)
        try:
            yield conn
        finally:
            await conn.set_autocommit(False)


@asynccontextmanager
async def atomic(dsn: str) -> AsyncIterator[psycopg.AsyncConnection]:
    """For non-customer-scoped multi-statement writes (plans+plan_prices, cs_cases+policy_snapshots)
    that still need atomicity. Joins the active per-customer transaction connection if there is one
    (any customer_id — the caller commits/rolls back), otherwise checks out a pooled connection and
    commits/rolls back around the `with` block itself."""
    ctx = current_tx()
    if ctx is not None:
        yield ctx.conn
        return
    pool = await get_pool(dsn)
    async with pool.connection() as conn:
        # pool.connection() commits on clean exit and rolls back on exception.
        yield conn


async def with_customer_transaction(
    dsn: str, customer_id: str, fn: Callable[[], Awaitable[T]]
) -> T:
    """EC:B5 — pg_advisory_xact_lock'd transaction for one customer. Reentrant for the same
    customer_id: a nested call reuses the outer transaction's connection instead of checking out a
    second one."""
    existing = _tx_var.get()
    if existing is not None and existing.customer_id == customer_id:
        return await fn()

    pool = await get_pool(dsn)
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute("select pg_advisory_xact_lock(hashtext(%s))", (customer_id,))
        token = _tx_var.set(TxContext(conn=conn, customer_id=customer_id))
        try:
            result = await fn()
            await conn.commit()
            return result
        except Exception:
            await conn.rollback()
            raise
        finally:
            _tx_var.reset(token)
