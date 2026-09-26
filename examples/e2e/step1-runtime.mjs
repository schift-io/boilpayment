import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPaymentKit } from './paykit/index.ts';
import { InMemoryRepo, InMemoryLedger, FixedClock, SequentialIdGen, NoopLogger, CollectingNotifier } from 'boilpayment-sdk/core';
import { PortoneProvider } from 'boilpayment-sdk/portone';
import { createPool, migrate, PostgresRepo, PostgresLedgerStore } from 'boilpayment-sdk/postgres';

const config = JSON.parse(await readFile('./paykit.config.json', 'utf8'));
const base = process.env.STEP1_MOCK_URL;
assert.ok(base?.startsWith('http://127.0.0.1:'));
const clock = new FixedClock(new Date('2026-03-15T00:00:00Z'));
const ids = new SequentialIdGen('ts_step1_');
const pool = process.env.STEP1_DATABASE_URL ? createPool(process.env.STEP1_DATABASE_URL) : null;
try {
if (pool) await migrate({ pool });
const repo = pool ? new PostgresRepo(pool) : new InMemoryRepo();
const ledger = pool ? new PostgresLedgerStore(pool) : new InMemoryLedger(ids, clock);
const provider = new PortoneProvider({ apiSecret: 'test_step1', storeId: 'store_step1', webhookSecret: process.env.STEP1_WEBHOOK_SECRET, apiBase: base });
const kit = createPaymentKit(config, {
  clock, ids, repo, ledger, notifier: new CollectingNotifier(), logger: new NoopLogger(), providers: { portone: provider },
  env: { DATABASE_URL: process.env.STEP1_DATABASE_URL ?? '', PORTONE_API_SECRET: 'test_step1', PORTONE_STORE_ID: 'store_step1', PORTONE_WEBHOOK_SECRET: process.env.STEP1_WEBHOOK_SECRET },
});
await kit.initialize({ verifySchema: Boolean(pool) });
const period = { start: new Date('2026-03-01T00:00:00Z'), end: new Date('2026-04-01T00:00:00Z') };
const evidence = [];
async function control(path, body) {
  const response = await fetch(`${base}/__test/${path}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  return response.json();
}
async function seed(name, extra = {}) {
  const customerId = `ts_${name}`;
  const sub = { id: `sub_${customerId}`, customerId, planId: 'metered', provider: 'portone', providerRef: null, status: 'active', currentPeriod: period, anchorDay: 1, cancelAtPeriodEnd: false, graceUntil: null, billingKey: `bk_${customerId}`, scheduledPlanId: null, version: 0, createdAt: period.start };
  await repo.customers.put({ id: customerId, email: `${name}@example.test`, providerRefs: [{ provider: 'portone', ref: customerId }], status: 'active', createdAt: period.start });
  await repo.subscriptions.put(sub);
  const checkout = await kit.checkout({ customerId, planId: 'default', provider: 'portone', currency: 'KRW', requestId: name, successUrl: 'https://example.test/success', cancelUrl: 'https://example.test/cancel' });
  const paymentRef = checkout.providerRef;
  const raw = { id: paymentRef, status: 'PAID', amount: { total: 1000 }, currency: 'KRW', customer: { id: customerId }, paidAt: clock.now().toISOString(), requestedAt: clock.now().toISOString(), cancellations: [], ...extra };
  await control('seed', raw);
  const payment = await kit.registerCompletedCheckout({ customerId, checkoutId: checkout.id, paymentRef });
  return { customerId, paymentId: payment.id, paymentRef, sub, raw };
}
const balance = async (customerId) => (await ledger.balance(customerId, 'paid', clock.now())).available;
const request = (fixture, amount, requestId = fixture.paymentId) => kit.support.requestRefund({ customerId: fixture.customerId, paymentId: fixture.paymentId, requestId, requestedAmount: { amountMinor: amount, currency: 'KRW' } });
async function webhook(fixture, type, id, cancellationId) {
  const signed = await control('sign', { id, type, data: { paymentId: fixture.paymentRef, ...(cancellationId ? { cancellationId } : {}) } });
  return kit.handleWebhook(signed.rawBody, signed.headers, { provider: 'portone' });
}

// Given payment persistence succeeded but the credit-grant webhook never arrived.
const recovery = await seed('recover');
assert.equal(await balance(recovery.customerId), 0);
const capturedPlan = await repo.plans.get('default');
await repo.plans.put({ ...capturedPlan, creditsPerPeriod: 900 });
// When the generated support service recovers it using provider evidence.
const recovered = await kit.support.recoverMissingGrant(recovery);
// Then exactly the purchased credits become available.
assert.equal(recovered.status, 'resolved_auto');
assert.equal(await balance(recovery.customerId), 100);
await kit.support.recoverMissingGrant(recovery);
await webhook(recovery, 'Transaction.Paid', 'ts_late_paid');
await webhook(recovery, 'Transaction.Paid', 'ts_late_paid');
assert.equal(await balance(recovery.customerId), 100);
assert.equal((await ledger.entries(recovery.customerId, { kind: 'grant' })).length, 1);
await repo.plans.put(capturedPlan);
evidence.push({ scenario: 'missing_grant_recovery_duplicate_late_webhook', credits: 100, grants: 1, currentPlanCreditsIgnored: 900 });

// Given a seller policy authorizes a 400 KRW partial refund.
// When support executes the same customer request twice.
const partial = await request(recovery, 400, 'ts_partial');
await request(recovery, 400, 'ts_partial');
// Then provider and local refund/ledger agree, without a second refund.
assert.equal(partial.status, 'resolved_auto');
assert.equal(await balance(recovery.customerId), 60);
const partialRows = await repo.refunds.list({ paymentId: recovery.paymentId });
assert.equal(partialRows.length, 1);
assert.equal(partialRows[0].amount.amountMinor, 400);
assert.equal(partialRows[0].status, 'succeeded');
assert.equal((await control('state')).refunds.filter((r) => r.paymentId === recovery.paymentRef).length, 1);
evidence.push({ scenario: 'partial_refund_replay', amountMinor: 400, credits: 60, refunds: 1 });

// Given an authorized payment but a request above the configured automatic limit.
const manual = await seed('manual');
await kit.support.recoverMissingGrant(manual);
// When the customer asks for 800 KRW.
const manualCase = await request(manual, 800);
// Then no provider refund runs and the case awaits a person.
assert.equal(manualCase.status, 'needs_human');
assert.equal((await repo.refunds.list({ paymentId: manual.paymentId })).length, 0);
assert.equal(await balance(manual.customerId), 100);
evidence.push({ scenario: 'policy_manual_limit', status: manualCase.status, credits: 100 });

// Given a customer has no ownership of another customer's payment.
// When that customer asks for a refund.
const denied = await kit.support.requestRefund({ customerId: manual.customerId, paymentId: recovery.paymentId, requestId: 'ts_denied' });
// Then the request is rejected and no new provider refund runs.
assert.equal(denied.status, 'rejected');
assert.equal((await control('state')).refunds.length, 1);
evidence.push({ scenario: 'ownership_denied', status: denied.status });

for (const terminal of ['SUCCEEDED', 'FAILED']) {
  // Given the provider accepted a cancellation request but has not settled it.
  const fixture = await seed(`pending_${terminal}`, { testRefundStatus: 'REQUESTED' });
  await kit.support.recoverMissingGrant(fixture);
  const originalCase = await request(fixture, 400);
  const [pending] = await repo.refunds.list({ paymentId: fixture.paymentId });
  assert.equal(pending.status, 'pending');
  assert.equal(await balance(fixture.customerId), 60);
  assert.equal((await ledger.entries(fixture.customerId, { kind: 'revoke' })).length, 0);
  assert.equal(originalCase.status, 'needs_human');
  // When a signed notification triggers an authoritative provider re-read.
  await control('settle', { id: pending.providerRef, status: terminal });
  const eventType = terminal === 'SUCCEEDED' ? 'Transaction.PartialCancelled' : 'Transaction.CancelPending';
  await webhook(fixture, eventType, `ts_${terminal}`, pending.providerRef);
  await webhook(fixture, eventType, `ts_${terminal}_repeat`, pending.providerRef);
  // Then the original refund completes once and the original CS case reflects the result.
  const finalRefund = await repo.refunds.get(pending.id);
  const finalCase = await repo.csCases.get(originalCase.id);
  const finalPayment = await repo.payments.get(fixture.paymentId);
  assert.equal((await repo.refunds.list({ paymentId: fixture.paymentId })).length, 1);
  assert.equal(finalRefund.status, terminal === 'SUCCEEDED' ? 'succeeded' : 'failed');
  assert.equal(finalCase.status, terminal === 'SUCCEEDED' ? 'resolved_auto' : 'needs_human');
  assert.equal(finalPayment.status, terminal === 'SUCCEEDED' ? 'partially_refunded' : 'succeeded');
  assert.equal(await balance(fixture.customerId), terminal === 'SUCCEEDED' ? 60 : 100);
  evidence.push({ scenario: `pending_refund_${terminal.toLowerCase()}`, refundIdPreserved: true, caseStatus: finalCase.status, credits: await balance(fixture.customerId) });
}

// Given 8 usage units against 5 included, at 10 KRW per extra unit.
const usage = await seed('usage');
await kit.record({ sub: usage.sub, event: { customerId: usage.customerId, meter: 'calls', quantity: 8, occurredAt: clock.now(), idempotencyKey: 'ts_usage' } });
clock.advance(period.end.getTime() - clock.now().getTime());
// When the generated period close is retried.
await kit.cron.closePeriods();
await kit.cron.closePeriods();
// Then one provider charge and one local payment represent the 30 KRW overage.
const charges = (await control('state')).charges;
assert.equal(charges.length, 1);
assert.equal(charges[0].amount, 30);
const usagePayments = (await repo.payments.list({ customerId: usage.customerId })).filter((p) => p.kind === 'overage');
assert.equal(usagePayments.length, 1);
assert.equal(usagePayments[0].amount.amountMinor, 30);
evidence.push({ scenario: 'usage_overage_replay', charges: 1, amountMinor: 30 });

console.log(JSON.stringify({ language: 'ts', storage: pool ? 'isolated_postgres' : 'in_memory', provider: 'real_portone_adapter_local_http', evidence }));
} finally {
  if (pool) await pool.end();
}
