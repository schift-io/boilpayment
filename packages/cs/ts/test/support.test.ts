import { expect, it } from 'vitest';
import { FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen, resolvePolicy } from 'boilpayment-core';
import type { Payment, PaymentProvider, Refund } from 'boilpayment-core';
import { topup, grantForPeriod } from '../../../credits/ts/src/index.js';
import { requestRefund, recoverMissingGrant, resolveTopupCredits, startCheckout, registerCompletedCheckout, finishRefundCases } from '../src/index.js';

async function setup(mode: 'auto' | 'manual_approve' | 'off' = 'auto', reasons?: { userError?: 'rules' | 'deny'; dissatisfied?: 'rules' | 'evidence_required' | 'needs_human' }) {
  const clock = new FixedClock(new Date('2026-01-01T00:00:00Z')); const ids = new SequentialIdGen('support_');
  const repo = new InMemoryRepo(); const ledger = new InMemoryLedger(ids);
  const policy = resolvePolicy({ cs: { regrant: { mode } }, ...(reasons ? { refund: { reasons } } : {}) });
  const payment: Payment = { id: 'payment', customerId: 'customer', provider: 'stripe', providerRef: 'pi_1',
    subscriptionId: null, amount: { amountMinor: 1000, currency: 'USD' }, status: 'succeeded', kind: 'topup',
    period: null, occurredAt: clock.now(), failure: null, cashReceipt: null };
  await repo.customers.put({ id: 'customer', email: null, providerRefs: [{ provider: 'stripe', ref: 'cus_1' }], status: 'active', createdAt: clock.now() });

  await repo.plans.put({ id: 'credits100', name: '100 credits', interval: null, creditsPerPeriod: 100, usageIncluded: 0, trialDays: 0, prices: [{ currency: 'USD', amountMinor: 1000 }] });
  let refunds = 0; let checkoutKey = ""; let checkouts = 0;
  const unused = async (): Promise<never> => { throw new Error('unused'); };
  const provider: PaymentProvider = { name: 'stripe', capabilities: () => ({ nativeSubscriptions: true, partialRefund: true, meters: false, scheduling: 'provider', webhookSignature: true }),
    createCustomer: unused, createCheckout: async (args) => { checkouts += 1; checkoutKey = args.metadata?.checkoutEntitlementKey ?? ''; return { id: 'cs_1', url: 'https://example.test/checkout', providerRef: 'cs_1' }; }, getPayment: async () => ({ ...payment, customerId: 'cus_1', raw: { metadata: { checkoutEntitlementKey: checkoutKey } } }), listPayments: async () => [payment],
    getSubscription: unused, changeSubscription: unused, cancelSubscription: unused, chargeBillingKey: unused, reportUsage: unused, verifyWebhook: unused,
    refund: async (input): Promise<Refund> => { refunds += 1; return { id: 'refund', paymentId: payment.id, customerId: payment.customerId, amount: input.amount, status: 'succeeded', providerRef: 're_1', creditsRevoked: 0, ruleId: '', reason: null, failure: null, createdAt: clock.now() }; } };
  const deps = { clock, ids, repo, ledger, policy, providers: { stripe: provider } };
  await startCheckout({ ...deps, customerId: 'customer', planId: 'credits100', provider: 'stripe', currency: 'USD', requestId: 'sale', successUrl: 'https://example.test/ok', cancelUrl: 'https://example.test/cancel' });
  const registered = await registerCompletedCheckout({ ...deps, customerId: 'customer', checkoutId: 'cs_1', paymentRef: payment.providerRef });
  return { ...deps, customerId: 'customer', paymentId: registered.id, grants: { topup, grantForPeriod }, payment: registered, calls: () => refunds, checkoutCalls: () => checkouts };
}

it('recovers exact plan entitlement and shares the late-webhook grant key', async () => {
  const input = await setup();
  const result = await recoverMissingGrant(input);
  expect(result.status).toBe('resolved_auto');
  const credits = await resolveTopupCredits({ payment: input.payment, repo: input.repo });
  expect(credits).toBe(100);
  await topup({ ...input, payment: input.payment, credits: credits ?? 0 });
  await recoverMissingGrant(input);
  const entries = await input.ledger.entries('customer', { kind: 'grant' });
  expect(entries).toHaveLength(1); expect(entries[0]?.idempotencyKey).toBe(`topup:${input.payment.id}`);
  expect(entries[0]?.reference.paymentId).toBe(input.payment.id);
});
it.each(['manual_approve', 'off'] as const)('obeys %s missing-credit rule without caller approval', async (mode) => {
  const input = await setup(mode); const result = await recoverMissingGrant(input);
  expect(result.status).toBe(mode === 'off' ? 'rejected' : 'needs_human');
  expect(await input.ledger.entries('customer')).toHaveLength(0);
});
it('refunds using IDs and replays the same request once', async () => {
  const input = await setup(); await recoverMissingGrant(input);
  const result = await requestRefund({ ...input, requestId: 'request-1', requestedAmount: { amountMinor: 500, currency: 'USD' } });
  expect(result.status).toBe('resolved_auto');
  await requestRefund({ ...input, requestId: 'request-1', requestedAmount: { amountMinor: 500, currency: 'USD' } });
  expect(input.calls()).toBe(1); expect((await input.ledger.balance('customer', 'paid', input.clock.now())).available).toBe(50);
});
it('rejects cross-customer refund requests without a provider mutation', async () => {
  const input = await setup(); const result = await requestRefund({ ...input, customerId: 'other' });
  expect(result.status).toBe('rejected'); expect(input.calls()).toBe(0);
});
it('uses immutable sale entitlement after current catalog changes', async () => {
  const input = await setup();
  await input.repo.plans.put({ id: 'other', name: 'Other', interval: null, creditsPerPeriod: 500, usageIncluded: 0, trialDays: 0, prices: [{ currency: 'USD', amountMinor: 1000 }] });
  expect((await recoverMissingGrant(input)).status).toBe('resolved_auto');
  expect((await input.ledger.balance('customer', 'paid', input.clock.now())).available).toBe(100);
});

it('escalates a persisted payment without a captured sale', async () => {
  const input = await setup(); const orphan = { ...input.payment, id: 'orphan' };
  await input.repo.payments.put(orphan);
  expect((await recoverMissingGrant({ ...input, paymentId: orphan.id })).status).toBe('needs_human');
  expect(await input.ledger.entries('customer')).toHaveLength(0);
});

it('replays checkout creation without another provider request', async () => {
  const input = await setup();
  await startCheckout({ ...input, customerId: 'customer', planId: 'credits100', provider: 'stripe', currency: 'USD', requestId: 'sale', successUrl: 'https://example.test/ok', cancelUrl: 'https://example.test/cancel' });
  expect(input.checkoutCalls()).toBe(1);
});
it('keeps native subscription entitlement from sale after catalog credits change', async () => {
  const input = await setup(); const provider = input.providers.stripe;
  const period = { start: input.clock.now(), end: new Date('2026-02-01T00:00:00Z') };
  const plan = { id: 'monthly', name: 'Monthly', interval: 'month' as const, creditsPerPeriod: 100, usageIncluded: 0, trialDays: 0, prices: [{ currency: 'USD', amountMinor: 1000 }] };
  await input.repo.plans.put(plan);
  provider.createCheckout = async () => ({ id: 'cs_sub', url: 'https://example.test/sub', providerRef: 'cs_sub' });
  provider.getPayment = async () => ({ ...input.payment, providerRef: 'pi_sub', kind: 'subscription', subscriptionId: 'sub_remote', period, customerId: 'cus_1', raw: { metadata: { checkoutEntitlementKey: 'checkout-entitlement:customer:sub-sale' } } });
  provider.listPayments = async () => [await provider.getPayment('pi_sub')];
  provider.getSubscription = async () => ({ id: 'sub_remote', customerId: 'cus_1', planId: 'monthly', provider: 'stripe', providerRef: 'sub_remote', status: 'active', currentPeriod: period, anchorDay: 1, cancelAtPeriodEnd: false, graceUntil: null, billingKey: null, scheduledPlanId: null, version: 0, createdAt: input.clock.now() });
  await startCheckout({ ...input, planId: 'monthly', provider: 'stripe', currency: 'USD', requestId: 'sub-sale', successUrl: 'https://example.test/ok', cancelUrl: 'https://example.test/cancel' });
  await input.repo.plans.put({ ...plan, creditsPerPeriod: 500 });
  const payment = await registerCompletedCheckout({ ...input, checkoutId: 'cs_sub', paymentRef: 'pi_sub' });
  const result = await recoverMissingGrant({ ...input, paymentId: payment.id });
  expect(result.status).toBe('resolved_auto');
  const grants = await input.ledger.entries('customer', { kind: 'grant' });
  expect(grants[0]?.amount).toBe(100); expect(grants[0]?.source).toBe('subscription');
  expect(grants[0]?.expiresAt).toEqual(period.end);
});
it('finishes a pending case only after persisted confirmed settlement', async () => {
  const input = await setup(); await recoverMissingGrant(input);
  input.providers.stripe.refund = async (args) => ({ id: 're_pending', paymentId: input.payment.id, customerId: 'customer', amount: args.amount, status: 'pending', providerRef: 're_pending', creditsRevoked: 0, ruleId: 'D1', reason: null, failure: null, createdAt: input.clock.now() });
  const pending = await requestRefund(input);
  expect(pending.status).toBe('needs_human'); expect(await finishRefundCases(input)).toHaveLength(0);
  const refunds = await input.repo.refunds.list({ paymentId: input.payment.id });
  const refund = refunds[0]; if (!refund) throw new Error('missing persisted refund');
  await input.repo.refunds.put({ ...refund, status: 'succeeded' });
  const completed = await finishRefundCases(input);
  expect(completed[0]?.id).toBe(pending.id); expect(completed[0]?.status).toBe('resolved_auto');
  expect(await finishRefundCases(input)).toHaveLength(0);
  expect((await requestRefund(input)).status).toBe('resolved_auto');
});

it('concurrent and repeated recovery creates one case, grant and billable report', async () => {
  const input = await setup(); let reports = 0;
  const reporter = { reportCase: async () => { reports += 1; }, entitlement: async () => null, heartbeat: async () => {} };
  await Promise.allSettled([recoverMissingGrant({ ...input, reporter }), recoverMissingGrant({ ...input, reporter })]);
  const replay = await recoverMissingGrant({ ...input, reporter });
  expect(replay.status).toBe('resolved_auto');
  const cases = await input.repo.csCases.list({ kind: 'regrant', referenceId: input.paymentId });
  expect(cases).toHaveLength(1); expect(cases[0]?.id).toBe(replay.id);
  expect(await input.ledger.entries('customer', { kind: 'grant' })).toHaveLength(1);
  expect(reports).toBe(1);
});

// EC:D16 — the reason reaches refund.evaluate through requestRefund
it('refund reason rules apply through requestRefund: user_error denied, dissatisfied without evidence to a person', async () => {
  const denied = await setup('auto', { userError: 'deny', dissatisfied: 'evidence_required' }); await recoverMissingGrant(denied);
  const r1 = await requestRefund({ ...denied, requestId: 'r-user', reason: { category: 'user_error' } });
  expect(r1.status).toBe('rejected'); expect(denied.calls()).toBe(0);
  const r2 = await requestRefund({ ...denied, requestId: 'r-dis', reason: { category: 'dissatisfied' } });
  expect(r2.status).toBe('needs_human'); expect(denied.calls()).toBe(0);
  const r3 = await requestRefund({ ...denied, requestId: 'r-dis-ev', reason: { category: 'dissatisfied', evidenceRef: 'job_1' } });
  expect(r3.status).toBe('resolved_auto'); expect(denied.calls()).toBe(1);
});
