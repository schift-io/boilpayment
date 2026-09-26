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
