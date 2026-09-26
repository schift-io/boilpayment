/**
 * In-memory reference implementations of LedgerStore / Repo / Notifier.
 * See spec/core.pseudo.md [EC:B5] [EC:B14] [EC:B3] [EC:B4] [EC:B12].
 * Mirrors packages/core/py/src/schift_payment_kit_core/memory.py exactly.
 */
import {
  AppendResult,
  Balance,
  Clock,
  ConsumeInput,
  ConsumeResult,
  CsCase,
  Customer,
  ExpiringBucket,
  IdGen,
  LedgerEntry,
  LedgerKind,
  LedgerSource,
  LedgerStore,
  NewLedgerEntry,
  Notification,
  Notifier,
  Operation,
  OutboxItem,
  Payment,
  Plan,
  Pool,
  Refund,
  Repo,
  Subscription,
  Table,
  UsageEvent,
  WebhookEventRecord,
  PaymentKitError,
} from './types.js';
import { SystemClock, UuidIdGen } from './clock.js';

// ── Per-customer mutex (serializes consume()/transaction() calls for one customer) ──────────

class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const step = () => fn();
    const result = this.tail.then(step, step);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

// ── Generic table ─────────────────────────────────────────────────────────────────────────

/** Shallow-equality filtered in-memory table. */
export class MemTable<T extends { id: string }> implements Table<T> {
  protected readonly rows = new Map<string, T>();

  async get(id: string): Promise<T | null> {
    return this.rows.get(id) ?? null;
  }

  async put(row: T): Promise<T> {
    this.rows.set(row.id, row);
    return row;
  }

  async list(filter?: Partial<T>): Promise<T[]> {
    const all = [...this.rows.values()];
    if (!filter) return all;
    const keys = Object.keys(filter) as (keyof T)[];
    return all.filter((row) => keys.every((k) => row[k] === filter[k]));
  }
}

/**
 * EC:K1 — optimistic-locking table for rows that carry a `version`. `put` rejects a write whose
 * `version` is not the stored one with `PaymentKitError('subscription_version_conflict')`, so an
 * upgrade racing a renewal webhook fails loudly instead of silently losing one of the two writes.
 * The caller's object is bumped in place as well, so a function that reads once and writes twice
 * keeps working; only two INDEPENDENT readers collide.
 */
export class VersionedMemTable<T extends { id: string; version: number }> extends MemTable<T> {
  async put(row: T): Promise<T> {
    const existing = await this.get(row.id);
    if (existing && existing.version !== row.version) {
      throw new PaymentKitError(
        `stale write to ${row.id}: expected version ${existing.version}, got ${row.version}`,
        'subscription_version_conflict',
        { id: row.id, expected: existing.version, got: row.version },
      );
    }
    const next = existing ? row.version + 1 : row.version;
    row.version = next; // keep the caller's handle usable for a follow-up put
    return super.put({ ...row, version: next });
  }
}

export class OperationMemTable extends MemTable<Operation> {
  async claim(row: Operation): Promise<Operation | null> {
    const existing = this.rows.get(row.key);
    if (existing && (existing.status !== 'failed' || existing.payloadHash !== row.payloadHash)) return null;
    const claimed: Operation = { ...row, kind: existing?.kind ?? row.kind, status: 'in_progress', result: null, error: null, completedAt: null, createdAt: existing?.createdAt ?? row.createdAt, attempts: (existing?.attempts ?? 0) + 1 };
    this.rows.set(row.key, claimed);
    return claimed;
  }
}

export class InMemoryRepo implements Repo {
  customers = new MemTable<Customer>();
  plans = new MemTable<Plan>();
  subscriptions = new VersionedMemTable<Subscription>();
  payments = new MemTable<Payment>();
  usageEvents = new MemTable<UsageEvent>();
  refunds = new MemTable<Refund>();
  csCases = new MemTable<CsCase>();
  webhookEvents = new MemTable<WebhookEventRecord>();
  outbox = new MemTable<OutboxItem>();
  operations = new OperationMemTable(); // EC:J1-J5
}

export class NoopNotifier implements Notifier {
  async send(_n: Notification): Promise<void> {
    // no-op
  }
}

export class CollectingNotifier implements Notifier {
  readonly sent: Notification[] = [];

  async send(n: Notification): Promise<void> {
    this.sent.push(n);
  }
}

// ── Ledger ────────────────────────────────────────────────────────────────────────────────

interface Bucket {
  pool: Pool;
  expiresAt: Date | null;
  remaining: number;
}

export class InMemoryLedger implements LedgerStore {
  private readonly entriesByCustomer = new Map<string, LedgerEntry[]>();
  private readonly byIdempotencyKey = new Map<string, LedgerEntry>();
  private readonly consumeResults = new Map<string, ConsumeResult>();
  private readonly mutexes = new Map<string, Mutex>();

  // EC:I9 finding (2026-09-09, 3rd time independently: refund.evaluate FINDINGS#1, a dispute
  // regression test, cs.timeline) — `append()`'s `createdAt` used to always be wall-clock time
  // (`new Date()`), ignoring whatever `Clock` the caller injected everywhere else, so
  // `FixedClock`-based tests got a real timestamp on this one field. Defaults to `SystemClock`
  // (unchanged behavior for every existing `new InMemoryLedger(ids)` call site) — pass a
  // `FixedClock` explicitly for deterministic tests.
  constructor(
    private readonly ids: IdGen = new UuidIdGen(),
    private readonly clock: Clock = new SystemClock(),
  ) {}

  private mutexFor(customerId: string): Mutex {
    let m = this.mutexes.get(customerId);
    if (!m) {
      m = new Mutex();
      this.mutexes.set(customerId, m);
    }
    return m;
  }

  async transaction<T>(customerId: string, fn: () => Promise<T>): Promise<T> {
    return this.mutexFor(customerId).run(fn);
  }

  // EC:B12 — idempotency_key is UNIQUE across the whole ledger; a re-append returns the existing row.
  async append(entry: NewLedgerEntry): Promise<AppendResult> {
    const existing = this.byIdempotencyKey.get(entry.idempotencyKey);
    if (existing) return { entry: existing, duplicated: true };
    const row: LedgerEntry = { ...entry, id: this.ids.newId(), createdAt: this.clock.now() };
    const bucket = this.entriesByCustomer.get(entry.customerId) ?? [];
    bucket.push(row);
    this.entriesByCustomer.set(entry.customerId, bucket);
    this.byIdempotencyKey.set(entry.idempotencyKey, row);
    return { entry: row, duplicated: false };
  }

  async entries(
    customerId: string,
    filter?: { pool?: Pool; kind?: LedgerKind; since?: Date; source?: LedgerSource },
  ): Promise<LedgerEntry[]> {
    const all = this.entriesByCustomer.get(customerId) ?? [];
    return all.filter(
      (e) =>
        (!filter?.pool || e.pool === filter.pool) &&
        (!filter?.kind || e.kind === filter.kind) &&
        (!filter?.since || e.createdAt >= filter.since) &&
        (!filter?.source || e.source === filter.source),
    );
  }

  // EC:B14 — builds per-grant remaining buckets; expiry is filtered by the caller (balance/consume) using `now`.
  private buildBuckets(customerId: string, pool?: Pool): Map<string, Bucket> {
    const all = this.entriesByCustomer.get(customerId) ?? [];
    const buckets = new Map<string, Bucket>();
    for (const e of all) {
      if (e.kind === 'grant') buckets.set(e.id, { pool: e.pool, expiresAt: e.expiresAt, remaining: e.amount });
    }
    for (const e of all) {
      if (e.kind === 'grant') continue;
      const grantId = e.reference.grantId;
      if (grantId && buckets.has(grantId)) buckets.get(grantId)!.remaining += e.amount;
    }
    if (pool) {
      for (const [id, b] of buckets) if (b.pool !== pool) buckets.delete(id);
    }
    return buckets;
  }

  /** Entries not tied to a specific grant bucket (manual adjustments, negative-balance overflow draws). */
  private unbucketedTotal(customerId: string, pool?: Pool): number {
    const all = this.entriesByCustomer.get(customerId) ?? [];
    let total = 0;
    for (const e of all) {
      if (e.kind === 'grant') continue;
      if (e.reference.grantId) continue;
      if (pool && e.pool !== pool) continue;
      total += e.amount;
    }
    return total;
  }

  private heldTotal(customerId: string, pool?: Pool): number {
    const all = this.entriesByCustomer.get(customerId) ?? [];
    let total = 0;
    for (const e of all) {
      if (pool && e.pool !== pool) continue;
      if (e.kind === 'hold' || e.kind === 'release') total += e.amount;
    }
    return -total; // hold is negative, release is positive; outstanding held = -(net)
  }

  // EC:B14 — `now` is required (see LedgerStore.balance doc comment in types.ts).
  async balance(customerId: string, pool: Pool | undefined, now: Date): Promise<Balance> {
    const buckets = this.buildBuckets(customerId, pool);
    let available = this.unbucketedTotal(customerId, pool);
    const expiringMap = new Map<number, number>();
    for (const b of buckets.values()) {
      if (b.expiresAt !== null && b.expiresAt.getTime() <= now.getTime()) continue; // EC:B14
      available += b.remaining;
      if (b.expiresAt !== null && b.remaining > 0) {
        expiringMap.set(b.expiresAt.getTime(), (expiringMap.get(b.expiresAt.getTime()) ?? 0) + b.remaining);
      }
    }
    const expiring: ExpiringBucket[] = [...expiringMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([t, amount]) => ({ expiresAt: new Date(t), amount }));
    return { customerId, pool: pool ?? 'all', available, held: this.heldTotal(customerId, pool), expiring };
  }

  // EC:B5 atomic · EC:B3 order (poolOrder + within-pool expiring-first) · EC:B4 negative-balance policy
  // · EC:B12 idempotent (whole call cached by idempotencyKey) · EC:B14 expiry filtered at consume time.
  async consume(input: ConsumeInput): Promise<ConsumeResult> {
    return this.transaction(input.customerId, async () => {
      const cached = this.consumeResults.get(input.idempotencyKey);
      if (cached) return { ...cached, duplicated: true };

      const now = input.now;
      let remaining = input.amount;
      const plan: { pool: Pool; amount: number; grantId: string | null }[] = [];

      for (const pool of input.poolOrder) {
        if (remaining <= 0) break;
        const buckets = [...this.buildBuckets(input.customerId, pool).entries()]
          .filter(([, b]) => (b.expiresAt === null || b.expiresAt.getTime() > now.getTime()) && b.remaining > 0)
          .sort((a, b) => {
            const ea = a[1].expiresAt ? a[1].expiresAt.getTime() : Number.POSITIVE_INFINITY;
            const eb = b[1].expiresAt ? b[1].expiresAt.getTime() : Number.POSITIVE_INFINITY;
            return ea - eb;
          });
        for (const [grantId, b] of buckets) {
          if (remaining <= 0) break;
          const draw = Math.min(b.remaining, remaining);
          if (draw <= 0) continue;
          plan.push({ pool, amount: -draw, grantId });
          remaining -= draw;
        }
      }

      let ok = true;
      let shortfall = 0;
      if (remaining > 0) {
        const overflowPool: Pool = input.poolOrder[input.poolOrder.length - 1] ?? 'paid';
        if (input.negativeBalance === 'allow_unbounded') {
          plan.push({ pool: overflowPool, amount: -remaining, grantId: null });
          remaining = 0;
        } else if (input.negativeBalance === 'allow_to_floor') {
          const currentTotal = (await this.balance(input.customerId, undefined, now)).available;
          const drawnSoFar = input.amount - remaining; // already planned from buckets (spec EC:B5 step 4)
          const room = currentTotal - drawnSoFar - input.negativeFloor;
          const allowed = Math.max(0, room);
          if (remaining <= allowed) {
            plan.push({ pool: overflowPool, amount: -remaining, grantId: null });
            remaining = 0;
          } else {
            ok = false;
            shortfall = remaining - allowed;
          }
        } else {
          ok = false;
          shortfall = remaining;
        }
      }

      if (!ok) {
        const result: ConsumeResult = { ok: false, entries: [], shortfall, duplicated: false };
        this.consumeResults.set(input.idempotencyKey, result);
        return result;
      }

      const entries: LedgerEntry[] = [];
      for (let i = 0; i < plan.length; i++) {
        const step = plan[i];
        const { entry } = await this.append({
          customerId: input.customerId,
          pool: step.pool,
          kind: 'consume',
          amount: step.amount,
          unitPriceMinor: null,
          currency: null,
          expiresAt: null,
          source: 'usage',
          // EC:L5 — spread, do not re-list: a field whitelist here silently drops anything added to
          // LedgerReference later (correlationId was dropped exactly this way). consume() owns grantId.
          reference: { ...input.meta, grantId: step.grantId ?? undefined },
          idempotencyKey: `${input.idempotencyKey}#${i}`,
          actor: input.meta.actor ?? 'app',
          reason: input.meta.reason ?? null,
        });
        entries.push(entry);
      }
      const result: ConsumeResult = { ok: true, entries, shortfall: 0, duplicated: false };
      this.consumeResults.set(input.idempotencyKey, result);
      return result;
    });
  }
}
