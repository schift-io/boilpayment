"""PostgresRepo implements boilpayment_core.Repo.

Most tables are a straight 1:1 column mirror via the generic PgTable. Two are not:
  - plans: Plan.prices is a child table (plan_prices) — hand-written join.
  - cs_cases: CsCase.policy_snapshot (embedded Policy) is normalized to policy_snapshots — hand-written join.
See spec/schema-postgres.pseudo.md "Normalization note".
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime
from typing import Any

from boilpayment_core import (
    CashReceiptRef,
    CsCase,
    Customer,
    Operation,
    OutboxItem,
    Payment,
    PaymentFailure,
    PaymentKitError,
    Period,
    Plan,
    PlanPrice,
    Policy,
    ProviderRef,
    Refund,
    Subscription,
    UsageEvent,
    WebhookEventRecord,
    policy_from_dict,
    policy_to_dict,
)

from .mapping import PgTable, camel_to_snake, json_safe, jsonb
from .tx import atomic, connection


def _customers_table(dsn: str) -> PgTable[Customer]:
    def to_row(c: Customer) -> dict[str, Any]:
        return {
            "id": c.id,
            "email": c.email,
            "provider_refs": jsonb(
                [{"provider": r.provider, "ref": r.ref} for r in c.provider_refs]
            ),
            "status": c.status,
            "created_at": c.created_at,
        }

    def from_row(r: dict[str, Any]) -> Customer:
        return Customer(
            id=r["id"],
            email=r["email"],
            provider_refs=[
                ProviderRef(provider=p["provider"], ref=p["ref"])
                for p in (r["provider_refs"] or [])
            ],
            status=r["status"],
            created_at=r["created_at"],
        )

    return PgTable(dsn, "customers", to_row, from_row)


def _subscription_to_row(s: Subscription) -> dict[str, Any]:
    return {
        "id": s.id,
        "customer_id": s.customer_id,
        "plan_id": s.plan_id,
        "provider": s.provider,
        "provider_ref": s.provider_ref,
        "status": s.status,
        "period_start": s.current_period.start,
        "period_end": s.current_period.end,
        "anchor_day": s.anchor_day,
        "cancel_at_period_end": s.cancel_at_period_end,
        "grace_until": s.grace_until,
        "billing_key": s.billing_key,
        "scheduled_plan_id": s.scheduled_plan_id,
        "currency": s.currency,  # EC:A28
        "version": getattr(s, "version", 0) or 0,  # EC:K1
        "created_at": s.created_at,
    }


def _row_to_subscription(r: dict[str, Any]) -> Subscription:
    return Subscription(
        id=r["id"],
        customer_id=r["customer_id"],
        plan_id=r["plan_id"],
        provider=r["provider"],
        provider_ref=r["provider_ref"],
        status=r["status"],
        current_period=Period(start=r["period_start"], end=r["period_end"]),
        anchor_day=r["anchor_day"],
        cancel_at_period_end=r["cancel_at_period_end"],
        grace_until=r["grace_until"],
        billing_key=r["billing_key"],
        scheduled_plan_id=r["scheduled_plan_id"],
        currency=r.get("currency"),  # EC:A28
        version=int(r.get("version") or 0),  # EC:K1
        created_at=r["created_at"],
    )


def _cash_receipt(v: Any) -> CashReceiptRef | None:
    """EC:K2-K7 -- jsonb stores issued_at as an ISO string; rebuild the typed object."""
    if not v:
        return None
    issued = v["issued_at"]
    return CashReceiptRef(
        receipt_key=v["receipt_key"],
        issued_at=datetime.fromisoformat(issued) if isinstance(issued, str) else issued,
        type=v["type"],
    )


class SubscriptionsTable:
    """EC:K1 -- optimistic-locking table for `subscriptions`, mirroring `VersionedMemTable`
    (boilpayment_core.memory) and ts/src/repo.ts SubscriptionsTable exactly:

      - `put` on a row that doesn't exist yet -> plain INSERT, `version` stored as given (normally 0).
      - `put` on an existing row -> `UPDATE ... SET version = version + 1 WHERE id = %s AND version =
        %s`. If that affects 0 rows, re-read to tell "row vanished" (can't happen in practice --
        subscriptions are never deleted -- but handled the same as a conflict for safety) apart
        from "someone else already bumped the version", and raise
        `PaymentKitError('subscription_version_conflict', {id, expected, got})`.
      - On success the caller's `row.version` is bumped in place (dataclass is mutable, no
        `frozen=True`), so a function that reads once and writes twice via the SAME object keeps
        working; only two INDEPENDENT reads of the same row racing each other collide.
    See spec/schema-postgres.pseudo.md [EC:K1].
    """

    def __init__(self, dsn: str) -> None:
        self._dsn = dsn

    async def get(self, id: str) -> Subscription | None:
        async with connection(self._dsn) as conn, conn.cursor() as cur:
            await cur.execute("select * from subscriptions where id = %s", (id,))
            row = await cur.fetchone()
            return _row_to_subscription(row) if row else None

    async def put(self, row: Subscription) -> Subscription:
        data = _subscription_to_row(row)
        update_cols = [c for c in data if c not in ("id", "version")]
        set_clause = ", ".join(f"{c} = %s" for c in update_cols)
        update_sql = (
            f"update subscriptions set {set_clause}, version = version + 1 "
            f"where id = %s and version = %s returning *"
        )
        update_params = [data[c] for c in update_cols] + [row.id, row.version]

        async with connection(self._dsn) as conn, conn.cursor() as cur:
            await cur.execute(update_sql, update_params)
            updated_row = await cur.fetchone()

            if updated_row:
                updated = _row_to_subscription(updated_row)
                row.version = (
                    updated.version
                )  # keep the caller's handle usable for a follow-up put
                return updated

            # 0 rows affected: either the row doesn't exist yet (first put) or the version the
            # caller read is stale. Re-read to tell the two apart.
            await cur.execute("select * from subscriptions where id = %s", (row.id,))
            existing_row = await cur.fetchone()

            if not existing_row:
                # Row genuinely absent -> insert. `on conflict (id) do nothing` guards a race where
                # another concurrent put() inserted the same id between our UPDATE and this INSERT.
                cols = list(data.keys())
                placeholders = ", ".join(["%s"] * len(cols))
                insert_sql = (
                    f"insert into subscriptions ({', '.join(cols)}) values ({placeholders}) "
                    f"on conflict (id) do nothing returning *"
                )
                await cur.execute(insert_sql, [data[c] for c in cols])
                inserted_row = await cur.fetchone()
                if inserted_row:
                    inserted = _row_to_subscription(inserted_row)
                    row.version = inserted.version
                    return inserted
                # Lost the insert race -- someone else created this id concurrently.
                await cur.execute(
                    "select * from subscriptions where id = %s", (row.id,)
                )
                raced_row = await cur.fetchone()
                raced = _row_to_subscription(raced_row)
                raise PaymentKitError(
                    f"stale write to {row.id}: expected version {raced.version}, got {row.version}",
                    "subscription_version_conflict",
                    {"id": row.id, "expected": raced.version, "got": row.version},
                )

            existing = _row_to_subscription(existing_row)
            raise PaymentKitError(
                f"stale write to {row.id}: expected version {existing.version}, got {row.version}",
                "subscription_version_conflict",
                {"id": row.id, "expected": existing.version, "got": row.version},
            )

    async def list(self, **filter: Any) -> list[Subscription]:
        entries = [(k, v) for k, v in filter.items() if v is not None]
        sql = "select * from subscriptions"
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
            return [_row_to_subscription(r) for r in rows]


def _subscriptions_table(dsn: str) -> SubscriptionsTable:
    return SubscriptionsTable(dsn)


def _payments_table(dsn: str) -> PgTable[Payment]:
    def to_row(p: Payment) -> dict[str, Any]:
        failure = None
        if p.failure:
            failure = {
                "code": p.failure.code,
                "providerCode": p.failure.provider_code,
                "retryable": p.failure.retryable,
                "userMessage": p.failure.user_message,
            }
        return {
            "id": p.id,
            "customer_id": p.customer_id,
            "provider": p.provider,
            "provider_ref": p.provider_ref,
            "subscription_id": p.subscription_id,
            "amount_minor": p.amount.amount_minor,
            "currency": p.amount.currency,
            "status": p.status,
            "kind": p.kind,
            "period_start": p.period.start if p.period else None,
            "period_end": p.period.end if p.period else None,
            "occurred_at": p.occurred_at,
            "failure": jsonb(failure),
            "cash_receipt": jsonb(p.cash_receipt),  # EC:K2-K7
            "raw": jsonb(p.raw),
        }

    def from_row(r: dict[str, Any]) -> Payment:
        from boilpayment_core import Money

        failure = None
        if r["failure"]:
            f = r["failure"]
            failure = PaymentFailure(
                code=f["code"],
                provider_code=f.get("providerCode"),
                retryable=f["retryable"],
                user_message=f["userMessage"],
            )
        return Payment(
            id=r["id"],
            customer_id=r["customer_id"],
            provider=r["provider"],
            provider_ref=r["provider_ref"],
            subscription_id=r["subscription_id"],
            amount=Money(amount_minor=r["amount_minor"], currency=r["currency"]),
            status=r["status"],
            kind=r["kind"],
            period=Period(start=r["period_start"], end=r["period_end"])
            if r["period_start"] and r["period_end"]
            else None,
            occurred_at=r["occurred_at"],
            failure=failure,
            cash_receipt=_cash_receipt(r.get("cash_receipt")),  # EC:K2-K7
            raw=r["raw"],
        )

    return PgTable(dsn, "payments", to_row, from_row)


def _usage_events_table(dsn: str) -> PgTable[UsageEvent]:
    def to_row(u: UsageEvent) -> dict[str, Any]:
        return {
            "id": u.id,
            "customer_id": u.customer_id,
            "meter": u.meter,
            "quantity": u.quantity,
            "occurred_at": u.occurred_at,
            "received_at": u.received_at,
            "period_start": u.period_start,
            "idempotency_key": u.idempotency_key,
            "meta": jsonb(u.meta),
        }

    def from_row(r: dict[str, Any]) -> UsageEvent:
        return UsageEvent(
            id=r["id"],
            customer_id=r["customer_id"],
            meter=r["meter"],
            quantity=r["quantity"],
            occurred_at=r["occurred_at"],
            received_at=r["received_at"],
            period_start=r["period_start"],
            idempotency_key=r["idempotency_key"],
            meta=r["meta"],
        )

    return PgTable(dsn, "usage_events", to_row, from_row)


def _refunds_table(dsn: str) -> PgTable[Refund]:
    def to_row(r: Refund) -> dict[str, Any]:
        failure = None
        if r.failure:
            failure = {
                "code": r.failure.code,
                "providerCode": r.failure.provider_code,
                "retryable": r.failure.retryable,
                "userMessage": r.failure.user_message,
            }
        return {
            "id": r.id,
            "payment_id": r.payment_id,
            "customer_id": r.customer_id,
            "amount_minor": r.amount.amount_minor,
            "currency": r.amount.currency,
            "status": r.status,
            "provider_ref": r.provider_ref,
            "credits_revoked": r.credits_revoked,
            "rule_id": r.rule_id,
            "reason": r.reason,
            "failure": jsonb(failure),
        }

    def from_row(row: dict[str, Any]) -> Refund:
        from boilpayment_core import Money

        failure = None
        if row["failure"]:
            f = row["failure"]
            failure = PaymentFailure(
                code=f["code"],
                provider_code=f.get("providerCode"),
                retryable=f["retryable"],
                user_message=f["userMessage"],
            )
        return Refund(
            id=row["id"],
            payment_id=row["payment_id"],
            customer_id=row["customer_id"],
            amount=Money(amount_minor=row["amount_minor"], currency=row["currency"]),
            status=row["status"],
            provider_ref=row["provider_ref"],
            credits_revoked=row["credits_revoked"],
            rule_id=row["rule_id"],
            reason=row["reason"],
            failure=failure,
            created_at=row["created_at"],
        )

    return PgTable(dsn, "refunds", to_row, from_row)


# EC:L3 -- raw_body is stored EXACTLY as received, never redacted. Signature re-verification needs
# the provider's original bytes; redacting would make that impossible. Nothing derived from this
# table's raw_body is copied into a Logger event without going through redact() first (see
# packages/core logger.py, docs/EDGE_CASES.md §L).
def _webhook_events_table(dsn: str) -> PgTable[WebhookEventRecord]:
    def to_row(w: WebhookEventRecord) -> dict[str, Any]:
        return {
            "id": w.id,
            "provider": w.provider,
            "type": w.type,
            "status": w.status,
            "raw_body": w.raw_body,
            "headers": jsonb(w.headers),
            "received_at": w.received_at,
            "processed_at": w.processed_at,
            "error": w.error,
            "attempts": w.attempts,
            "customer_id": w.customer_id,
            "payment_id": w.payment_id,
            "subscription_id": w.subscription_id,
            "correlation_id": w.correlation_id,
        }

    def from_row(r: dict[str, Any]) -> WebhookEventRecord:
        return WebhookEventRecord(
            id=r["id"],
            provider=r["provider"],
            type=r["type"],
            status=r["status"],
            raw_body=r["raw_body"],
            headers=r["headers"] or {},
            received_at=r["received_at"],
            processed_at=r["processed_at"],
            error=r["error"],
            attempts=r["attempts"],
            customer_id=r.get("customer_id"),
            payment_id=r.get("payment_id"),
            subscription_id=r.get("subscription_id"),
            correlation_id=r.get("correlation_id"),
        )

    return PgTable(dsn, "webhook_events", to_row, from_row)


def _outbox_table(dsn: str) -> PgTable[OutboxItem]:
    def to_row(o: OutboxItem) -> dict[str, Any]:
        return {
            "id": o.id,
            "kind": o.kind,
            "payload": jsonb(o.payload),
            "status": o.status,
            "attempts": o.attempts,
            "next_attempt_at": o.next_attempt_at,
            "created_at": o.created_at,
        }

    def from_row(r: dict[str, Any]) -> OutboxItem:
        return OutboxItem(
            id=r["id"],
            kind=r["kind"],
            payload=r["payload"] or {},
            status=r["status"],
            attempts=r["attempts"],
            next_attempt_at=r["next_attempt_at"],
            created_at=r["created_at"],
        )

    return PgTable(dsn, "outbox", to_row, from_row)


# EC:J1-J5 — operations table PK is `key`, not `id`, so it doesn't fit the generic PgTable (which
# assumes an `id` column); hand-written like PlansTable/CsCasesTable. Operation.id always equals
# .key (see spec/core.pseudo.md [EC:J1 J2 J3 J4 J5]).
def _row_to_operation(r: dict[str, Any]) -> Operation:
    return Operation(
        id=r["key"],
        key=r["key"],
        kind=r["kind"],
        payload_hash=r["payload_hash"],
        status=r["status"],
        result=r["result"],
        error=r["error"],
        created_at=r["created_at"],
        completed_at=r["completed_at"],
        attempts=r.get("attempts") or 1,  # EC:I9
    )


class OperationsTable:
    def __init__(self, dsn: str) -> None:
        self._dsn = dsn

    async def claim(self, row: Operation) -> Operation | None:
        async with atomic(self._dsn) as conn, conn.cursor() as cur:
            await cur.execute(
                """insert into operations (key, kind, payload_hash, status, result, error, created_at, completed_at, attempts)
                values (%s,%s,%s,'in_progress',null,null,%s,null,1)
                on conflict (key) do update set status='in_progress', result=null, error=null,
                  completed_at=null, attempts=operations.attempts+1
                where operations.status='failed' and operations.payload_hash=excluded.payload_hash
                returning *""",
                (row.key, row.kind, row.payload_hash, row.created_at),
            )
            claimed = await cur.fetchone()
            return _row_to_operation(claimed) if claimed else None

    async def compare_and_set(self, expected: Operation, next_row: Operation) -> bool:
        """EC:A48 -- update only a row still carrying the expected status and result (one statement)."""
        async with atomic(self._dsn) as conn, conn.cursor() as cur:
            await cur.execute(
                """update operations set status=%s, result=%s, error=%s, completed_at=%s
                where key=%s and status=%s and result is not distinct from %s::jsonb returning key""",
                (next_row.status, jsonb(json_safe(next_row.result)), next_row.error, next_row.completed_at,
                 expected.key, expected.status, jsonb(json_safe(expected.result))),
            )
            return (await cur.fetchone()) is not None

    async def get(self, id: str) -> Operation | None:
        async with connection(self._dsn) as conn, conn.cursor() as cur:
            await cur.execute("select * from operations where key = %s", (id,))
            row = await cur.fetchone()
            return _row_to_operation(row) if row else None

    async def put(self, row: Operation) -> Operation:
        async with atomic(self._dsn) as conn, conn.cursor() as cur:
            await cur.execute(
                """
                insert into operations (key, kind, payload_hash, status, result, error, created_at, completed_at, attempts)
                values (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                on conflict (key) do update set kind=excluded.kind, payload_hash=excluded.payload_hash,
                  status=excluded.status, result=excluded.result, error=excluded.error, completed_at=excluded.completed_at,
                  attempts=excluded.attempts
                returning *
                """,
                (
                    row.key,
                    row.kind,
                    row.payload_hash,
                    row.status,
                    jsonb(json_safe(row.result)),
                    row.error,
                    row.created_at,
                    row.completed_at,
                    row.attempts,
                ),
            )
            result = await cur.fetchone()
            return _row_to_operation(result)

    async def list(self, **filter: Any) -> list[Operation]:
        field_map = {"key": "key", "kind": "kind", "status": "status"}
        sql = "select * from operations"
        params: list[Any] = []
        clauses = []
        for k, v in filter.items():
            if v is not None and k in field_map:
                params.append(v)
                clauses.append(f"{field_map[k]} = %s")
        if clauses:
            sql += " where " + " and ".join(clauses)
        async with connection(self._dsn) as conn, conn.cursor() as cur:
            await cur.execute(sql, params)
            rows = await cur.fetchall()
            return [_row_to_operation(r) for r in rows]


def _row_to_plan(row: dict[str, Any], price_rows: list[dict[str, Any]]) -> Plan:
    return Plan(
        id=row["id"],
        name=row["name"],
        interval=row["interval"],
        credits_per_period=row["credits_per_period"],
        usage_included=row["usage_included"],
        trial_days=row["trial_days"],
        prices=[
            PlanPrice(
                currency=p["currency"],
                amount_minor=p["amount_minor"],
                provider_price_refs=p["provider_price_refs"],
            )
            for p in price_rows
        ],
    )


class PlansTable:
    def __init__(self, dsn: str) -> None:
        self._dsn = dsn

    async def get(self, id: str) -> Plan | None:
        async with connection(self._dsn) as conn, conn.cursor() as cur:
            await cur.execute("select * from plans where id = %s", (id,))
            row = await cur.fetchone()
            if not row:
                return None
            await cur.execute("select * from plan_prices where plan_id = %s", (id,))
            prices = await cur.fetchall()
            return _row_to_plan(row, prices)

    async def put(self, plan: Plan) -> Plan:
        async with atomic(self._dsn) as conn, conn.cursor() as cur:
            await cur.execute(
                """
                insert into plans (id, name, interval, credits_per_period, usage_included, trial_days)
                values (%s,%s,%s,%s,%s,%s)
                on conflict (id) do update set name=excluded.name, interval=excluded.interval,
                  credits_per_period=excluded.credits_per_period, usage_included=excluded.usage_included,
                  trial_days=excluded.trial_days
                """,
                (
                    plan.id,
                    plan.name,
                    plan.interval,
                    plan.credits_per_period,
                    plan.usage_included,
                    plan.trial_days,
                ),
            )
            await cur.execute("delete from plan_prices where plan_id = %s", (plan.id,))
            for price in plan.prices:
                await cur.execute(
                    "insert into plan_prices (plan_id, currency, amount_minor, provider_price_refs) values (%s,%s,%s,%s)",
                    (
                        plan.id,
                        price.currency,
                        price.amount_minor,
                        jsonb(price.provider_price_refs),
                    ),
                )
        return await self.get(plan.id)  # type: ignore[return-value]

    async def list(self, **filter: Any) -> list[Plan]:
        async with connection(self._dsn) as conn, conn.cursor() as cur:
            sql = "select * from plans"
            params: list[Any] = []
            if filter.get("id"):
                sql += " where id = %s"
                params.append(filter["id"])
            await cur.execute(sql, params)
            plan_rows = await cur.fetchall()
            plans = []
            for row in plan_rows:
                await cur.execute(
                    "select * from plan_prices where plan_id = %s", (row["id"],)
                )
                prices = await cur.fetchall()
                plans.append(_row_to_plan(row, prices))
            return plans


def _policy_snapshot_id(policy: Policy) -> str:
    digest = hashlib.sha256(
        json.dumps(policy_to_dict(policy, camel=True), sort_keys=True).encode()
    ).hexdigest()[:32]
    return f"ps_{digest}"


_CS_SELECT = "select c.*, ps.policy as snapshot_policy from cs_cases c join policy_snapshots ps on ps.id = c.policy_snapshot_id"


def _row_to_cs_case(r: dict[str, Any]) -> CsCase:
    return CsCase(
        id=r["id"],
        customer_id=r["customer_id"],
        kind=r["kind"],
        status=r["status"],
        reference_id=r["reference_id"],
        policy_snapshot=policy_from_dict(r["snapshot_policy"]),
        decision=r["decision"],
        churn_reason=r["churn_reason"],
        churn_text=r["churn_text"],
        opened_at=r["opened_at"],
        resolved_at=r["resolved_at"],
        escalated_at=r.get("escalated_at"),  # EC:I9
    )


class CsCasesTable:
    def __init__(self, dsn: str) -> None:
        self._dsn = dsn

    async def get(self, id: str) -> CsCase | None:
        async with connection(self._dsn) as conn, conn.cursor() as cur:
            await cur.execute(f"{_CS_SELECT} where c.id = %s", (id,))
            row = await cur.fetchone()
            return _row_to_cs_case(row) if row else None

    async def put(self, cs: CsCase) -> CsCase:
        async with atomic(self._dsn) as conn, conn.cursor() as cur:
            snap_id = _policy_snapshot_id(cs.policy_snapshot)
            await cur.execute(
                "insert into policy_snapshots (id, policy) values (%s,%s) on conflict (id) do nothing",
                (snap_id, jsonb(policy_to_dict(cs.policy_snapshot, camel=True))),
            )
            await cur.execute(
                """
                insert into cs_cases
                  (id, customer_id, kind, status, reference_id, policy_snapshot_id, decision, churn_reason, churn_text, opened_at, resolved_at, escalated_at)
                values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                on conflict (id) do update set status=excluded.status, decision=excluded.decision,
                  churn_reason=excluded.churn_reason, churn_text=excluded.churn_text, resolved_at=excluded.resolved_at,
                  escalated_at=excluded.escalated_at
                """,
                (
                    cs.id,
                    cs.customer_id,
                    cs.kind,
                    cs.status,
                    cs.reference_id,
                    snap_id,
                    jsonb(json_safe(cs.decision)),
                    cs.churn_reason,
                    cs.churn_text,
                    cs.opened_at,
                    cs.resolved_at,
                    cs.escalated_at,  # EC:I9 — dataclass field defaults to None, never undefined
                ),
            )
        return await self.get(cs.id)  # type: ignore[return-value]

    async def list(self, **filter: Any) -> list[CsCase]:
        field_map = {
            "customer_id": "c.customer_id",
            "kind": "c.kind",
            "status": "c.status",
            "reference_id": "c.reference_id",
        }
        sql = _CS_SELECT
        params: list[Any] = []
        clauses = []
        for k, v in filter.items():
            if v is not None and k in field_map:
                params.append(v)
                clauses.append(f"{field_map[k]} = %s")
        if clauses:
            sql += " where " + " and ".join(clauses)
        async with connection(self._dsn) as conn, conn.cursor() as cur:
            await cur.execute(sql, params)
            rows = await cur.fetchall()
            return [_row_to_cs_case(r) for r in rows]


class PostgresRepo:
    """EC:B15 H4 + ARCHITECTURE.md §3.4 Repo. dsn: a libpq connection string / conninfo."""

    def __init__(self, dsn: str) -> None:
        self.customers = _customers_table(dsn)
        self.plans = PlansTable(dsn)
        self.subscriptions = _subscriptions_table(dsn)
        self.payments = _payments_table(dsn)
        self.usage_events = _usage_events_table(dsn)
        self.refunds = _refunds_table(dsn)
        self.cs_cases = CsCasesTable(dsn)
        self.webhook_events = _webhook_events_table(dsn)
        self.outbox = _outbox_table(dsn)
        self.operations = OperationsTable(dsn)
