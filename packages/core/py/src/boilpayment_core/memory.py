"""In-memory reference implementations of LedgerStore / Repo / Notifier.
See spec/core.pseudo.md [EC:B5] [EC:B14] [EC:B3] [EC:B4] [EC:B12].
Mirrors packages/core/ts/src/memory.ts exactly.
"""

from __future__ import annotations

import asyncio
import contextvars
import dataclasses
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any, Generic, TypeVar

from .clock import SystemClock, UuidIdGen
from .types import (
    AppendResult,
    Balance,
    Clock,
    ConsumeInput,
    ConsumeResult,
    ExpiringBucket,
    IdGen,
    LedgerEntry,
    LedgerKind,
    LedgerSource,
    NewLedgerEntry,
    Notification,
    Operation,
    PaymentKitError,
    Pool,
)

T = TypeVar("T")

_MISSING = object()

# ── Generic table ─────────────────────────────────────────────────────────────────────────


class MemTable(Generic[T]):
    """Shallow-equality filtered in-memory table. Mirrors ts memory.ts MemTable."""

    def __init__(self) -> None:
        self._rows: dict[str, T] = {}

    async def get(self, id: str) -> T | None:
        return self._rows.get(id)

    async def put(self, row: T) -> T:
        self._rows[row.id] = row  # type: ignore[attr-defined]
        return row

    async def list(self, **filter: Any) -> list[T]:
        rows = list(self._rows.values())
        if not filter:
            return rows
        return [
            row
            for row in rows
            if all(getattr(row, k, _MISSING) == v for k, v in filter.items())
        ]


class VersionedMemTable(MemTable[T]):
    """EC:K1 -- optimistic-locking table for rows that carry a `version`.

    `put` rejects a write whose `version` is not the stored one with
    `PaymentKitError('subscription_version_conflict')`, so an upgrade racing a renewal webhook fails
    loudly instead of silently losing one of the two writes. The caller's object is bumped in place
    as well, so a function that reads once and writes twice keeps working; only two INDEPENDENT
    readers collide.
    """

    async def put(self, row: T) -> T:
        existing = await self.get(row.id)  # type: ignore[attr-defined]
        if existing is not None and existing.version != row.version:
            raise PaymentKitError(
                f"stale write to {row.id}: expected version {existing.version}, "
                f"got {row.version}",
                "subscription_version_conflict",
                {"id": row.id, "expected": existing.version, "got": row.version},
            )
        row.version = row.version + 1 if existing is not None else row.version
        return await super().put(row)


class OperationMemTable(MemTable[Operation]):
    """Claim without yielding between inspection and storage."""

    async def claim(self, row: Operation) -> Operation | None:
        existing = self._rows.get(row.key)
        if existing is not None and (existing.status != "failed" or existing.payload_hash != row.payload_hash):
            return None
        claimed = dataclasses.replace(row, kind=existing.kind if existing else row.kind, status="in_progress", result=None, error=None, completed_at=None, created_at=existing.created_at if existing else row.created_at, attempts=existing.attempts + 1 if existing else 1)
        self._rows[row.key] = claimed
        return claimed

    async def compare_and_set(self, expected: Operation, next_row: Operation) -> bool:
        """EC:A48 -- write only if status and result are unchanged, with no await in between."""
        current = self._rows.get(expected.key)
        if current is None or current.status != expected.status or current.result != expected.result:
            return False
        self._rows[expected.key] = dataclasses.replace(next_row, key=expected.key, id=expected.key)
        return True


class InMemoryRepo:
    def __init__(self) -> None:
        self.customers: MemTable[Any] = MemTable()
        self.plans: MemTable[Any] = MemTable()
        self.subscriptions: VersionedMemTable[Any] = VersionedMemTable()
        self.payments: MemTable[Any] = MemTable()
        self.usage_events: MemTable[Any] = MemTable()
        self.refunds: MemTable[Any] = MemTable()
        self.cs_cases: MemTable[Any] = MemTable()
        self.webhook_events: MemTable[Any] = MemTable()
        self.outbox: MemTable[Any] = MemTable()
        self.operations = OperationMemTable()  # EC:J1-J5


class NoopNotifier:
    async def send(self, n: Notification) -> None:
        return None


class CollectingNotifier:
    def __init__(self) -> None:
        self.sent: list[Notification] = []

    async def send(self, n: Notification) -> None:
        self.sent.append(n)


# ── Ledger ────────────────────────────────────────────────────────────────────────────────


class _Bucket:
    __slots__ = ("expires_at", "pool", "remaining")

    def __init__(self, pool: str, expires_at: datetime | None, remaining: int) -> None:
        self.pool = pool
        self.expires_at = expires_at
        self.remaining = remaining


class InMemoryLedger:
    # EC:I9 finding (2026-09-09, 3rd time independently: refund.evaluate FINDINGS#1, a dispute
    # regression test, cs.timeline) -- append()'s created_at used to always be wall-clock time
    # (datetime.now(UTC)), ignoring whatever Clock the caller injected everywhere else. Defaults
    # to SystemClock (unchanged behavior for every existing InMemoryLedger(ids) call site) -- pass
    # a FixedClock explicitly for deterministic tests.
    def __init__(self, ids: IdGen | None = None, clock: Clock | None = None) -> None:
        self._ids: IdGen = ids or UuidIdGen()
        self._clock: Clock = clock or SystemClock()
        self._entries_by_customer: dict[str, list[LedgerEntry]] = {}
        self._by_idempotency_key: dict[tuple[str, str], LedgerEntry] = {}
        self._consume_results: dict[tuple[str, str], ConsumeResult] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        # Reentrant per customer, like the Postgres store: a ledger call made inside transaction()
        # for the same customer (e.g. usage.commit calling consume) joins it instead of deadlocking.
        self._held: contextvars.ContextVar[frozenset[str]] = contextvars.ContextVar(
            f"inmemory_ledger_held_{id(self)}", default=frozenset()
        )

    def _lock_for(self, customer_id: str) -> asyncio.Lock:
        lock = self._locks.get(customer_id)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[customer_id] = lock
        return lock

    async def transaction(self, customer_id: str, fn: Callable[[], Awaitable[T]]) -> T:
        held = self._held.get()
        if customer_id in held:
            return await fn()
        async with self._lock_for(customer_id):
            token = self._held.set(held | {customer_id})
            try:
                return await fn()
            finally:
                self._held.reset(token)

    # EC:B12 B20 — (customer_id, idempotency_key) is unique; a re-append by the same customer returns
    # the existing row. Another customer's identical key is a different operation.
    async def append(self, entry: NewLedgerEntry) -> AppendResult:
        existing = self._by_idempotency_key.get((entry.customer_id, entry.idempotency_key))
        if existing is not None:
            return AppendResult(entry=existing, duplicated=True)
        row = LedgerEntry(
            id=self._ids.new_id(),
            created_at=self._clock.now(),
            customer_id=entry.customer_id,
            pool=entry.pool,
            kind=entry.kind,
            amount=entry.amount,
            source=entry.source,
            idempotency_key=entry.idempotency_key,
            actor=entry.actor,
            reference=entry.reference,
            unit_price_minor=entry.unit_price_minor,
            currency=entry.currency,
            expires_at=entry.expires_at,
            reason=entry.reason,
        )
        bucket = self._entries_by_customer.setdefault(entry.customer_id, [])
        bucket.append(row)
        self._by_idempotency_key[(entry.customer_id, entry.idempotency_key)] = row
        return AppendResult(entry=row, duplicated=False)

    async def entries(
        self,
        customer_id: str,
        *,
        pool: Pool | None = None,
        kind: LedgerKind | None = None,
        since: datetime | None = None,
        source: LedgerSource | None = None,
    ) -> list[LedgerEntry]:
        all_entries = self._entries_by_customer.get(customer_id, [])
        return [
            e
            for e in all_entries
            if (pool is None or e.pool == pool)
            and (kind is None or e.kind == kind)
            and (since is None or e.created_at >= since)
            and (source is None or e.source == source)
        ]

    # EC:B14 — builds per-grant remaining buckets; expiry is filtered by the caller (balance/consume) using `now`.
    def _build_buckets(
        self, customer_id: str, pool: Pool | None = None
    ) -> dict[str, _Bucket]:
        all_entries = self._entries_by_customer.get(customer_id, [])
        buckets: dict[str, _Bucket] = {}
        for e in all_entries:
            if e.kind == "grant":
                buckets[e.id] = _Bucket(
                    pool=e.pool, expires_at=e.expires_at, remaining=e.amount
                )
        for e in all_entries:
            if e.kind == "grant":
                continue
            grant_id = e.reference.grant_id
            if grant_id and grant_id in buckets:
                buckets[grant_id].remaining += e.amount
        if pool is not None:
            buckets = {k: b for k, b in buckets.items() if b.pool == pool}
        return buckets

    def _unbucketed_total(self, customer_id: str, pool: Pool | None = None) -> int:
        """Entries not tied to a specific grant bucket (manual adjustments, negative-balance overflow draws)."""
        all_entries = self._entries_by_customer.get(customer_id, [])
        total = 0
        for e in all_entries:
            if e.kind == "grant":
                continue
            if e.reference.grant_id:
                continue
            if pool is not None and e.pool != pool:
                continue
            total += e.amount
        return total

    def _held_total(self, customer_id: str, pool: Pool | None = None) -> int:
        all_entries = self._entries_by_customer.get(customer_id, [])
        total = 0
        for e in all_entries:
            if pool is not None and e.pool != pool:
                continue
            if e.kind in ("hold", "release"):
                total += e.amount
        return (
            -total
        )  # hold is negative, release is positive; outstanding held = -(net)

    # EC:B14 -- `now` is required (see LedgerStore.balance doc comment in types.py).
    async def balance(
        self, customer_id: str, pool: Pool | None, now: datetime
    ) -> Balance:
        buckets = self._build_buckets(customer_id, pool)
        available = self._unbucketed_total(customer_id, pool)
        expiring_map: dict[datetime, int] = {}
        for b in buckets.values():
            if b.expires_at is not None and b.expires_at <= now:  # EC:B14
                continue
            available += b.remaining
            if b.expires_at is not None and b.remaining > 0:
                expiring_map[b.expires_at] = (
                    expiring_map.get(b.expires_at, 0) + b.remaining
                )
        expiring = [
            ExpiringBucket(expires_at=t, amount=a)
            for t, a in sorted(expiring_map.items())
        ]
        return Balance(
            customer_id=customer_id,
            pool=pool or "all",
            available=available,
            held=self._held_total(customer_id, pool),
            expiring=expiring,
        )

    # EC:B5 atomic · EC:B3 order (pool_order + within-pool expiring-first) · EC:B4 negative-balance policy
    # · EC:B12 idempotent (whole call cached by idempotency_key) · EC:B14 expiry filtered at consume time.
    async def consume(self, input: ConsumeInput) -> ConsumeResult:
        async def _do() -> ConsumeResult:
            cached = self._consume_results.get((input.customer_id, input.idempotency_key))
            if cached is not None:
                return ConsumeResult(
                    ok=cached.ok,
                    entries=cached.entries,
                    shortfall=cached.shortfall,
                    duplicated=True,
                )

            now = input.now
            remaining = input.amount
            plan: list[
                tuple[str, int, str | None]
            ] = []  # (pool, signed_amount, grant_id)

            for pool in input.pool_order:
                if remaining <= 0:
                    break
                buckets = self._build_buckets(input.customer_id, pool)
                candidates = [
                    (gid, b)
                    for gid, b in buckets.items()
                    if (b.expires_at is None or b.expires_at > now) and b.remaining > 0
                ]
                candidates.sort(
                    key=lambda item: (
                        item[1].expires_at or datetime.max.replace(tzinfo=UTC)
                    )
                )
                for grant_id, b in candidates:
                    if remaining <= 0:
                        break
                    draw = min(b.remaining, remaining)
                    if draw <= 0:
                        continue
                    plan.append((pool, -draw, grant_id))
                    remaining -= draw

            ok = True
            shortfall = 0
            if remaining > 0:
                overflow_pool: str = (
                    input.pool_order[-1] if input.pool_order else "paid"
                )
                if input.negative_balance == "allow_unbounded":
                    plan.append((overflow_pool, -remaining, None))
                    remaining = 0
                elif input.negative_balance == "allow_to_floor":
                    current_total = (
                        await self.balance(input.customer_id, None, now)
                    ).available
                    drawn_so_far = (
                        input.amount - remaining
                    )  # already planned from buckets (spec EC:B5 step 4)
                    room = current_total - drawn_so_far - input.negative_floor
                    allowed = max(0, room)
                    if remaining <= allowed:
                        plan.append((overflow_pool, -remaining, None))
                        remaining = 0
                    else:
                        ok = False
                        shortfall = remaining - allowed
                else:
                    ok = False
                    shortfall = remaining

            if not ok:
                result = ConsumeResult(
                    ok=False, entries=[], shortfall=shortfall, duplicated=False
                )
                self._consume_results[(input.customer_id, input.idempotency_key)] = result
                return result

            # EC:B21 -- a row key already taken by another operation (a grant appended with 'k#0',
            # say) must not be answered with that row: refuse before writing anything.
            for i in range(len(plan)):
                if (input.customer_id, f"{input.idempotency_key}#{i}") in self._by_idempotency_key:
                    raise PaymentKitError(
                        f"idempotency key {input.idempotency_key} collides with an existing ledger row",
                        "idempotency_key_conflict",
                    )
            written: list[LedgerEntry] = []
            for i, (pool, amount, grant_id) in enumerate(plan):
                # EC:L5 -- replace(), do not re-list: a field whitelist here silently drops
                # anything added to LedgerReference later (correlation_id was dropped exactly this
                # way). consume() owns grant_id.
                ref = dataclasses.replace(input.meta, grant_id=grant_id)
                appended = await self.append(
                    NewLedgerEntry(
                        customer_id=input.customer_id,
                        pool=pool,
                        kind="consume",
                        amount=amount,
                        source="usage",
                        idempotency_key=f"{input.idempotency_key}#{i}",
                        actor=input.actor,
                        reference=ref,
                        reason=input.reason,
                    )
                )
                written.append(appended.entry)

            result = ConsumeResult(
                ok=True, entries=written, shortfall=0, duplicated=False
            )
            self._consume_results[(input.customer_id, input.idempotency_key)] = result
            return result

        return await self.transaction(input.customer_id, _do)
