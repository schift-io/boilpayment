// EC:J4 L4 — see spec/schema-postgres.pseudo.md [EC:J4 L4] "pruneRetention".
// Deletes `operations` rows (status done/failed only — never in_progress, EC:J4) older than
// policy.retention.operationDays, and `audit_log` rows older than policy.retention.auditLogDays
// (EC:L4). Runs in bounded batches so a large backlog cannot hold a table lock for minutes.
// NEVER touches `ledger_entries` — the ledger is retained indefinitely (EC:H2/H3, 전자상거래법
// 5-year record-keeping requirement); pruning it is out of scope on purpose, forever.
import type { Pool } from 'pg';
import type { Clock, Policy } from '@schift/payment-kit-core';

export interface PruneRetentionInput {
  pool: Pool;
  policy: Policy;
  clock: Clock;
  /** When true, computes and returns the counts that WOULD be deleted, without deleting anything. */
  dryRun?: boolean;
  /** Rows deleted per DELETE statement. Default 1000 — keeps each statement's lock window short. */
  batchSize?: number;
}

export interface PruneRetentionResult {
  operationsDeleted: number;
  auditLogDeleted: number;
}

async function countOlderThan(pool: Pool, sql: string, cutoff: Date): Promise<number> {
  const res = await pool.query(sql, [cutoff]);
  return Number(res.rows[0]?.n ?? 0);
}

async function deleteInBatches(pool: Pool, sql: string, cutoff: Date, batchSize: number): Promise<number> {
  let total = 0;
  for (;;) {
    const res = await pool.query(sql, [cutoff, batchSize]);
    const n = res.rowCount ?? 0;
    total += n;
    if (n < batchSize) break; // fewer than a full batch => nothing left to delete
  }
  return total;
}

const OPERATIONS_COUNT_SQL = `select count(*)::int as n from operations where status in ('done','failed') and kind not in ('checkout.entitlement','purchase.entitlement','refund.provider') and created_at < $1`;
// EC:J4 — status in ('done','failed') never matches 'in_progress'; ORDER BY + LIMIT bounds the
// batch, subselect on PK (key) avoids DELETE ... LIMIT (not supported directly by Postgres).
const OPERATIONS_DELETE_SQL = `
  delete from operations
  where key in (
    select key from operations
    where status in ('done','failed') and kind not in ('checkout.entitlement','purchase.entitlement','refund.provider') and created_at < $1
    order by created_at asc
    limit $2
  )`;

const AUDIT_LOG_COUNT_SQL = `select count(*)::int as n from audit_log where at < $1`;
const AUDIT_LOG_DELETE_SQL = `
  delete from audit_log
  where id in (
    select id from audit_log
    where at < $1
    order by at asc
    limit $2
  )`;

// EC:J4 L4 — see spec/schema-postgres.pseudo.md [EC:J4 L4].
export async function pruneRetention(input: PruneRetentionInput): Promise<PruneRetentionResult> {
  const { pool, policy, clock, dryRun = false, batchSize = 1000 } = input;
  const now = clock.now();
  const operationsCutoff = new Date(now.getTime() - policy.retention.operationDays * 86_400_000);
  const auditLogCutoff = new Date(now.getTime() - policy.retention.auditLogDays * 86_400_000);

  if (dryRun) {
    const [operationsDeleted, auditLogDeleted] = await Promise.all([
      countOlderThan(pool, OPERATIONS_COUNT_SQL, operationsCutoff),
      countOlderThan(pool, AUDIT_LOG_COUNT_SQL, auditLogCutoff),
    ]);
    return { operationsDeleted, auditLogDeleted };
  }

  const operationsDeleted = await deleteInBatches(pool, OPERATIONS_DELETE_SQL, operationsCutoff, batchSize);
  const auditLogDeleted = await deleteInBatches(pool, AUDIT_LOG_DELETE_SQL, auditLogCutoff, batchSize);
  return { operationsDeleted, auditLogDeleted };
}
