// PostgresRepo implements boilpayment-core Repo.
// Most tables are a straight 1:1 column mirror via the generic PgTable. Two are not:
//   - plans: Plan.prices is a child table (plan_prices) — hand-written join.
//   - csCases: CsCase.policySnapshot (embedded Policy) is normalized to policy_snapshots — hand-written join.
// See spec/schema-postgres.pseudo.md "Normalization note".
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { PaymentKitError } from 'boilpayment-core';
import type {
  Customer,
  CsCase,
  CsCaseKind,
  CsCaseStatus,
  Operation,
  OperationStatus,
  OperationTable,
  OutboxItem,
  Payment,
  Plan,
  PlanPrice,
  Policy,
  ProviderName,
  Refund,
  Repo,
  Subscription,
  Table,
  UsageEvent,
  WebhookEventRecord,
} from 'boilpayment-core';
import { camelToSnake, jsonb, PgTable } from './mapping.js';
import { runner } from './tx.js';

const customersTable = (pool: Pool) =>
  new PgTable<Customer>(pool, 'customers', {
    toRow: (c) => ({
      id: c.id,
      email: c.email,
      provider_refs: jsonb(c.providerRefs),
      status: c.status,
      created_at: c.createdAt,
    }),
    fromRow: (r) => ({
      id: r.id as string,
      email: (r.email as string) ?? null,
      providerRefs: (r.provider_refs as { provider: ProviderName; ref: string }[]) ?? [],
      status: r.status as Customer['status'],
      createdAt: new Date(r.created_at as string),
    }),
  });

function subscriptionToRow(s: Subscription): Record<string, unknown> {
  return {
    id: s.id,
    customer_id: s.customerId,
    plan_id: s.planId,
    provider: s.provider,
    provider_ref: s.providerRef,
    status: s.status,
    period_start: s.currentPeriod.start,
    period_end: s.currentPeriod.end,
    anchor_day: s.anchorDay,
    cancel_at_period_end: s.cancelAtPeriodEnd,
    grace_until: s.graceUntil,
    billing_key: s.billingKey,
    scheduled_plan_id: s.scheduledPlanId,
    currency: s.currency ?? null, // EC:A28
    version: s.version ?? 0,
    created_at: s.createdAt,
  };
}

function rowToSubscription(r: Record<string, unknown>): Subscription {
  return {
    id: r.id as string,
    customerId: r.customer_id as string,
    planId: r.plan_id as string,
    provider: r.provider as ProviderName,
    providerRef: (r.provider_ref as string) ?? null,
    status: r.status as Subscription['status'],
    currentPeriod: { start: new Date(r.period_start as string), end: new Date(r.period_end as string) },
    anchorDay: Number(r.anchor_day),
    cancelAtPeriodEnd: r.cancel_at_period_end as boolean,
    graceUntil: r.grace_until ? new Date(r.grace_until as string) : null,
    billingKey: (r.billing_key as string) ?? null,
    scheduledPlanId: (r.scheduled_plan_id as string) ?? null,
    ...(r.currency ? { currency: r.currency as string } : {}), // EC:A28 — absent on rows without one
    version: Number(r.version ?? 0), // EC:K1
    createdAt: new Date(r.created_at as string),
  };
}

/**
 * EC:K1 — optimistic-locking table for `subscriptions`, mirroring the semantics of
 * `VersionedMemTable` (packages/core/ts/src/memory.ts) exactly:
 *   - `put` on a row that doesn't exist yet -> plain INSERT, `version` stored as given (normally 0).
 *   - `put` on an existing row -> `UPDATE ... SET version = version + 1 WHERE id = $id AND version =
 *     $expected`. If that affects 0 rows we re-read to tell "row vanished since caller read it"
 *     (can't happen in practice — subscriptions are never deleted — but handled the same as a
 *     conflict for safety) apart from "someone else already bumped the version" and throw
 *     `PaymentKitError('subscription_version_conflict', { id, expected, got })`.
 *   - On success the caller's `row.version` is bumped in place (like `VersionedMemTable`), so a
 *     function that reads once and writes twice via the SAME object keeps working; only two
 *     INDEPENDENT reads of the same row racing each other collide.
 * See spec/schema-postgres.pseudo.md [EC:K1].
 */
class SubscriptionsTable implements Table<Subscription> {
  constructor(private readonly pool: Pool) {}

  private client(): Pool | PoolClient {
    return runner(this.pool);
  }

  async get(id: string): Promise<Subscription | null> {
    const res = await this.client().query('select * from subscriptions where id = $1', [id]);
    return res.rows[0] ? rowToSubscription(res.rows[0]) : null;
  }

  async put(row: Subscription): Promise<Subscription> {
    const client = this.client();
    const data = subscriptionToRow(row);
    const updateCols = Object.keys(data).filter((c) => c !== 'id' && c !== 'version');
    const updateSql =
      `update subscriptions set ${updateCols.map((c, i) => `${c} = $${i + 1}`).join(', ')}, version = version + 1 ` +
      `where id = $${updateCols.length + 1} and version = $${updateCols.length + 2} returning *`;
    const updateParams = [...updateCols.map((c) => data[c]), row.id, row.version];
    const updateRes = await client.query(updateSql, updateParams);

    if (updateRes.rows[0]) {
      const updated = rowToSubscription(updateRes.rows[0]);
      row.version = updated.version; // keep the caller's handle usable for a follow-up put
      return updated;
    }

    // 0 rows affected by the UPDATE: either the row doesn't exist yet (first put) or the version
    // the caller read is stale. Re-read to tell the two apart.
    const existingRes = await client.query('select * from subscriptions where id = $1', [row.id]);
    if (!existingRes.rows[0]) {
      // Row genuinely absent -> insert. `on conflict (id) do nothing` guards a race where another
      // concurrent put() inserted the same id between our UPDATE attempt and this INSERT.
      const cols = Object.keys(data);
      const insertSql =
        `insert into subscriptions (${cols.join(', ')}) values (${cols.map((_c, i) => `$${i + 1}`).join(', ')}) ` +
        `on conflict (id) do nothing returning *`;
      const insertRes = await client.query(insertSql, cols.map((c) => data[c]));
      if (insertRes.rows[0]) {
        const inserted = rowToSubscription(insertRes.rows[0]);
        row.version = inserted.version;
        return inserted;
      }
      // Lost the insert race — someone else created this id concurrently. Report as a conflict
      // against whatever they wrote, same as the stale-version path below.
      const racedRes = await client.query('select * from subscriptions where id = $1', [row.id]);
      const raced = rowToSubscription(racedRes.rows[0]);
      throw new PaymentKitError(
        `stale write to ${row.id}: expected version ${raced.version}, got ${row.version}`,
        'subscription_version_conflict',
        { id: row.id, expected: raced.version, got: row.version },
      );
    }

    const existing = rowToSubscription(existingRes.rows[0]);
    throw new PaymentKitError(
      `stale write to ${row.id}: expected version ${existing.version}, got ${row.version}`,
      'subscription_version_conflict',
      { id: row.id, expected: existing.version, got: row.version },
    );
  }

  async list(filter?: Partial<Subscription>): Promise<Subscription[]> {
    let sql = 'select * from subscriptions';
    const params: unknown[] = [];
    const entries = Object.entries(filter ?? {}).filter(([, v]) => v !== undefined);
    if (entries.length) {
      const clauses = entries.map(([k, v]) => {
        params.push(v);
        return `${camelToSnake(k)} = $${params.length}`;
      });
      sql += ` where ${clauses.join(' and ')}`;
    }
    const res = await this.client().query(sql, params);
    return res.rows.map((r: Record<string, unknown>) => rowToSubscription(r));
  }
}

const subscriptionsTable = (pool: Pool): Table<Subscription> => new SubscriptionsTable(pool);

const paymentsTable = (pool: Pool) =>
  new PgTable<Payment>(pool, 'payments', {
    toRow: (p) => ({
      id: p.id,
      customer_id: p.customerId,
      provider: p.provider,
      provider_ref: p.providerRef,
      subscription_id: p.subscriptionId,
      amount_minor: p.amount.amountMinor,
      currency: p.amount.currency,
      status: p.status,
      kind: p.kind,
      period_start: p.period?.start ?? null,
      period_end: p.period?.end ?? null,
      occurred_at: p.occurredAt,
      failure: jsonb(p.failure),
      cash_receipt: jsonb(p.cashReceipt ?? null), // EC:K2-K7
      raw: jsonb(p.raw ?? null),
    }),
    fromRow: (r) => ({
      id: r.id as string,
      customerId: r.customer_id as string,
      provider: r.provider as ProviderName,
      providerRef: r.provider_ref as string,
      subscriptionId: (r.subscription_id as string) ?? null,
      amount: { amountMinor: Number(r.amount_minor), currency: r.currency as string },
      status: r.status as Payment['status'],
      kind: r.kind as Payment['kind'],
      period: r.period_start && r.period_end ? { start: new Date(r.period_start as string), end: new Date(r.period_end as string) } : null,
      occurredAt: new Date(r.occurred_at as string),
      failure: (r.failure as Payment['failure']) ?? null,
      cashReceipt: r.cash_receipt // EC:K2-K7 — jsonb stores issuedAt as an ISO string
        ? (() => { const c = r.cash_receipt as { receiptKey: string; issuedAt: string; type: 'personal' | 'business' }; return { receiptKey: c.receiptKey, issuedAt: new Date(c.issuedAt), type: c.type }; })()
        : null,
      raw: r.raw ?? undefined,
    }),
  });

const usageEventsTable = (pool: Pool) =>
  new PgTable<UsageEvent>(pool, 'usage_events', {
    toRow: (u) => ({
      id: u.id,
      customer_id: u.customerId,
      meter: u.meter,
      quantity: u.quantity,
      occurred_at: u.occurredAt,
      received_at: u.receivedAt,
      period_start: u.periodStart,
      idempotency_key: u.idempotencyKey,
      meta: jsonb(u.meta),
    }),
    fromRow: (r) => ({
      id: r.id as string,
      customerId: r.customer_id as string,
      meter: r.meter as string,
      quantity: Number(r.quantity),
      occurredAt: new Date(r.occurred_at as string),
      receivedAt: new Date(r.received_at as string),
      periodStart: new Date(r.period_start as string),
      idempotencyKey: r.idempotency_key as string,
      meta: (r.meta as Record<string, unknown>) ?? null,
    }),
  });

const refundsTable = (pool: Pool) =>
  new PgTable<Refund>(pool, 'refunds', {
    toRow: (r) => ({
      id: r.id,
      payment_id: r.paymentId,
      customer_id: r.customerId,
      amount_minor: r.amount.amountMinor,
      currency: r.amount.currency,
      status: r.status,
      provider_ref: r.providerRef,
      credits_revoked: r.creditsRevoked,
      rule_id: r.ruleId,
      reason: r.reason,
      failure: jsonb(r.failure),
    }),
    fromRow: (row) => ({
      id: row.id as string,
      paymentId: row.payment_id as string,
      customerId: row.customer_id as string,
      amount: { amountMinor: Number(row.amount_minor), currency: row.currency as string },
      status: row.status as Refund['status'],
      providerRef: (row.provider_ref as string) ?? null,
      creditsRevoked: Number(row.credits_revoked),
      ruleId: row.rule_id as string,
      reason: (row.reason as string) ?? null,
      failure: (row.failure as Refund['failure']) ?? null,
      createdAt: new Date(row.created_at as string),
    }),
  });

// EC:L3 — `raw_body` is stored EXACTLY as received, never redacted. Signature re-verification
// needs the provider's original bytes; redacting would make that impossible. Nothing derived from
// this table's raw_body is copied into a `Logger` event without going through redact() first
// (see packages/core logger.ts, docs/EDGE_CASES.md §L).
const webhookEventsTable = (pool: Pool) =>
  new PgTable<WebhookEventRecord>(pool, 'webhook_events', {
    toRow: (w) => ({
      id: w.id,
      provider: w.provider,
      type: w.type,
      status: w.status,
      raw_body: w.rawBody,
      headers: jsonb(w.headers),
      received_at: w.receivedAt,
      processed_at: w.processedAt,
      error: w.error,
      attempts: w.attempts,
      customer_id: w.customerId,
      payment_id: w.paymentId,
      subscription_id: w.subscriptionId,
      correlation_id: w.correlationId,
    }),
    fromRow: (r) => ({
      id: r.id as string,
      provider: r.provider as ProviderName,
      type: r.type as WebhookEventRecord['type'],
      status: r.status as WebhookEventRecord['status'],
      rawBody: r.raw_body as string,
      headers: (r.headers as Record<string, string>) ?? {},
      receivedAt: new Date(r.received_at as string),
      processedAt: r.processed_at ? new Date(r.processed_at as string) : null,
      error: (r.error as string) ?? null,
      attempts: Number(r.attempts),
      customerId: (r.customer_id as string) ?? null,
      paymentId: (r.payment_id as string) ?? null,
      subscriptionId: (r.subscription_id as string) ?? null,
      correlationId: (r.correlation_id as string) ?? null,
    }),
  });

const outboxTable = (pool: Pool) =>
  new PgTable<OutboxItem>(pool, 'outbox', {
    toRow: (o) => ({
      id: o.id,
      kind: o.kind,
      payload: jsonb(o.payload),
      status: o.status,
      attempts: o.attempts,
      next_attempt_at: o.nextAttemptAt,
      created_at: o.createdAt,
    }),
    fromRow: (r) => ({
      id: r.id as string,
      kind: r.kind as string,
      payload: (r.payload as Record<string, unknown>) ?? {},
      status: r.status as OutboxItem['status'],
      attempts: Number(r.attempts),
      nextAttemptAt: new Date(r.next_attempt_at as string),
      createdAt: new Date(r.created_at as string),
    }),
  });

// EC:J1-J5 — operations table PK is `key`, not `id`, so it doesn't fit the generic PgTable (which
// assumes an `id` column); hand-written like plans/csCases. Table<Operation>.get/put still take
// Operation.id, which always equals .key (see spec/core.pseudo.md [EC:J1 J2 J3 J4 J5]).
function rowToOperation(r: Record<string, unknown>): Operation {
  return {
    id: r.key as string,
    key: r.key as string,
    kind: r.kind as string,
    payloadHash: r.payload_hash as string,
    status: r.status as OperationStatus,
    result: (r.result as unknown) ?? null,
    error: (r.error as string) ?? null,
    createdAt: new Date(r.created_at as string),
    completedAt: r.completed_at ? new Date(r.completed_at as string) : null,
    attempts: Number(r.attempts ?? 1), // EC:I9
  };
}

const operationsTable = (pool: Pool): OperationTable => ({
  async claim(row: Operation): Promise<Operation | null> {
    const res = await runner(pool).query(
      `insert into operations (key, kind, payload_hash, status, result, error, created_at, completed_at, attempts)
       values ($1,$2,$3,'in_progress',null,null,$4,null,1)
       on conflict (key) do update set status = 'in_progress', result = null, error = null,
         completed_at = null, attempts = operations.attempts + 1
       where operations.status = 'failed' and operations.payload_hash = excluded.payload_hash
       returning *`,
      [row.key, row.kind, row.payloadHash, row.createdAt],
    );
    return res.rows[0] ? rowToOperation(res.rows[0]) : null;
  },
  // EC:A48 — compare and set in one statement: only a row still carrying the expected status and result
  // is updated, so two workers that read the same row cannot both take it over or release it.
  async compareAndSet(expected: Pick<Operation, 'key' | 'status' | 'result'>, next: Operation): Promise<boolean> {
    const res = await runner(pool).query(
      `update operations set status = $4, result = $5, error = $6, completed_at = $7
       where key = $1 and status = $2 and result is not distinct from $3::jsonb returning key`,
      [expected.key, expected.status, jsonb(expected.result ?? null), next.status, jsonb(next.result), next.error, next.completedAt],
    );
    return (res.rowCount ?? 0) > 0;
  },
  async get(id: string): Promise<Operation | null> {
    const res = await runner(pool).query('select * from operations where key = $1', [id]);
    return res.rows[0] ? rowToOperation(res.rows[0]) : null;
  },
  async put(row: Operation): Promise<Operation> {
    const res = await runner(pool).query(
      `insert into operations (key, kind, payload_hash, status, result, error, created_at, completed_at, attempts)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (key) do update set kind = excluded.kind, payload_hash = excluded.payload_hash,
         status = excluded.status, result = excluded.result, error = excluded.error, completed_at = excluded.completed_at,
         attempts = excluded.attempts
       returning *`,
      [row.key, row.kind, row.payloadHash, row.status, jsonb(row.result), row.error, row.createdAt, row.completedAt, row.attempts],
    );
    return rowToOperation(res.rows[0]);
  },
  async list(filter?: Partial<Operation>): Promise<Operation[]> {
    let sql = 'select * from operations';
    const params: unknown[] = [];
    const map: Record<string, string> = { key: 'key', kind: 'kind', status: 'status' };
    const entries = Object.entries(filter ?? {}).filter(([k, v]) => v !== undefined && k in map);
    if (entries.length) {
      const clauses = entries.map(([k, v]) => {
        params.push(v);
        return `${map[k]} = $${params.length}`;
      });
      sql += ` where ${clauses.join(' and ')}`;
    }
    const res = await runner(pool).query(sql, params);
    return res.rows.map(rowToOperation);
  },
});

function rowToPlan(row: Record<string, unknown>, priceRows: Record<string, unknown>[]): Plan {
  return {
    id: row.id as string,
    name: row.name as string,
    interval: (row.interval as Plan['interval']) ?? null,
    creditsPerPeriod: Number(row.credits_per_period),
    usageIncluded: Number(row.usage_included),
    trialDays: Number(row.trial_days),
    prices: priceRows.map(
      (p): PlanPrice => ({
        currency: p.currency as string,
        amountMinor: Number(p.amount_minor),
        providerPriceRefs: (p.provider_price_refs as PlanPrice['providerPriceRefs']) ?? undefined,
      }),
    ),
  };
}

class PlansTable implements Table<Plan> {
  constructor(private readonly pool: Pool) {}

  private client(): Pool | PoolClient {
    return runner(this.pool);
  }

  async get(id: string): Promise<Plan | null> {
    const client = this.client();
    const planRes = await client.query('select * from plans where id = $1', [id]);
    if (!planRes.rows[0]) return null;
    const pricesRes = await client.query('select * from plan_prices where plan_id = $1', [id]);
    return rowToPlan(planRes.rows[0], pricesRes.rows);
  }

  async put(plan: Plan): Promise<Plan> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `insert into plans (id, name, interval, credits_per_period, usage_included, trial_days)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (id) do update set name = excluded.name, interval = excluded.interval,
           credits_per_period = excluded.credits_per_period, usage_included = excluded.usage_included,
           trial_days = excluded.trial_days`,
        [plan.id, plan.name, plan.interval, plan.creditsPerPeriod, plan.usageIncluded, plan.trialDays],
      );
      await client.query('delete from plan_prices where plan_id = $1', [plan.id]);
      for (const price of plan.prices) {
        await client.query(
          `insert into plan_prices (plan_id, currency, amount_minor, provider_price_refs) values ($1,$2,$3,$4)`,
          [plan.id, price.currency, price.amountMinor, jsonb(price.providerPriceRefs ?? null)],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    return (await this.get(plan.id))!;
  }

  async list(filter?: Partial<Plan>): Promise<Plan[]> {
    const client = this.client();
    let sql = 'select * from plans';
    const params: unknown[] = [];
    if (filter?.id) {
      params.push(filter.id);
      sql += ` where id = $${params.length}`;
    }
    const planRows = await client.query(sql, params);
    const plans: Plan[] = [];
    for (const row of planRows.rows) {
      const pricesRes = await client.query('select * from plan_prices where plan_id = $1', [row.id]);
      plans.push(rowToPlan(row, pricesRes.rows));
    }
    return plans;
  }
}

// EC:I8 — dedup policy_snapshots by content hash so repeated identical snapshots share one row.
function policySnapshotId(policy: Policy): string {
  const hash = createHash('sha256').update(JSON.stringify(policy)).digest('hex').slice(0, 32);
  return `ps_${hash}`;
}

function rowToCsCase(r: Record<string, unknown>): CsCase {
  return {
    id: r.id as string,
    customerId: r.customer_id as string,
    kind: r.kind as CsCaseKind,
    status: r.status as CsCaseStatus,
    referenceId: r.reference_id as string,
    policySnapshot: r.snapshot_policy as Policy,
    decision: (r.decision as Record<string, unknown>) ?? null,
    churnReason: (r.churn_reason as string) ?? null,
    churnText: (r.churn_text as string) ?? null,
    openedAt: new Date(r.opened_at as string),
    resolvedAt: r.resolved_at ? new Date(r.resolved_at as string) : null,
    escalatedAt: r.escalated_at ? new Date(r.escalated_at as string) : null, // EC:I9
  };
}

class CsCasesTable implements Table<CsCase> {
  constructor(private readonly pool: Pool) {}

  private client(): Pool | PoolClient {
    return runner(this.pool);
  }

  private static readonly SELECT =
    'select c.*, ps.policy as snapshot_policy from cs_cases c join policy_snapshots ps on ps.id = c.policy_snapshot_id';

  async get(id: string): Promise<CsCase | null> {
    const res = await this.client().query(`${CsCasesTable.SELECT} where c.id = $1`, [id]);
    return res.rows[0] ? rowToCsCase(res.rows[0]) : null;
  }

  async put(cs: CsCase): Promise<CsCase> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const snapId = policySnapshotId(cs.policySnapshot);
      await client.query('insert into policy_snapshots (id, policy) values ($1,$2) on conflict (id) do nothing', [
        snapId,
        jsonb(cs.policySnapshot),
      ]);
      await client.query(
        `insert into cs_cases
           (id, customer_id, kind, status, reference_id, policy_snapshot_id, decision, churn_reason, churn_text, opened_at, resolved_at, escalated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         on conflict (id) do update set status = excluded.status, decision = excluded.decision,
           churn_reason = excluded.churn_reason, churn_text = excluded.churn_text, resolved_at = excluded.resolved_at,
           escalated_at = excluded.escalated_at`,
        [
          cs.id,
          cs.customerId,
          cs.kind,
          cs.status,
          cs.referenceId,
          snapId,
          jsonb(cs.decision),
          cs.churnReason,
          cs.churnText,
          cs.openedAt,
          cs.resolvedAt,
          cs.escalatedAt ?? null, // EC:I9 — optional on CsCase, must not pass `undefined` to pg
        ],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    return (await this.get(cs.id))!;
  }

  async list(filter?: Partial<CsCase>): Promise<CsCase[]> {
    let sql = CsCasesTable.SELECT;
    const params: unknown[] = [];
    const map: Record<string, string> = { customerId: 'c.customer_id', kind: 'c.kind', status: 'c.status', referenceId: 'c.reference_id' };
    const entries = Object.entries(filter ?? {}).filter(([k, v]) => v !== undefined && k in map);
    if (entries.length) {
      const clauses = entries.map(([k, v]) => {
        params.push(v);
        return `${map[k]} = $${params.length}`;
      });
      sql += ` where ${clauses.join(' and ')}`;
    }
    const res = await this.client().query(sql, params);
    return res.rows.map(rowToCsCase);
  }
}

export function createPostgresRepo(pool: Pool): Repo {
  return {
    customers: customersTable(pool),
    plans: new PlansTable(pool),
    subscriptions: subscriptionsTable(pool),
    payments: paymentsTable(pool),
    usageEvents: usageEventsTable(pool),
    refunds: refundsTable(pool),
    csCases: new CsCasesTable(pool),
    webhookEvents: webhookEventsTable(pool),
    outbox: outboxTable(pool),
    operations: operationsTable(pool),
  };
}

export class PostgresRepo implements Repo {
  readonly customers: Table<Customer>;
  readonly plans: Table<Plan>;
  readonly subscriptions: Table<Subscription>;
  readonly payments: Table<Payment>;
  readonly usageEvents: Table<UsageEvent>;
  readonly refunds: Table<Refund>;
  readonly csCases: Table<CsCase>;
  readonly webhookEvents: Table<WebhookEventRecord>;
  readonly outbox: Table<OutboxItem>;
  readonly operations: OperationTable;

  constructor(pool: Pool) {
    const repo = createPostgresRepo(pool);
    this.customers = repo.customers;
    this.plans = repo.plans;
    this.subscriptions = repo.subscriptions;
    this.payments = repo.payments;
    this.usageEvents = repo.usageEvents;
    this.refunds = repo.refunds;
    this.csCases = repo.csCases;
    this.webhookEvents = repo.webhookEvents;
    this.outbox = repo.outbox;
    this.operations = repo.operations;
  }
}
