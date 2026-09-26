// EC:L1-L5 (docs/EDGE_CASES.md §L) — durable audit trail. `PostgresLogger` implements core's
// `Logger` (via `BaseLogger`, so every entry is already redacted — EC:L2 — before `write()` ever
// sees it) and writes one row per `log()` call to `audit_log` (sql/0001_core.sql). Deliberately
// NOT part of `Repo`/`PostgresRepo` — its own store, so the CS timeline module (packages/cs) can
// query it independently of the domain repo. Mirrors
// packages/schema-postgres/py/src/boilpayment_schema_postgres/audit_log.py exactly.
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { BaseLogger } from 'boilpayment-core';
import type { LogEntry } from 'boilpayment-core';
import { jsonb } from './mapping.js';
import { runner } from './tx.js';

export class PostgresLogger extends BaseLogger {
  constructor(private readonly pool: Pool) {
    super();
  }

  protected async write(entry: LogEntry & { at: Date }): Promise<void> {
    const { level, event, at, ...fields } = entry;
    const customerId = fields.customerId as string | undefined;
    const paymentId = fields.paymentId as string | undefined;
    const subscriptionId = fields.subscriptionId as string | undefined;
    const caseId = fields.caseId as string | undefined;
    const correlationId = fields.correlationId as string | undefined;
    // customer_id/payment_id/subscription_id/case_id/correlation_id are promoted to real columns
    // for indexed lookups (EC:L1-L5); they stay in `fields` too so the jsonb blob is self-contained.
    const client = runner(this.pool, customerId);
    await client.query(
      `insert into audit_log
         (id, at, level, event, customer_id, payment_id, subscription_id, case_id, correlation_id, fields)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        randomUUID(),
        at,
        level,
        event,
        customerId ?? null,
        paymentId ?? null,
        subscriptionId ?? null,
        caseId ?? null,
        correlationId ?? null,
        jsonb(fields),
      ],
    );
  }
}
