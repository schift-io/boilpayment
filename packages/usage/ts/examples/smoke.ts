// Smoke test — real code path (no mocks of our own modules), only a fake PaymentProvider.
// Run: node_modules/.bin/tsx packages/usage/ts/examples/smoke.ts
import {
  DEFAULT_POLICY, FixedClock, InMemoryLedger, InMemoryRepo, Payment, PaymentProvider, Plan, Refund,
  SequentialIdGen, Subscription,
} from '@schift/payment-kit-core';
import { check, closePeriod, flushOutbox, record } from '../src/index.js';

const ids = new SequentialIdGen('id_');
const clock = new FixedClock(new Date('2026-02-02T00:00:00Z')); // 1 day into the Feb period
const ledger = new InMemoryLedger(ids);
const repo = new InMemoryRepo();

// Fake provider: reportUsage fails once then succeeds; meters=true so record() enqueues outbox.
let reportUsageCalls = 0;
const reportUsageCustomerRefs: string[] = [];
class FakeProvider implements PaymentProvider {
  readonly name = 'stripe' as const;
  capabilities() { return { nativeSubscriptions: true, partialRefund: true, meters: true, scheduling: 'provider' as const, webhookSignature: true }; }
  async createCustomer() { return { ref: 'cus_fake' }; }
  async createCheckout(): Promise<never> { throw new Error('unused'); }
  async getPayment(): Promise<never> { throw new Error('unused'); }
  async listPayments() { return []; }
  async getSubscription(): Promise<never> { throw new Error('unused'); }
  async changeSubscription(): Promise<never> { throw new Error('unused'); }
  async cancelSubscription(): Promise<never> { throw new Error('unused'); }
  async uncancelSubscription(): Promise<never> { return this.cancelSubscription(); }
  async chargeBillingKey(): Promise<never> { throw new Error('unused'); }
  async refund(): Promise<Refund> { throw new Error('unused'); }
  async reportUsage(input: { customerRef: string }): Promise<void> {
    reportUsageCalls += 1;
    reportUsageCustomerRefs.push(input.customerRef);
    if (reportUsageCalls === 1) throw new Error('provider unavailable');
  }
  async verifyWebhook(): Promise<never> { throw new Error('unused'); }
}
const provider = new FakeProvider();

const policy = { ...DEFAULT_POLICY, usage: { ...DEFAULT_POLICY.usage, includedQuantity: 5, overage: 'hard_block' as const, lateReportWindowHours: 48 } };

const sub: Subscription = {
  id: 'sub_1', customerId: 'cust_1', planId: 'plan_pro', provider: 'stripe', providerRef: 'sub_stripe_1',
  status: 'active', currentPeriod: { start: new Date('2026-02-01T00:00:00Z'), end: new Date('2026-03-01T00:00:00Z') },
  anchorDay: 1, cancelAtPeriodEnd: false, graceUntil: null, billingKey: null, scheduledPlanId: null,
  createdAt: new Date('2026-01-01T00:00:00Z'), version: 0,
};

// EC:C2 (plan-aware attribution) — monthly plan, so periodContaining(sub.createdAt, 'month', ...) applies.
const plan: Plan = { id: 'plan_pro', name: 'Pro', interval: 'month', creditsPerPeriod: 0, usageIncluded: 5, trialDays: 0, prices: [] };

async function main() {
  // ── EC:C2 — on-time event ──
  const r1 = await record({
    event: { customerId: sub.customerId, meter: 'api_call', quantity: 3, occurredAt: new Date('2026-02-02T00:00:00Z'), idempotencyKey: 'evt_1' },
    sub, policy, repo, clock, ids, provider,
  });
  console.log('record #1 (on-time, qty=3):', r1.duplicated, r1.event.periodStart.toISOString());

  // ── EC:C2 — late report WITHIN window, no `plan` -> length-approximation previous period ──
  const r2Approx = await record({
    event: { customerId: sub.customerId, meter: 'api_call', quantity: 2, occurredAt: new Date('2026-01-30T00:00:00Z'), idempotencyKey: 'evt_2a' },
    sub, policy, repo, clock, ids,
  });
  console.log('record #2a (late, within window, no plan -> approximation):', r2Approx.event.periodStart.toISOString());

  // ── EC:C2 — same late report WITH `plan` -> exact periodContaining(sub.createdAt, plan.interval, ...) ──
  // sub.createdAt=2026-01-01, interval='month' -> the period containing 2026-01-30 is [2026-01-01, 2026-02-01), so .start = Jan 1 exactly (vs the ~Jan 4 approximation above).
  const r2Exact = await record({
    event: { customerId: sub.customerId, meter: 'api_call', quantity: 2, occurredAt: new Date('2026-01-30T00:00:00Z'), idempotencyKey: 'evt_2b' },
    sub, policy, repo, clock, ids, plan,
  });
  console.log('record #2b (late, within window, WITH plan -> exact):', r2Exact.event.periodStart.toISOString(), '(exact Jan 1, vs approximation above)');

  // ── EC:C2 — late report OUTSIDE window (clock advances past 48h) -> attributed to current period ──
  clock.advance(9 * 24 * 60 * 60 * 1000); // now 10 days into the period
  const r3 = await record({
    event: { customerId: sub.customerId, meter: 'api_call', quantity: 4, occurredAt: new Date('2026-01-25T00:00:00Z'), idempotencyKey: 'evt_3' },
    sub, policy, repo, clock, ids,
  });
  console.log('record #3 (late, outside window, qty=4):', r3.event.periodStart.toISOString(), '(== current period start)');

  // ── EC:C2 — dedupe by idempotencyKey ──
  const r3dup = await record({
    event: { customerId: sub.customerId, meter: 'api_call', quantity: 4, occurredAt: new Date('2026-01-25T00:00:00Z'), idempotencyKey: 'evt_3' },
    sub, policy, repo, clock, ids,
  });
  console.log('record #3 dup:', r3dup.duplicated);

  // ── EC:C1 EC:C5 — check(): current-period total is 3+4=7, already over included=5 ──
  const checkResult = await check({ customerId: sub.customerId, meter: 'api_call', quantity: 1, sub, policy, repo, ledger, clock });
  console.log('\n[check hard_block]', JSON.stringify(checkResult, null, 2));

  const freshSub: Subscription = { ...sub, customerId: 'cust_2' };
  const checkOk = await check({ customerId: freshSub.customerId, meter: 'api_call', quantity: 3, sub: freshSub, policy, repo, ledger, clock });
  console.log('[check within_included]', JSON.stringify(checkOk, null, 2));

  // ── EC:C9 — closePeriod aggregate ──
  const closed = await closePeriod({ sub, policy, repo, provider, clock, ids });
  console.log('\n[closePeriod]', JSON.stringify(closed, null, 2));

  // ── EC:C4 — flushOutbox customerRef resolution ──
  // cust_1 has a stripe providerRef registered; cust_3 (a stray, unlinked customer) does not.
  await repo.customers.put({ id: 'cust_1', email: null, providerRefs: [{ provider: 'stripe', ref: 'cus_stripe_1' }], status: 'active', createdAt: sub.createdAt });
  const strayEvent = await record({
    event: { customerId: 'cust_3', meter: 'api_call', quantity: 1, occurredAt: clock.now(), idempotencyKey: 'evt_stray' },
    sub, policy, repo, clock, ids, provider,
  });
  console.log('\nrecorded stray event for unlinked customer cust_3:', strayEvent.event.id);

  // fails once (attempt 1, cust_1's item), no_provider_ref immediately (cust_3's item, no retry needed)
  const flush1 = await flushOutbox({ repo, providers: { stripe: provider }, clock, maxAttempts: 8 });
  console.log('\n[flushOutbox #1]', JSON.stringify(flush1));
  const pendingAfter1 = await repo.outbox.list({ kind: 'usage.report' });
  console.log('outbox after #1:', pendingAfter1.map((i) => ({ status: i.status, attempts: i.attempts, error: (i.payload as { error?: string }).error ?? null })));

  clock.advance(70 * 60 * 1000); // past the 2^1=2min backoff
  const flush2 = await flushOutbox({ repo, providers: { stripe: provider }, clock, maxAttempts: 8 });
  console.log('[flushOutbox #2]', JSON.stringify(flush2));
  const pendingAfter2 = await repo.outbox.list({ kind: 'usage.report' });
  console.log('outbox after #2 (cust_1 item: attempts=2 sent; cust_3 item: unchanged, failed/no_provider_ref):', pendingAfter2.map((i) => ({ status: i.status, attempts: i.attempts, error: (i.payload as { error?: string }).error ?? null })));
  console.log('reportUsage was called with customerRef (never the internal customerId):', reportUsageCustomerRefs);

  console.log('\nsmoke: OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
