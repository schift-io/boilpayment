// Phase 6 regression — migrate() idempotency.
// spec: packages/schema-postgres/spec/schema-postgres.pseudo.md "Migrations"
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { migrate } from '../dist/index.js';
import { createTestDb, dropTestDb, uniqueDbName, PG_HOST } from './helpers.js';

const dbName = uniqueDbName('migrate');
let pool: Pool;

beforeAll(async () => {
  await createTestDb(dbName);
  pool = new Pool({ host: PG_HOST, database: dbName });
});

afterAll(async () => {
  await pool.end();
  await dropTestDb(dbName);
});

describe('migrate() idempotency', () => {
  it('first call applies all 11 migration files in order and records them in paykit_migrations', async () => {
    const { applied } = await migrate({ pool, modules: ['core', 'credits', 'usage', 'webhook', 'refund', 'cs'] });
    expect(applied).toEqual([
      '0001_core.sql',
      '0002_credits.sql',
      '0003_usage.sql',
      '0004_webhook.sql',
      '0005_refund.sql',
      '0006_cs.sql',
      '0007_subscription_provider_ref_nullable.sql',
      '0009_ledger_idempotency_per_customer.sql',
      '0010_usage_idempotency_per_customer.sql',
      '0011_subscription_status_paused_incomplete.sql',
      '0012_subscription_currency.sql',
    ]);

    const rows = await pool.query('select name from paykit_migrations order by name');
    expect(rows.rows.map((r) => r.name)).toEqual([
      '0001_core.sql',
      '0002_credits.sql',
      '0003_usage.sql',
      '0004_webhook.sql',
      '0005_refund.sql',
      '0006_cs.sql',
      '0007_subscription_provider_ref_nullable.sql',
      '0009_ledger_idempotency_per_customer.sql',
      '0010_usage_idempotency_per_customer.sql',
      '0011_subscription_status_paused_incomplete.sql',
      '0012_subscription_currency.sql',
    ]);

    // sanity: tables from every module actually exist
    for (const table of [
      'customers', 'plans', 'plan_prices', 'subscriptions', 'payments', 'policy_snapshots', 'operations',
      'ledger_entries', 'credit_balances',
      'usage_events', 'usage_periods', 'usage_outbox',
      'webhook_events', 'outbox',
      'refunds', 'refund_attempts',
      'cs_cases', 'cs_events', 'churn_reasons', 'notifications',
    ]) {
      const res = await pool.query('select to_regclass($1) as reg', [table]);
      expect(res.rows[0].reg, `expected table ${table} to exist`).toBe(table);
    }
  });

  it('second call against an already-migrated database is a no-op: applied=[], no error, no duplicate rows', async () => {
    const before = await pool.query('select count(*)::int as n from paykit_migrations');
    const { applied } = await migrate({ pool, modules: ['core', 'credits', 'usage', 'webhook', 'refund', 'cs'] });
    expect(applied).toEqual([]);
    const after = await pool.query('select count(*)::int as n from paykit_migrations');
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect(after.rows[0].n).toBe(11);
  });

  it('third call (repeat) is still a no-op — consistent final state across repeated calls', async () => {
    const { applied } = await migrate({ pool, modules: ['core', 'credits', 'usage', 'webhook', 'refund', 'cs'] });
    expect(applied).toEqual([]);
    const rows = await pool.query('select count(*)::int as n from paykit_migrations');
    expect(rows.rows[0].n).toBe(11);
  });
});
