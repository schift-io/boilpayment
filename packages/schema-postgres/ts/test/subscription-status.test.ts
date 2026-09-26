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
