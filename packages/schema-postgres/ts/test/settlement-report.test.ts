// [EC:I10] settlement report on Postgres — same aggregation as in-memory, read-only.
import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import { PostgresLedgerStore, PostgresRepo } from '../dist/index.js';
import { settlementReport } from '../../../cs/ts/src/settlementReport.js';
import { createTestDb, dropTestDb, type TestDb } from './db-helper.js';

let db: TestDb;
afterAll(async () => { if (db) await dropTestDb(db); });

it('[EC:I10] aggregates payments, refunds and ledger rows in the window', async () => {
  db = await createTestDb('settle_report');
  const repo = new PostgresRepo(db.pool); const ledger = new PostgresLedgerStore(db.pool);
  const c = `cust_${randomUUID()}`;
  await repo.customers.put({ id: c, email: null, providerRefs: [], status: 'active', createdAt: new Date('2026-01-01T00:00:00Z') });
  const mk = (id: string, at: string, amountMinor: number, status: 'succeeded' | 'failed') => repo.payments.put({
    id, customerId: c, provider: 'stripe', providerRef: `pi_${id}`, subscriptionId: null, amount: { amountMinor, currency: 'USD' },
    status, kind: 'topup', period: null, occurredAt: new Date(at), failure: null,
  });
  await mk(`p1_${c}`, '2026-01-05T00:00:00Z', 1000, 'succeeded');
  await mk(`p2_${c}`, '2026-01-06T00:00:00Z', 700, 'failed');
  await mk(`p3_${c}`, '2026-02-01T00:00:00Z', 999, 'succeeded');
  await repo.refunds.put({ id: `r1_${c}`, paymentId: `p1_${c}`, customerId: c, amount: { amountMinor: 300, currency: 'USD' }, status: 'succeeded',
    providerRef: 're_1', creditsRevoked: 0, ruleId: 'D2', reason: null, failure: null, createdAt: new Date('2026-01-07T00:00:00Z') });
  await ledger.append({ customerId: c, pool: 'paid', kind: 'grant', amount: 100, unitPriceMinor: 10, currency: 'USD', expiresAt: null,
    source: 'topup', reference: {}, idempotencyKey: `g_${c}`, actor: 's', reason: null });

  const r = await settlementReport({ repo, ledger, from: new Date('2026-01-01T00:00:00Z'), to: new Date('2026-02-01T00:00:00Z') });
  expect(r.payments).toEqual([
    { currency: 'USD', kind: 'topup', status: 'failed', count: 1, amountMinor: 700 },
    { currency: 'USD', kind: 'topup', status: 'succeeded', count: 1, amountMinor: 1000 },
  ]);
  expect(r.net).toEqual([{ currency: 'USD', amountMinor: 1000 }]);
  // Postgres stamps refunds.created_at and ledger rows with the database clock at insert (now),
  // so they fall in a window around now, not in January 2026.
  expect(r.refunds).toEqual([]);
  const now = await settlementReport({ repo, ledger, from: new Date(Date.now() - 60_000), to: new Date(Date.now() + 60_000) });
  expect(now.refunds).toEqual([{ currency: 'USD', count: 1, amountMinor: 300 }]);
  expect(now.credits).toEqual([{ kind: 'grant', source: 'topup', count: 1, amount: 100 }]);
}, 30_000);
