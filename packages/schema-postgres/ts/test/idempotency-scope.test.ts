// [EC:B20] Postgres: idempotency keys are unique per customer (migrations 0009, 0010). Another
// customer reusing a key is charged/recorded and never receives the first customer's rows.
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { UsageEvent } from 'boilpayment-core';
import { PostgresLedgerStore, PostgresRepo } from '../dist/index.js';
import { createTestDb, dropTestDb, type TestDb } from './db-helper.js';

describe('[EC:B20] Postgres idempotency keys per customer', () => {
  let db: TestDb;
  let ledger: PostgresLedgerStore;
  let repo: PostgresRepo;
  beforeAll(async () => {
    db = await createTestDb('idemscope');
    ledger = new PostgresLedgerStore(db.pool);
    repo = new PostgresRepo(db.pool);
  });
  afterAll(async () => { await dropTestDb(db); });

  async function customer(): Promise<string> {
    const id = `cust_${randomUUID()}`;
    await repo.customers.put({ id, email: null, providerRefs: [], status: 'active', createdAt: new Date() });
    await ledger.append({ customerId: id, pool: 'paid', kind: 'grant', amount: 100, unitPriceMinor: null, currency: null,
      expiresAt: null, source: 'manual', reference: {}, idempotencyKey: `g:${id}`, actor: 'test', reason: null });
    return id;
  }
  const consume = (customerId: string, amount: number, key: string) => ledger.consume({
    customerId, poolOrder: ['paid'], amount, idempotencyKey: key, meta: {}, now: new Date(), negativeBalance: 'block', negativeFloor: 0 });

  it('[EC:B20] B reusing A\'s consume key is charged and sees none of A\'s rows', async () => {
    const a = await customer(); const b = await customer(); const key = `req-${randomUUID()}`;
    await consume(a, 30, key);
    const rb = await consume(b, 50, key);
    expect([rb.duplicated, rb.entries.every((e) => e.customerId === b)]).toEqual([false, true]);
    expect((await ledger.balance(a, undefined, new Date())).available).toBe(70);
    expect((await ledger.balance(b, undefined, new Date())).available).toBe(50);
  });

  it('[EC:B20] the same customer repeating a key is still a duplicate (EC:B12)', async () => {
    const a = await customer(); const key = `req-${randomUUID()}`;
    const first = await consume(a, 10, key);
    const again = await consume(a, 10, key);
    expect([again.duplicated, again.entries[0].id]).toEqual([true, first.entries[0].id]);
  });

  it('[EC:B20] usage_events: two customers may use the same key', async () => {
    const a = await customer(); const b = await customer(); const key = `evt-${randomUUID()}`;
    const ev = (customerId: string): UsageEvent => ({ id: `u_${randomUUID()}`, customerId, meter: 'api', quantity: 1,
      occurredAt: new Date(), receivedAt: new Date(), periodStart: new Date('2026-01-01T00:00:00Z'), idempotencyKey: key, meta: {} });
    await repo.usageEvents.put(ev(a));
    await repo.usageEvents.put(ev(b));
    expect((await repo.usageEvents.list({ idempotencyKey: key } as Partial<UsageEvent>)).length).toBe(2);
  });
});
