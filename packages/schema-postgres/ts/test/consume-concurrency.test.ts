// [EC:B5] concurrent consume — pg_advisory_xact_lock + FOR UPDATE must prevent overselling when
// multiple connections race to consume from the same customer's balance.
import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterAll } from 'vitest';
import { Pool } from 'pg';
import type { Customer } from 'boilpayment-core';
import { PostgresLedgerStore, PostgresRepo } from '../dist/index.js';
import { createTestDb, dropTestDb, type TestDb } from './db-helper.js';

describe('[EC:B5] concurrent consume', () => {
  let db: TestDb;

  afterAll(async () => {
    if (db) await dropTestDb(db);
  });

  it('20 parallel consumes of 10 against a starting balance of 100 succeed exactly 10 times, final balance 0, no oversell', async () => {
    db = await createTestDb('concur');
    const repo = new PostgresRepo(db.pool);
    const customerId = `cust_${randomUUID()}`;
    await repo.customers.put({ id: customerId, email: null, providerRefs: [], status: 'active', createdAt: new Date() } satisfies Customer);

    const seedLedger = new PostgresLedgerStore(db.pool);
    await seedLedger.append({
      customerId, pool: 'paid', kind: 'grant', amount: 100, unitPriceMinor: 1, currency: 'USD',
      expiresAt: null, source: 'subscription', reference: {}, idempotencyKey: `grant_${customerId}`, actor: 'system', reason: null,
    });

    // Two separate connections/clients, as required by the task: each consume attempt gets its own
    // short-lived Pool so no single client serializes the requests client-side.
    const now = new Date();
    const attempts = Array.from({ length: 20 }, (_, i) => i);
    const results = await Promise.all(
      attempts.map(async (i) => {
        const pool = new Pool({ host: '127.0.0.1', database: db.dbName });
        try {
          const store = new PostgresLedgerStore(pool);
          return await store.consume({
            customerId, poolOrder: ['paid'], amount: 10, idempotencyKey: `concur_${customerId}_${i}`,
            meta: {}, now, negativeBalance: 'block', negativeFloor: 0,
          });
        } finally {
          await pool.end();
        }
      }),
    );

    const succeeded = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    expect(succeeded).toHaveLength(10);
    expect(failed).toHaveLength(10);
    for (const f of failed) {
      expect(f.shortfall).toBeGreaterThan(0);
      expect(f.entries).toHaveLength(0);
    }

    const finalBalance = await seedLedger.balance(customerId, undefined, now);
    expect(finalBalance.available).toBe(0);
  }, 30_000);
});
