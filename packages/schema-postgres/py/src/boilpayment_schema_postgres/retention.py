"""EC:J4 L4 -- see spec/schema-postgres.pseudo.md [EC:J4 L4] "pruneRetention".

Deletes `operations` rows (status done/failed only -- never in_progress, EC:J4) older than
policy.retention.operation_days, and `audit_log` rows older than policy.retention.audit_log_days
(EC:L4). Runs in bounded batches so a large backlog cannot hold a table lock for minutes.
NEVER touches `ledger_entries` -- the ledger is retained indefinitely (EC:H2/H3, 전자상거래법
5-year record-keeping requirement); pruning it is out of scope on purpose, forever.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from boilpayment_core import Clock, Policy

from .tx import connection

_OPERATIONS_COUNT_SQL = (
    "select count(*)::int as n from operations "
    "where status in ('done','failed') and kind not in ('checkout.entitlement','purchase.entitlement','refund.provider') and created_at < %s"
)
# EC:J4 -- status in ('done','failed') never matches 'in_progress'; ORDER BY + LIMIT bounds the
# batch, subselect on PK (key) avoids DELETE ... LIMIT (not supported directly by Postgres).
_OPERATIONS_DELETE_SQL = """
    delete from operations
    where key in (
        select key from operations
        where status in ('done','failed') and kind not in ('checkout.entitlement','purchase.entitlement','refund.provider') and created_at < %s
        order by created_at asc
        limit %s
    )
"""

_AUDIT_LOG_COUNT_SQL = "select count(*)::int as n from audit_log where at < %s"
_AUDIT_LOG_DELETE_SQL = """
    delete from audit_log
    where id in (
        select id from audit_log
        where at < %s
        order by at asc
        limit %s
    )
"""


@dataclass(kw_only=True, slots=True)
class PruneRetentionResult:
    operations_deleted: int
    audit_log_deleted: int


async def _count_older_than(dsn: str, sql: str, cutoff: datetime) -> int:
    async with connection(dsn) as conn, conn.cursor() as cur:
        await cur.execute(sql, (cutoff,))
        row = await cur.fetchone()
        return int(row["n"]) if row else 0


async def _delete_in_batches(
    dsn: str, sql: str, cutoff: datetime, batch_size: int
) -> int:
    total = 0
    while True:
        async with connection(dsn) as conn, conn.cursor() as cur:
            await cur.execute(sql, (cutoff, batch_size))
            n = cur.rowcount or 0
        total += n
        if n < batch_size:  # fewer than a full batch => nothing left to delete
            break
    return total


# EC:J4 L4 -- see spec/schema-postgres.pseudo.md [EC:J4 L4].
async def prune_retention(
    *,
    dsn: str,
    policy: Policy,
    clock: Clock,
    dry_run: bool = False,
    batch_size: int = 1000,
) -> PruneRetentionResult:
    now = clock.now()
    operations_cutoff = now - timedelta(days=policy.retention.operation_days)
    audit_log_cutoff = now - timedelta(days=policy.retention.audit_log_days)

    if dry_run:
        operations_deleted = await _count_older_than(
            dsn, _OPERATIONS_COUNT_SQL, operations_cutoff
        )
        audit_log_deleted = await _count_older_than(
            dsn, _AUDIT_LOG_COUNT_SQL, audit_log_cutoff
        )
        return PruneRetentionResult(
            operations_deleted=operations_deleted, audit_log_deleted=audit_log_deleted
        )

    operations_deleted = await _delete_in_batches(
        dsn, _OPERATIONS_DELETE_SQL, operations_cutoff, batch_size
    )
    audit_log_deleted = await _delete_in_batches(
        dsn, _AUDIT_LOG_DELETE_SQL, audit_log_cutoff, batch_size
    )
    return PruneRetentionResult(
        operations_deleted=operations_deleted, audit_log_deleted=audit_log_deleted
    )
