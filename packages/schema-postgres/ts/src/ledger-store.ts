// PostgresLedgerStore implements boilpayment-core LedgerStore.
// EC:H3 — append-only: this store never issues UPDATE/DELETE on ledger_entries (trigger enforces it).
// EC:B1-B15 H3 H4 — see spec/schema-postgres.pseudo.md for the consume algorithm this mirrors 1:1.
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type {
  AppendResult,
  Balance,
  ConsumeInput,
  ConsumeResult,
  ExpiringBucket,
  LedgerEntry,
  LedgerKind,
  LedgerReference,
  LedgerSource,
  LedgerStore,
  NewLedgerEntry,
  Pool as CreditPool,
} from 'boilpayment-core';
import { PaymentKitError } from 'boilpayment-core';
import { jsonb } from './mapping.js';
import { runner, withCustomerTransaction } from './tx.js';

interface Runner {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

function referenceToJson(ref: LedgerReference | undefined): Record<string, unknown> {
  if (!ref) return {};
  const out: Record<string, unknown> = {};
  if (ref.subscriptionId !== undefined) out.subscriptionId = ref.subscriptionId;
  if (ref.periodStart !== undefined) out.periodStart = ref.periodStart ? new Date(ref.periodStart).toISOString() : ref.periodStart;
  if (ref.paymentId !== undefined) out.paymentId = ref.paymentId;
  if (ref.caseId !== undefined) out.caseId = ref.caseId;
  if (ref.grantId !== undefined) out.grantId = ref.grantId;
  if (ref.refundId !== undefined) out.refundId = ref.refundId;
  return out;
}

function jsonToReference(json: Record<string, unknown> | null): LedgerReference {
  const j = json ?? {};
  return {
    subscriptionId: (j.subscriptionId as string) ?? undefined,
    periodStart: j.periodStart ? new Date(j.periodStart as string) : undefined,
    paymentId: (j.paymentId as string) ?? undefined,
    caseId: (j.caseId as string) ?? undefined,
    grantId: (j.grantId as string) ?? undefined,
    refundId: (j.refundId as string) ?? undefined,
  };
}

function rowToLedgerEntry(row: Record<string, unknown>): LedgerEntry {
  return {
    id: row.id as string,
    customerId: row.customer_id as string,
    pool: row.pool as CreditPool,
    kind: row.kind as LedgerKind,
    amount: Number(row.amount),
    unitPriceMinor: row.unit_price_minor === null ? null : Number(row.unit_price_minor),
    currency: (row.currency as string) ?? null,
    expiresAt: row.expires_at ? new Date(row.expires_at as string) : null,
    source: row.source as LedgerSource,
    reference: jsonToReference(row.reference as Record<string, unknown>),
    idempotencyKey: row.idempotency_key as string,
    actor: row.actor as string,
    reason: (row.reason as string) ?? null,
    createdAt: new Date(row.created_at as string),
  };
}

function balanceRowToBalance(customerId: string, pool: CreditPool, row: Record<string, unknown> | undefined): Balance {
  const expiring = ((row?.expiring as { expiresAt: string; amount: number }[] | undefined) ?? []).map(
    (e): ExpiringBucket => ({ expiresAt: new Date(e.expiresAt), amount: Number(e.amount) }),
  );
  return {
    customerId,
    pool,
    available: row ? Number(row.available) : 0,
    held: row ? Number(row.held) : 0,
    expiring,
  };
}

/**
 * EC:B21 B22 — the rows an earlier consume with this key wrote. Rows since 0013 carry consume_key
 * (exact match). Rows written before it have consume_key null: the first row carried the key itself
 * and follow-up rows '<key>:<n>', all in one transaction (same created_at). So a legacy row keyed
 * 'job:1' that sits next to a 'job' row of the same transaction is a follow-up of 'job', not a
 * consume of its own; and a retry of 'job' gets all of its rows back.
 */
async function findConsume(client: Runner, customerId: string, key: string): Promise<Record<string, unknown>[]> {
  const current = await client.query(
    `select * from ledger_entries where customer_id = $1 and kind = 'consume' and consume_key = $2 order by created_at asc`,
    [customerId, key],
  );
  if (current.rows.length) return current.rows;
  const legacy = await client.query(
    `select * from ledger_entries where customer_id = $1 and kind = 'consume' and consume_key is null and idempotency_key = $2`,
    [customerId, key],
  );
  const first = legacy.rows[0];
  if (!first) return [];
  const sameTx = (await client.query(
    `select * from ledger_entries where customer_id = $1 and kind = 'consume' and consume_key is null and created_at = $2 order by idempotency_key asc`,
    [customerId, first.created_at],
  )).rows;
  const followUp = /^(.*):(\d+)$/.exec(key);
  if (followUp && sameTx.some((r) => r.idempotency_key === followUp[1])) return []; // a follow-up row of another consume
  const parts = sameTx.filter((r) => {
    const k = r.idempotency_key as string;
    return k.startsWith(`${key}:`) && /^\d+$/.test(k.slice(key.length + 1));
  });
  return [first, ...parts];
}

export class PostgresLedgerStore implements LedgerStore {
  constructor(private readonly pool: Pool) {}

  private client(customerId?: string): Runner {
    return runner(this.pool, customerId) as unknown as Runner;
  }

  async transaction<T>(customerId: string, fn: () => Promise<T>): Promise<T> {
    return withCustomerTransaction(this.pool, customerId, fn);
  }

  // EC:B1 B2 B9 B12 B20 — single-row grant/revoke/expire/hold/release/adjust. (customer_id,
  // idempotency_key) UNIQUE makes a webhook resend or duplicate CS regrant a no-op (B12/E2/E14);
  // another customer's identical key is a different operation (B20).
  async append(entry: NewLedgerEntry): Promise<AppendResult> {
    return withCustomerTransaction(this.pool, entry.customerId, async () => {
      const client = this.client(entry.customerId);
      const existing = await client.query('select * from ledger_entries where customer_id = $1 and idempotency_key = $2', [
        entry.customerId,
        entry.idempotencyKey,
      ]);
      if (existing.rows[0]) {
        return { entry: rowToLedgerEntry(existing.rows[0]), duplicated: true };
      }
      const id = `le_${randomUUID()}`;
      const res = await client.query(
        `insert into ledger_entries
           (id, customer_id, pool, kind, amount, unit_price_minor, currency, expires_at, source,
            reference, idempotency_key, actor, reason)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         returning *`,
        [
          id,
          entry.customerId,
          entry.pool,
          entry.kind,
          entry.amount,
          entry.unitPriceMinor ?? null,
          entry.currency ?? null,
          entry.expiresAt ?? null,
          entry.source,
          jsonb(referenceToJson(entry.reference)),
          entry.idempotencyKey,
          entry.actor,
          entry.reason ?? null,
        ],
      );
      await client.query('select paykit_refresh_balance($1)', [entry.customerId]);
      return { entry: rowToLedgerEntry(res.rows[0]), duplicated: false };
    });
  }

  // EC:B15 — fast path reads credit_balances; falls back to one refresh if the snapshot row is
  // missing (e.g. rows seeded outside append()).
  // EC:B15 B14 — refresh the snapshot as of `now` (expired grants excluded, like InMemoryLedger),
  // then read it. `now` is required (see LedgerStore.balance doc comment in core's types.ts).
  async balance(customerId: string, pool: CreditPool | undefined, now: Date): Promise<Balance> {
    const client = this.client();
    await client.query('select paykit_refresh_balance($1, $2)', [customerId, now]);
    if (pool) {
      const res = await client.query('select * from credit_balances where customer_id=$1 and pool=$2', [customerId, pool]);
      return balanceRowToBalance(customerId, pool, res.rows[0]);
    }
    const res = await client.query('select * from credit_balances where customer_id=$1', [customerId]);
    const available = res.rows.reduce((s: number, r: Record<string, unknown>) => s + Number(r.available), 0);
    const held = res.rows.reduce((s: number, r: Record<string, unknown>) => s + Number(r.held), 0);
    const expiring = res.rows.flatMap(
      (r: Record<string, unknown>) => (r.expiring as { expiresAt: string; amount: number }[] | null) ?? [],
    ).map((e) => ({ expiresAt: new Date(e.expiresAt), amount: Number(e.amount) }));
    return { customerId, pool: 'all', available, held, expiring };
  }

  async entries(
    customerId: string,
    filter?: { pool?: CreditPool; kind?: LedgerKind; since?: Date; source?: LedgerSource },
  ): Promise<LedgerEntry[]> {
    let sql = 'select * from ledger_entries where customer_id = $1';
    const params: unknown[] = [customerId];
    if (filter?.pool) {
      params.push(filter.pool);
      sql += ` and pool = $${params.length}`;
    }
    if (filter?.kind) {
      params.push(filter.kind);
      sql += ` and kind = $${params.length}`;
    }
    if (filter?.source) {
      params.push(filter.source);
      sql += ` and source = $${params.length}`;
    }
    if (filter?.since) {
      params.push(filter.since);
      sql += ` and created_at >= $${params.length}`;
    }
    sql += ' order by created_at asc';
    const res = await this.client().query(sql, params);
    return res.rows.map(rowToLedgerEntry);
  }

  // EC:B5 — atomic multi-pool, multi-grant consume. See spec/schema-postgres.pseudo.md [EC:B5].
  async consume(input: ConsumeInput): Promise<ConsumeResult> {
    return withCustomerTransaction(this.pool, input.customerId, async () => {
      const client = this.client(input.customerId);

      const existing = await findConsume(client, input.customerId, input.idempotencyKey);
      if (existing.length) {
        return { ok: true, entries: existing.map(rowToLedgerEntry), shortfall: 0, duplicated: true };
      }

      let remaining = input.amount;
      type Write = { pool: CreditPool; grantId: string | null; amount: number; expiresAt: Date | null; unitPriceMinor: number | null };
      const writes: Write[] = [];

      for (const pool of input.poolOrder) {
        if (remaining <= 0) break;
        const buckets = await client.query(
          `select g.id as grant_id, g.expires_at, g.unit_price_minor,
                  g.amount + coalesce((
                    select sum(le.amount) from ledger_entries le where le.reference ->> 'grantId' = g.id
                  ), 0) as remaining
           from ledger_entries g
           where g.customer_id = $1 and g.pool = $2 and g.kind = 'grant'
             and (g.expires_at is null or g.expires_at > $3)
           order by g.expires_at asc nulls last, g.created_at asc
           for update`,
          [input.customerId, pool, input.now],
        );
        for (const bucket of buckets.rows) {
          if (remaining <= 0) break;
          const bucketRemaining = Number(bucket.remaining);
          const take = Math.min(remaining, bucketRemaining);
          if (take <= 0) continue;
          writes.push({
            pool,
            grantId: bucket.grant_id as string,
            amount: -take,
            expiresAt: bucket.expires_at ? new Date(bucket.expires_at as string) : null,
            unitPriceMinor: bucket.unit_price_minor === null ? null : Number(bucket.unit_price_minor),
          });
          remaining -= take;
        }
      }

      let shortfall = remaining;
      if (shortfall > 0) {
        if (input.negativeBalance === 'block') {
          return { ok: false, entries: [], shortfall, duplicated: false };
        }
        const lastPool = input.poolOrder[input.poolOrder.length - 1] ?? 'paid';
        if (input.negativeBalance === 'allow_to_floor') {
          const totalRes = await client.query('select paykit_available($1, null, $2) as total', [input.customerId, input.now]); // EC:B14
          const currentTotal = Number(totalRes.rows[0]?.total ?? 0);
          const drawnSoFar = input.amount - shortfall;
          const allowed = Math.max(0, currentTotal - drawnSoFar - input.negativeFloor);
          const extra = Math.min(shortfall, allowed);
          if (extra > 0) {
            writes.push({ pool: lastPool, grantId: null, amount: -extra, expiresAt: null, unitPriceMinor: null });
            shortfall -= extra;
          }
          if (shortfall > 0) {
            return { ok: false, entries: [], shortfall, duplicated: false };
          }
        } else if (input.negativeBalance === 'allow_unbounded') {
          writes.push({ pool: lastPool, grantId: null, amount: -shortfall, expiresAt: null, unitPriceMinor: null });
          shortfall = 0;
        }
      }

      // EC:B23 — a row key another operation already holds is refused (same condition and error as
      // the in-memory store), never a raw unique violation.
      if (writes.length) {
        const taken = await client.query('select 1 from ledger_entries where customer_id = $1 and idempotency_key = any($2) limit 1',
          [input.customerId, writes.map((_, i) => `${input.idempotencyKey}#${i}`)]);
        if (taken.rows.length) throw new PaymentKitError(`idempotency key ${input.idempotencyKey} collides with an existing ledger row`, 'idempotency_key_conflict');
      }
      const entries: LedgerEntry[] = [];
      for (let i = 0; i < writes.length; i++) {
        const w = writes[i];
        const id = `le_${randomUUID()}`;
        // EC:B23 — row i is keyed '<key>#<i>', the same as the in-memory store; every row is found again
        // through consume_key.
        const key = `${input.idempotencyKey}#${i}`;
        const reference = referenceToJson({ ...input.meta, grantId: w.grantId ?? undefined });
        const res = await client.query(
          `insert into ledger_entries
             (id, customer_id, pool, kind, amount, unit_price_minor, expires_at, source, reference,
              idempotency_key, actor, reason, consume_key)
           values ($1,$2,$3,'consume',$4,$5,$6,'usage',$7,$8,$9,$10,$11)
           returning *`,
          [
            id,
            input.customerId,
            w.pool,
            w.amount,
            w.unitPriceMinor,
            w.expiresAt,
            jsonb(reference),
            key,
            input.meta.actor ?? 'app',
            input.meta.reason ?? null,
            input.idempotencyKey,
          ],
        );
        entries.push(rowToLedgerEntry(res.rows[0]));
      }

      await client.query('select paykit_refresh_balance($1)', [input.customerId]);
      return { ok: true, entries, shortfall: 0, duplicated: false };
    });
  }
}

export { rowToLedgerEntry };
