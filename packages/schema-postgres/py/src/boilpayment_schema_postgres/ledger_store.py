"""PostgresLedgerStore implements boilpayment_core.LedgerStore.

EC:H3 — append-only: this store never issues UPDATE/DELETE on ledger_entries (trigger enforces it).
EC:B1-B15 H3 H4 — see spec/schema-postgres.pseudo.md for the consume algorithm this mirrors 1:1
(and ts/src/ledger-store.py, the same logic in TypeScript).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from boilpayment_core import (
    AppendResult,
    Balance,
    ConsumeInput,
    ConsumeResult,
    ExpiringBucket,
    LedgerEntry,
    LedgerKind,
    LedgerReference,
    LedgerSource,
    NewLedgerEntry,
    Pool,
)

from .mapping import jsonb
from .tx import connection, with_customer_transaction


def _reference_to_json(ref: LedgerReference | None) -> dict[str, Any]:
    if ref is None:
        return {}
    out: dict[str, Any] = {}
    if ref.subscription_id is not None:
        out["subscriptionId"] = ref.subscription_id
    if ref.period_start is not None:
        out["periodStart"] = ref.period_start.isoformat()
    if ref.payment_id is not None:
        out["paymentId"] = ref.payment_id
    if ref.case_id is not None:
        out["caseId"] = ref.case_id
    if ref.grant_id is not None:
        out["grantId"] = ref.grant_id
    if ref.refund_id is not None:
        out["refundId"] = ref.refund_id
    return out


def _json_to_reference(data: dict[str, Any] | None) -> LedgerReference:
    j = data or {}
    return LedgerReference(
        subscription_id=j.get("subscriptionId"),
        period_start=datetime.fromisoformat(j["periodStart"])
        if j.get("periodStart")
        else None,
        payment_id=j.get("paymentId"),
        case_id=j.get("caseId"),
        grant_id=j.get("grantId"),
        refund_id=j.get("refundId"),
    )


def _row_to_entry(row: dict[str, Any]) -> LedgerEntry:
    return LedgerEntry(
        id=row["id"],
        customer_id=row["customer_id"],
        pool=row["pool"],
        kind=row["kind"],
        amount=int(row["amount"]),
        unit_price_minor=None
        if row["unit_price_minor"] is None
        else int(row["unit_price_minor"]),
        currency=row["currency"],
        expires_at=row["expires_at"],
        source=row["source"],
        reference=_json_to_reference(row["reference"]),
        idempotency_key=row["idempotency_key"],
        actor=row["actor"],
        reason=row["reason"],
        created_at=row["created_at"],
    )


def _row_to_balance(
    customer_id: str, pool: Pool | str, row: dict[str, Any] | None
) -> Balance:
    expiring_raw = (row or {}).get("expiring") or []
    expiring = [
        ExpiringBucket(
            expires_at=datetime.fromisoformat(e["expiresAt"])
            if isinstance(e["expiresAt"], str)
            else e["expiresAt"],
            amount=int(e["amount"]),
        )
        for e in expiring_raw
    ]
    return Balance(
        customer_id=customer_id,
        pool=pool,
        available=int(row["available"]) if row else 0,
        held=int(row["held"]) if row else 0,
        expiring=expiring,
    )


class PostgresLedgerStore:
    """EC:B5 — see spec/schema-postgres.pseudo.md [EC:B5]."""

    def __init__(self, dsn: str) -> None:
        self._dsn = dsn

    async def transaction(self, customer_id: str, fn):
        return await with_customer_transaction(self._dsn, customer_id, fn)

    # EC:B1 B2 B9 B12
    async def append(self, entry: NewLedgerEntry) -> AppendResult:
        async def run() -> AppendResult:
            async with (
                connection(self._dsn, entry.customer_id) as conn,
                conn.cursor() as cur,
            ):
                await cur.execute(
                    "select * from ledger_entries where customer_id = %s and idempotency_key = %s",
                    (entry.customer_id, entry.idempotency_key),
                )
                existing = await cur.fetchone()
                if existing:
                    return AppendResult(entry=_row_to_entry(existing), duplicated=True)

                entry_id = f"le_{uuid.uuid4()}"
                await cur.execute(
                    """
                    insert into ledger_entries
                      (id, customer_id, pool, kind, amount, unit_price_minor, currency, expires_at, source,
                       reference, idempotency_key, actor, reason)
                    values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    returning *
                    """,
                    (
                        entry_id,
                        entry.customer_id,
                        entry.pool,
                        entry.kind,
                        entry.amount,
                        entry.unit_price_minor,
                        entry.currency,
                        entry.expires_at,
                        entry.source,
                        jsonb(_reference_to_json(entry.reference)),
                        entry.idempotency_key,
                        entry.actor,
                        entry.reason,
                    ),
                )
                row = await cur.fetchone()
                await cur.execute(
                    "select paykit_refresh_balance(%s)", (entry.customer_id,)
                )
                return AppendResult(entry=_row_to_entry(row), duplicated=False)

        return await with_customer_transaction(self._dsn, entry.customer_id, run)

    # EC:B15 -- `now` is required (see LedgerStore.balance doc comment in core's types.py).
    async def balance(
        self, customer_id: str, pool: Pool | None, now: datetime
    ) -> Balance:
        async with connection(self._dsn, customer_id) as conn, conn.cursor() as cur:
            # EC:B15 B14 -- refresh the snapshot as of `now` (expired grants excluded, like InMemoryLedger), then read.
            await cur.execute(
                "select paykit_refresh_balance(%s, %s)",
                (customer_id, now),
            )
            if pool:
                await cur.execute(
                    "select * from credit_balances where customer_id=%s and pool=%s",
                    (customer_id, pool),
                )
                row = await cur.fetchone()
                return _row_to_balance(customer_id, pool, row)

            await cur.execute(
                "select * from credit_balances where customer_id=%s", (customer_id,)
            )
            rows = await cur.fetchall()
            available = sum(int(r["available"]) for r in rows)
            held = sum(int(r["held"]) for r in rows)
            expiring: list[ExpiringBucket] = []
            for r in rows:
                for e in r["expiring"] or []:
                    ts = e["expiresAt"]
                    expiring.append(
                        ExpiringBucket(
                            expires_at=datetime.fromisoformat(ts)
                            if isinstance(ts, str)
                            else ts,
                            amount=int(e["amount"]),
                        )
                    )
            return Balance(
                customer_id=customer_id,
                pool="all",
                available=available,
                held=held,
                expiring=expiring,
            )

    async def entries(
        self,
        customer_id: str,
        *,
        pool: Pool | None = None,
        kind: LedgerKind | None = None,
        since: datetime | None = None,
        source: LedgerSource | None = None,
    ) -> list[LedgerEntry]:
        sql = "select * from ledger_entries where customer_id = %s"
        params: list[Any] = [customer_id]
        if pool:
            sql += " and pool = %s"
            params.append(pool)
        if kind:
            sql += " and kind = %s"
            params.append(kind)
        if source:
            sql += " and source = %s"
            params.append(source)
        if since:
            sql += " and created_at >= %s"
            params.append(since)
        sql += " order by created_at asc"
        async with connection(self._dsn, customer_id) as conn, conn.cursor() as cur:
            await cur.execute(sql, params)
            rows = await cur.fetchall()
            return [_row_to_entry(r) for r in rows]

    # EC:B5 — atomic multi-pool, multi-grant consume. See spec/schema-postgres.pseudo.md [EC:B5].
    async def consume(self, input: ConsumeInput) -> ConsumeResult:
        async def run() -> ConsumeResult:
            async with (
                connection(self._dsn, input.customer_id) as conn,
                conn.cursor() as cur,
            ):
                await cur.execute(
                    "select * from ledger_entries where customer_id = %s "
                    "and (idempotency_key = %s or idempotency_key like %s) "
                    "order by created_at asc",
                    (input.customer_id, input.idempotency_key, f"{input.idempotency_key}:%"),
                )
                existing = await cur.fetchall()
                if existing:
                    return ConsumeResult(
                        ok=True,
                        entries=[_row_to_entry(r) for r in existing],
                        shortfall=0,
                        duplicated=True,
                    )

                remaining = input.amount
                writes: list[dict[str, Any]] = []

                for pool in input.pool_order:
                    if remaining <= 0:
                        break
                    await cur.execute(
                        """
                        select g.id as grant_id, g.expires_at, g.unit_price_minor,
                               g.amount + coalesce((
                                 select sum(le.amount) from ledger_entries le where le.reference ->> 'grantId' = g.id
                               ), 0) as remaining
                        from ledger_entries g
                        where g.customer_id = %s and g.pool = %s and g.kind = 'grant'
                          and (g.expires_at is null or g.expires_at > %s)
                        order by g.expires_at asc nulls last, g.created_at asc
                        for update
                        """,
                        (input.customer_id, pool, input.now),
                    )
                    buckets = await cur.fetchall()
                    for bucket in buckets:
                        if remaining <= 0:
                            break
                        bucket_remaining = int(bucket["remaining"])
                        take = min(remaining, bucket_remaining)
                        if take <= 0:
                            continue
                        writes.append(
                            {
                                "pool": pool,
                                "grant_id": bucket["grant_id"],
                                "amount": -take,
                                "expires_at": bucket["expires_at"],
                                "unit_price_minor": bucket["unit_price_minor"],
                            }
                        )
                        remaining -= take

                shortfall = remaining
                if shortfall > 0:
                    if input.negative_balance == "block":
                        return ConsumeResult(
                            ok=False, entries=[], shortfall=shortfall, duplicated=False
                        )
                    last_pool = input.pool_order[-1] if input.pool_order else "paid"
                    if input.negative_balance == "allow_to_floor":
                        await cur.execute(
                            "select paykit_available(%s, null, %s) as total",  # EC:B14
                            (input.customer_id, input.now),
                        )
                        total_row = await cur.fetchone()
                        current_total = int(total_row["total"])
                        drawn_so_far = input.amount - shortfall
                        allowed = max(
                            0, current_total - drawn_so_far - input.negative_floor
                        )
                        extra = min(shortfall, allowed)
                        if extra > 0:
                            writes.append(
                                {
                                    "pool": last_pool,
                                    "grant_id": None,
                                    "amount": -extra,
                                    "expires_at": None,
                                    "unit_price_minor": None,
                                }
                            )
                            shortfall -= extra
                        if shortfall > 0:
                            return ConsumeResult(
                                ok=False,
                                entries=[],
                                shortfall=shortfall,
                                duplicated=False,
                            )
                    elif input.negative_balance == "allow_unbounded":
                        writes.append(
                            {
                                "pool": last_pool,
                                "grant_id": None,
                                "amount": -shortfall,
                                "expires_at": None,
                                "unit_price_minor": None,
                            }
                        )
                        shortfall = 0

                entries: list[LedgerEntry] = []
                for i, w in enumerate(writes):
                    entry_id = f"le_{uuid.uuid4()}"
                    key = (
                        input.idempotency_key
                        if i == 0
                        else f"{input.idempotency_key}:{i}"
                    )
                    reference = _reference_to_json(input.meta)
                    if w["grant_id"] is not None:
                        reference["grantId"] = w["grant_id"]
                    await cur.execute(
                        """
                        insert into ledger_entries
                          (id, customer_id, pool, kind, amount, unit_price_minor, expires_at, source, reference,
                           idempotency_key, actor, reason)
                        values (%s,%s,%s,'consume',%s,%s,%s,'usage',%s,%s,%s,%s)
                        returning *
                        """,
                        (
                            entry_id,
                            input.customer_id,
                            w["pool"],
                            w["amount"],
                            w["unit_price_minor"],
                            w["expires_at"],
                            jsonb(reference),
                            key,
                            input.actor or "app",
                            input.reason,
                        ),
                    )
                    entries.append(_row_to_entry(await cur.fetchone()))

                await cur.execute(
                    "select paykit_refresh_balance(%s)", (input.customer_id,)
                )
                return ConsumeResult(
                    ok=True, entries=entries, shortfall=0, duplicated=False
                )

        return await with_customer_transaction(self._dsn, input.customer_id, run)
