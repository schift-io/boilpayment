// Runs the real Postgres-backed code path once against a live local database.
// Usage: PAYKIT_SMOKE_DB=paykit_smoke_XXXXX node_modules/.bin/tsx packages/schema-postgres/ts/examples/smoke.ts
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { DEFAULT_POLICY, type Customer, type CsCase, type Plan, type Subscription } from 'boilpayment-core';
// Imports the built package (dist/) rather than src/ — this is what a real consumer imports, and
// what's actually shipped, so the smoke test exercises the exact same path (tsx is not installed
// in this workspace; run `npm run build` in ts/ first, then `node examples-dist/smoke.js`).
import { PostgresLedgerStore, PostgresRepo, migrate, consistencyCheck } from '../dist/index.js';

const dbName = process.env.PAYKIT_SMOKE_DB;
if (!dbName) throw new Error('set PAYKIT_SMOKE_DB to a throwaway database name');

async function main() {
  const pool = new Pool({ database: dbName });
  const ledger = new PostgresLedgerStore(pool);
  const repo = new PostgresRepo(pool);

  console.log('== migrate ==');
  const { applied } = await migrate({ pool, modules: ['core', 'credits', 'usage', 'webhook', 'refund', 'cs'] });
  console.log('applied:', applied);

  const customerId = 'cust_ts_smoke_1';
  const customer: Customer = { id: customerId, email: 'ts@smoke.test', providerRefs: [], status: 'active', createdAt: new Date() };
  await repo.customers.put(customer);
  console.log('== customer created ==', customerId);

  const now = new Date();
  const in30d = new Date(now.getTime() + 30 * 24 * 3600 * 1000);

  console.log('== grant 100 paid + 50 promo ==');
  const g1 = await ledger.append({
    customerId, pool: 'paid', kind: 'grant', amount: 100, unitPriceMinor: 10, currency: 'USD',
    expiresAt: in30d, source: 'subscription', reference: { subscriptionId: 'sub_ts_1', periodStart: now },
    idempotencyKey: 'grant:sub_ts_1:p1', actor: 'system', reason: null,
  });
  const g2 = await ledger.append({
    customerId, pool: 'promo', kind: 'grant', amount: 50, unitPriceMinor: 0, currency: 'USD',
    expiresAt: in30d, source: 'promo', reference: {},
    idempotencyKey: 'grant:promo:ts1', actor: 'system', reason: null,
  });
  assert.equal(g1.duplicated, false);
  assert.equal(g2.duplicated, false);
  console.log('grants ok:', g1.entry.id, g2.entry.id);

  console.log('== consume 120 poolOrder [promo, paid] ==');
  const consumeKey = 'consume:ts:req1';
  const c1 = await ledger.consume({
    customerId, poolOrder: ['promo', 'paid'], amount: 120, idempotencyKey: consumeKey,
    meta: { reason: 'smoke test' }, now, negativeBalance: 'block', negativeFloor: 0,
  });
  assert.equal(c1.ok, true);
  assert.equal(c1.shortfall, 0);
  assert.equal(c1.entries.length, 2, 'expected 2 consume rows (promo bucket then paid bucket)');
  const promoRow = c1.entries.find((e) => e.pool === 'promo')!;
  const paidRow = c1.entries.find((e) => e.pool === 'paid')!;
  assert.equal(promoRow.amount, -50);
  assert.equal(paidRow.amount, -70);
  assert.equal(promoRow.reference.grantId, g2.entry.id);
  assert.equal(paidRow.reference.grantId, g1.entry.id);
  console.log('consume ok: promo -50, paid -70, grantId tagging correct');

  const balAfterConsume = await ledger.balance(customerId, undefined, now);
  console.log('balance after consume:', balAfterConsume);
  assert.equal(balAfterConsume.available, 30, 'paid 100-70 + promo 50-50 = 30');
  assert.equal(balAfterConsume.expiring.length, 1, 'promo grant is fully consumed (remaining 0) and must not appear in expiring');
  assert.equal(balAfterConsume.expiring[0].amount, 30, 'only the paid grant remainder (30) should be in expiring');

  console.log('== duplicate idempotency key ==');
  const c1dup = await ledger.consume({
    customerId, poolOrder: ['promo', 'paid'], amount: 120, idempotencyKey: consumeKey,
    meta: { reason: 'smoke test' }, now, negativeBalance: 'block', negativeFloor: 0,
  });
  assert.equal(c1dup.duplicated, true);
  assert.equal(c1dup.entries.length, 2);
  console.log('duplicate consume ok: duplicated=true, same 2 rows returned');

  console.log('== attempt UPDATE on ledger_entries (must be rejected by trigger) ==');
  try {
    await pool.query('update ledger_entries set amount = 999999 where id = $1', [paidRow.id]);
    throw new Error('expected UPDATE to be rejected but it succeeded');
  } catch (err) {
    const msg = (err as Error).message;
    assert.match(msg, /append-only/, `expected append-only rejection, got: ${msg}`);
    console.log('UPDATE correctly rejected:', msg);
  }

  console.log('== block policy overshoot ==');
  const overshoot = await ledger.consume({
    customerId, poolOrder: ['promo', 'paid'], amount: 1000, idempotencyKey: 'consume:ts:overshoot',
    meta: {}, now, negativeBalance: 'block', negativeFloor: 0,
  });
  assert.equal(overshoot.ok, false);
  assert.equal(overshoot.entries.length, 0);
  assert.equal(overshoot.shortfall, 970);
  const balAfterOvershoot = await ledger.balance(customerId, undefined, now);
  assert.equal(balAfterOvershoot.available, 30, 'overshoot must not write any rows');
  console.log('overshoot correctly blocked: ok=false, shortfall=970, no rows written, balance unchanged');

  console.log('== consistencyCheck ==');
  const mismatches = await consistencyCheck(pool);
  const mine = mismatches.filter((m) => m.customerId === customerId);
  assert.equal(mine.length, 0, `expected 0 mismatches for ${customerId}, got ${JSON.stringify(mine)}`);
  console.log(`consistencyCheck ok: 0 mismatches for ${customerId} (total mismatches in db: ${mismatches.length})`);

  console.log('== PgTable roundtrip: plans + plan_prices ==');
  const plan: Plan = {
    id: 'plan_ts_pro', name: 'Pro (ts smoke)', interval: 'month', creditsPerPeriod: 100, usageIncluded: 0,
    trialDays: 7, prices: [{ currency: 'USD', amountMinor: 2900 }, { currency: 'KRW', amountMinor: 39000 }],
  };
  await repo.plans.put(plan);
  const planBack = await repo.plans.get('plan_ts_pro');
  assert.ok(planBack);
  assert.equal(planBack!.prices.length, 2);
  console.log('plan roundtrip ok:', planBack!.name, planBack!.prices);

  console.log('== PgTable roundtrip: subscriptions (Period) ==');
  const sub: Subscription = {
    id: 'sub_ts_smoke_1', customerId, planId: plan.id, provider: 'stripe', providerRef: 'sub_ref_ts_1',
    status: 'active', currentPeriod: { start: now, end: in30d }, anchorDay: now.getUTCDate(),
    cancelAtPeriodEnd: false, graceUntil: null, billingKey: null, scheduledPlanId: null, createdAt: now,
  };
  await repo.subscriptions.put(sub);
  const subBack = await repo.subscriptions.get(sub.id);
  assert.ok(subBack);
  assert.equal(subBack!.currentPeriod.start.getTime(), now.getTime());
  assert.equal(subBack!.currentPeriod.end.getTime(), in30d.getTime());
  console.log('subscription roundtrip ok:', subBack!.id, subBack!.currentPeriod);

  console.log('== PgTable roundtrip: cs_cases + policy_snapshots dedup ==');
  const csCase: CsCase = {
    id: 'cs_ts_smoke_1', customerId, kind: 'reconcile_mismatch', status: 'open', referenceId: 'ref1',
    policySnapshot: DEFAULT_POLICY, decision: null, churnReason: null, churnText: null, openedAt: now, resolvedAt: null,
  };
  await repo.csCases.put(csCase);
  const csBack = await repo.csCases.get(csCase.id);
  assert.ok(csBack);
  assert.deepEqual(csBack!.policySnapshot.upgrade.mode, DEFAULT_POLICY.upgrade.mode);
  console.log('cs_case roundtrip ok:', csBack!.id, 'policySnapshot.upgrade.mode =', csBack!.policySnapshot.upgrade.mode);

  await pool.end();
  console.log('\nALL SMOKE CHECKS PASSED');
}

main().catch((err) => {
  console.error('SMOKE FAILED:', err);
  process.exit(1);
});
