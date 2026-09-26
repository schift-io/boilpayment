// [EC:B21] Postgres consume idempotency is an exact match on the caller's key. A key that is a
// prefix of another key ('topup' vs 'topup:pay_1') or contains LIKE wildcards ('%', '_', 't%')
// is a new operation and is charged; the same key repeated is still a duplicate (EC:B12).
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgresLedgerStore, PostgresRepo } from '../dist/index.js';
import { createTestDb, dropTestDb, type TestDb } from './db-helper.js';

describe('[EC:B21] Postgres consume key is an exact match', () => {
  let db: TestDb; let ledger: PostgresLedgerStore; let repo: PostgresRepo;
  beforeAll(async () => { db = await createTestDb('consumekey'); ledger = new PostgresLedgerStore(db.pool); repo = new PostgresRepo(db.pool); });
  afterAll(async () => { await dropTestDb(db); });

  async function customer(credits: number, grantKey = 'topup:pay_1'): Promise<string> {
    const id = `cust_${randomUUID()}`;
    await repo.customers.put({ id, email: null, providerRefs: [], status: 'active', createdAt: new Date() });
    await ledger.append({ customerId: id, pool: 'paid', kind: 'grant', amount: credits, unitPriceMinor: null, currency: null,
      expiresAt: null, source: 'topup', reference: {}, idempotencyKey: grantKey, actor: 'test', reason: null });
    return id;
  }
  const consume = (customerId: string, amount: number, key: string) => ledger.consume({
    customerId, poolOrder: ['paid'], amount, idempotencyKey: key, meta: {}, now: new Date(), negativeBalance: 'block', negativeFloor: 0 });

  it('[EC:B21] prefix and wildcard keys are charged, not treated as duplicates', async () => {
    const c = await customer(300);
    const results = [];
    for (const key of ['topup', 't%', '%', '_']) results.push(await consume(c, 60, key));
    expect(results.map((r) => [r.ok, r.duplicated])).toEqual([[true, false], [true, false], [true, false], [true, false]]);
    expect((await ledger.balance(c, undefined, new Date())).available).toBe(60);
  });

  it('[EC:B21] a key that equals another consume\'s follow-up row key is a new operation', async () => {
    // Two grants so the first consume splits into two rows (key, key:1).
    const c = await customer(50, 'g1');
    await ledger.append({ customerId: c, pool: 'paid', kind: 'grant', amount: 50, unitPriceMinor: null, currency: null,
      expiresAt: null, source: 'topup', reference: {}, idempotencyKey: 'g2', actor: 'test', reason: null });
    const first = await consume(c, 80, 'job');
    expect(first.entries.length).toBe(2);
    const other = await consume(c, 10, 'job:1');
    expect([other.ok, other.duplicated]).toEqual([true, false]);
    expect((await ledger.balance(c, undefined, new Date())).available).toBe(10);
  });

  it('[EC:B12] the same key repeated is still a duplicate, including a split consume', async () => {
    const c = await customer(50, 'g1');
    await ledger.append({ customerId: c, pool: 'paid', kind: 'grant', amount: 50, unitPriceMinor: null, currency: null,
      expiresAt: null, source: 'topup', reference: {}, idempotencyKey: 'g2', actor: 'test', reason: null });
    const first = await consume(c, 80, 'job');
    const again = await consume(c, 80, 'job');
    expect([again.ok, again.duplicated, again.entries.map((e) => e.id).sort()]).toEqual([true, true, first.entries.map((e) => e.id).sort()]);
    expect((await ledger.balance(c, undefined, new Date())).available).toBe(20);
  });
});

describe('[EC:B22] consume rows written before 0013 (consume_key null) after the upgrade', () => {
  let db: TestDb; let ledger: PostgresLedgerStore; let repo: PostgresRepo;
  beforeAll(async () => { db = await createTestDb('consumelegacy'); ledger = new PostgresLedgerStore(db.pool); repo = new PostgresRepo(db.pool); });
  afterAll(async () => { await dropTestDb(db); });

  async function legacyCustomer(): Promise<string> {
    const id = `cust_${randomUUID()}`;
    await repo.customers.put({ id, email: null, providerRefs: [], status: 'active', createdAt: new Date() });
    await ledger.append({ customerId: id, pool: 'paid', kind: 'grant', amount: 100, unitPriceMinor: null, currency: null,
      expiresAt: null, source: 'topup', reference: {}, idempotencyKey: 'g', actor: 'test', reason: null });
    // What the pre-0013 build wrote for consume('job', 80) split over two grants: 'job' and 'job:1' in one transaction.
    // One transaction, so both rows get the same now() — with microseconds, as the old build wrote them.
    const client = await db.pool.connect();
    try {
      await client.query('begin');
      for (const [key, amount] of [['job', -50], ['job:1', -30]] as const) {
        await client.query(`insert into ledger_entries (id, customer_id, pool, kind, amount, source, reference, idempotency_key, actor)
          values ($1, $2, 'paid', 'consume', $3, 'usage', '{}'::jsonb, $4, 'app')`, [`le_${randomUUID()}`, id, amount, key]);
      }
      await client.query('commit');
    } finally { client.release(); }
    await db.pool.query('select paykit_refresh_balance($1)', [id]);
    return id;
  }
  const consume = (customerId: string, amount: number, key: string) => ledger.consume({
    customerId, poolOrder: ['paid'], amount, idempotencyKey: key, meta: {}, now: new Date(), negativeBalance: 'allow_unbounded', negativeFloor: 0 });

  it('[EC:B22] a new consume whose key equals an old follow-up row key is charged', async () => {
    const c = await legacyCustomer();
    const r = await consume(c, 20, 'job:1');
    expect([r.ok, r.duplicated, r.entries.reduce((s, e) => s + e.amount, 0)]).toEqual([true, false, -20]);
    expect((await ledger.balance(c, undefined, new Date())).available).toBe(0);
  });
  it('[EC:B22] retrying the old consume returns every row it wrote (the whole 80), not only the first', async () => {
    const c = await legacyCustomer();
    const r = await consume(c, 80, 'job');
    expect([r.ok, r.duplicated, r.entries.reduce((s, e) => s + e.amount, 0), r.entries.length]).toEqual([true, true, -80, 2]);
    expect((await ledger.balance(c, undefined, new Date())).available).toBe(20);
  });
});

describe('[EC:B23] consume key conflicts: same condition and error as the in-memory store', () => {
  let db: TestDb; let ledger: PostgresLedgerStore; let repo: PostgresRepo;
  beforeAll(async () => { db = await createTestDb('consumeconflict'); ledger = new PostgresLedgerStore(db.pool); repo = new PostgresRepo(db.pool); });
  afterAll(async () => { await dropTestDb(db); });
  async function cust(grantKeys: string[]): Promise<string> {
    const id = `cust_${randomUUID()}`;
    await repo.customers.put({ id, email: null, providerRefs: [], status: 'active', createdAt: new Date() });
    for (const k of grantKeys) await ledger.append({ customerId: id, pool: 'paid', kind: 'grant', amount: 50, unitPriceMinor: null, currency: null,
      expiresAt: null, source: 'topup', reference: {}, idempotencyKey: k, actor: 'test', reason: null });
    return id;
  }
  const consume = (customerId: string, key: string) => ledger.consume({
    customerId, poolOrder: ['paid'], amount: 10, idempotencyKey: key, meta: {}, now: new Date(), negativeBalance: 'block', negativeFloor: 0 });
  it('[EC:B23] a consume key equal to a grant key is a separate operation (was a raw 23505)', async () => {
    const c = await cust(['k']);
    const r = await consume(c, 'k');
    expect([r.ok, r.duplicated]).toEqual([true, false]);
  });
  it('[EC:B23] a grant holding the consume row key "k#0" refuses the consume with idempotency_key_conflict', async () => {
    const c = await cust(['g', 'k#0']);
    await expect(consume(c, 'k')).rejects.toMatchObject({ code: 'idempotency_key_conflict' });
    expect((await ledger.balance(c, undefined, new Date())).available).toBe(100);
  });
});
