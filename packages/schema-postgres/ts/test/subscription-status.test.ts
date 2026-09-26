// [EC:A27] Postgres accepts the non-entitled subscription statuses (migration 0011).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Subscription } from 'boilpayment-core';
import { PostgresRepo } from '../dist/index.js';
import { createTestDb, dropTestDb, type TestDb } from './db-helper.js';

describe('[EC:A27] subscriptions.status paused / incomplete', () => {
  let db: TestDb;
  let repo: PostgresRepo;
  beforeAll(async () => {
    db = await createTestDb('substatus');
    repo = new PostgresRepo(db.pool);
    await repo.plans.put({ id: 'p', name: 'P', interval: 'month', creditsPerPeriod: 0, usageIncluded: 0, trialDays: 0, prices: [{ currency: 'USD', amountMinor: 100 }] });
  });
  afterAll(async () => { await dropTestDb(db); });
  for (const status of ['paused', 'incomplete'] as const) {
    it(`[EC:A27] stores and reads back ${status}`, async () => {
      await repo.customers.put({ id: `c_${status}`, email: null, providerRefs: [], status: 'active', createdAt: new Date() });
      const sub: Subscription = { id: `s_${status}`, customerId: `c_${status}`, planId: 'p', provider: 'stripe', providerRef: `sub_${status}`, status,
        currentPeriod: { start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-02-01T00:00:00Z') }, anchorDay: 1, cancelAtPeriodEnd: false,
        graceUntil: null, billingKey: null, scheduledPlanId: null, version: 0, createdAt: new Date('2026-01-01T00:00:00Z') };
      await repo.subscriptions.put(sub);
      expect((await repo.subscriptions.get(sub.id))?.status).toBe(status);
    });
  }
});

describe('[EC:A28] subscriptions.currency', () => {
  let db: TestDb;
  let repo: PostgresRepo;
  beforeAll(async () => {
    db = await createTestDb('subcurrency');
    repo = new PostgresRepo(db.pool);
    await repo.plans.put({ id: 'p', name: 'P', interval: 'month', creditsPerPeriod: 0, usageIncluded: 0, trialDays: 0, prices: [{ currency: 'KRW', amountMinor: 13000 }] });
    await repo.customers.put({ id: 'c', email: null, providerRefs: [], status: 'active', createdAt: new Date() });
  });
  afterAll(async () => { await dropTestDb(db); });
  it('[EC:A28] stores and reads back the currency; absent reads as null', async () => {
    const base: Subscription = { id: 's1', customerId: 'c', planId: 'p', provider: 'toss', providerRef: null, status: 'active',
      currentPeriod: { start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-02-01T00:00:00Z') }, anchorDay: 1, cancelAtPeriodEnd: false,
      graceUntil: null, billingKey: 'bk', scheduledPlanId: null, version: 0, createdAt: new Date('2026-01-01T00:00:00Z') };
    await repo.subscriptions.put({ ...base, currency: 'KRW' });
    await repo.subscriptions.put({ ...base, id: 's2', billingKey: 'bk2' });
    expect([(await repo.subscriptions.get('s1'))?.currency, (await repo.subscriptions.get('s2'))?.currency ?? null]).toEqual(['KRW', null]);
  });
});
