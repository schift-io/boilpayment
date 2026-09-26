"""camelCase <-> snake_case + jsonb helpers, and a generic PgTable[T]. Mirrors ts/src/mapping.ts.

Tables that don't fit a flat row 1:1 (plans+plan_prices, cs_cases+policy_snapshots) get a
hand-written Table instead — see repo.py.
"""

from __future__ import annotations

import dataclasses
import re
from collections.abc import Callable
from datetime import datetime
from typing import Any, Generic, TypeVar

from psycopg.types.json import Jsonb

from .tx import connection

T = TypeVar("T")

_CAMEL_BOUNDARY = re.compile(r"(?<!^)(?=[A-Z])")


def camel_to_snake(s: str) -> str:
    return _CAMEL_BOUNDARY.sub("_", s).lower()


def snake_to_camel(s: str) -> str:
    parts = s.split("_")
    return parts[0] + "".join(p.capitalize() for p in parts[1:])


def jsonb(value: Any) -> Jsonb | None:
    """psycopg3 does NOT auto-adapt a plain dict/list for a jsonb column (verified: raises
    `cannot adapt type 'dict'`) — every jsonb value must be wrapped explicitly."""
    return None if value is None else Jsonb(value)


def json_safe(value: Any) -> Any:
    """Recursively converts `value` into something plain `json.dumps` can serialize: a dataclass
    instance (nested ones included) -> dict, `datetime` -> ISO string, list/tuple -> list, dict ->
    dict (keys/values recursed); everything else passes through unchanged.

    `Jsonb` (used by `jsonb()` above) serializes via plain `json.dumps` by default, which raises
    `TypeError` on both a raw dataclass instance and a `datetime` — a gap that only bites on
    fields whose *type* is opaque to this package, e.g. `CsCase.decision: dict[str, Any] | None`.
    `cs.refundAssist`'s `resolve()` stores `decision = {"decision": RefundDecision(...), "refund":
    Refund(...)}` there, and `Refund.created_at` is a `datetime` — reproduced in
    test_cs_cases_decision_serialization.py. Wrap any jsonb value whose shape isn't controlled by
    this package (i.e. not already a plain dict assembled from primitives) with `jsonb(json_safe(...))`
    instead of `jsonb(...)` alone.
    """
    if isinstance(value, datetime):
        return value.isoformat()
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return json_safe(dataclasses.asdict(value))
    if isinstance(value, dict):
        return {k: json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(v) for v in value]
    return value


class PgTable(Generic[T]):
    """Generic Table[T] backed by one Postgres table with an `id text primary key` and a plain
    upsert-by-id `put`. Uses the active per-customer transaction connection when called from inside
    one (tx.py), otherwise opens an ephemeral connection."""

    def __init__(
        self,
        dsn: str,
        table_name: str,
        to_row: Callable[[T], dict[str, Any]],
        from_row: Callable[[dict[str, Any]], T],
    ) -> None:
        self._dsn = dsn
        self._table_name = table_name
        self._to_row = to_row
        self._from_row = from_row

    async def get(self, id: str) -> T | None:
        async with connection(self._dsn) as conn, conn.cursor() as cur:
            await cur.execute(f"select * from {self._table_name} where id = %s", (id,))
            row = await cur.fetchone()
            return self._from_row(row) if row else None

    async def put(self, row: T) -> T:
        data = self._to_row(row)
        cols = list(data.keys())
        values = [data[c] for c in cols]
        placeholders = ["%s"] * len(cols)
        updates = [f"{c} = excluded.{c}" for c in cols if c != "id"]
        sql = (
            f"insert into {self._table_name} ({', '.join(cols)}) values ({', '.join(placeholders)}) "
            f"on conflict (id) do update set {', '.join(updates)} returning *"
        )
        async with connection(self._dsn) as conn, conn.cursor() as cur:
            await cur.execute(sql, values)
            result = await cur.fetchone()
            return self._from_row(result)

    async def list(self, **filter: Any) -> list[T]:
        entries = [(k, v) for k, v in filter.items() if v is not None]
        sql = f"select * from {self._table_name}"
        params: list[Any] = []
        if entries:
            clauses = []
            for k, v in entries:
                params.append(v)
                clauses.append(f"{camel_to_snake(k)} = %s")
            sql += " where " + " and ".join(clauses)
        async with connection(self._dsn) as conn, conn.cursor() as cur:
            await cur.execute(sql, params)
            rows = await cur.fetchall()
            return [self._from_row(r) for r in rows]
