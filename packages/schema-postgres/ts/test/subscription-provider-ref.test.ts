import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadMigrations, migrate, PostgresRepo, verifySchema } from '../dist/index.js';
import { createTestDb, dropTestDb, type TestDb } from './db-helper.js';

const followup = '0007_subscription_provider_ref_nullable.sql';
let db: TestDb;
beforeAll(async () => { db = await createTestDb('nullable_provider_ref'); });
afterAll(async () => { await dropTestDb(db); });

it('always selects the core nullable-provider migration', () => {
  expect(loadMigrations(['core']).map((file) => file.name)).toEqual(['0001_core.sql', followup, '0011_subscription_status_paused_incomplete.sql', '0012_subscription_currency.sql', '0014_subscription_billing_customer_ref.sql']);
  expect(loadMigrations(['credits']).map((file) => file.name)).toContain(followup);
});

it('upgrades the old constraint, detects pending migration, and stores a real self subscription', async () => {
  await db.pool.query('alter table subscriptions alter column provider_ref set not null');
  await db.pool.query('delete from paykit_migrations where name=$1', [followup]);
  await expect(verifySchema({ pool: db.pool })).rejects.toThrow(followup);
  expect((await migrate({ pool: db.pool })).applied).toEqual([followup]);
  expect((await verifySchema({ pool: db.pool })).ok).toBe(true);
  expect((await migrate({ pool: db.pool })).applied).toEqual([]);
  const repo = new PostgresRepo(db.pool);
  const start = new Date('2026-01-01T00:00:00Z');
  await repo.customers.put({ id: 'customer', email: null, providerRefs: [], status: 'active', createdAt: start });
  await repo.plans.put({ id: 'plan', name: 'Plan', interval: 'month', creditsPerPeriod: 100, usageIncluded: 0, trialDays: 0, prices: [] });
  await repo.subscriptions.put({ id: 'self', customerId: 'customer', planId: 'plan', provider: 'toss', providerRef: null, status: 'active', currentPeriod: { start, end: new Date('2026-02-01T00:00:00Z') }, anchorDay: 1, cancelAtPeriodEnd: false, graceUntil: null, billingKey: 'billing-key', scheduledPlanId: null, version: 0, createdAt: start });
  expect((await repo.subscriptions.get('self'))?.providerRef).toBeNull();
  const paymentColumn = await db.pool.query("select is_nullable from information_schema.columns where table_schema='public' and table_name='payments' and column_name='provider_ref'");
  expect(paymentColumn.rows[0].is_nullable).toBe('NO');
});
