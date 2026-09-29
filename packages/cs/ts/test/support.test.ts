import { expect, it } from 'vitest';
import { FixedClock, InMemoryLedger, InMemoryRepo, PaymentKitError, ProviderError, SequentialIdGen, hashPayload, resolvePolicy } from 'boilpayment-core';
import type { Payment, PaymentProvider, ProviderName, Refund } from 'boilpayment-core';
import { topup, grantForPeriod } from '../../../credits/ts/src/index.js';
import { requestRefund, recoverMissingGrant, recoverMissingGrants, resolveTopupCredits, startCheckout, registerCompletedCheckout, finishRefundCases } from '../src/index.js';

async function setup(mode: 'auto' | 'manual_approve' | 'off' = 'auto', reasons?: { userError?: 'rules' | 'deny'; dissatisfied?: 'rules' | 'evidence_required' | 'needs_human' }) {
  const clock = new FixedClock(new Date('2026-01-01T00:00:00Z')); const ids = new SequentialIdGen('support_');
  const repo = new InMemoryRepo(); const ledger = new InMemoryLedger(ids);
  const policy = resolvePolicy({ cs: { regrant: { mode } }, ...(reasons ? { refund: { reasons } } : {}) });
  const payment: Payment = { id: 'payment', customerId: 'customer', provider: 'stripe', providerRef: 'pi_1',
    subscriptionId: null, amount: { amountMinor: 1000, currency: 'USD' }, status: 'succeeded', kind: 'topup',
    period: null, occurredAt: clock.now(), failure: null, cashReceipt: null };
  await repo.customers.put({ id: 'customer', email: null, providerRefs: [{ provider: 'stripe', ref: 'cus_1' }], status: 'active', createdAt: clock.now() });

  await repo.plans.put({ id: 'credits100', name: '100 credits', interval: null, creditsPerPeriod: 100, usageIncluded: 0, trialDays: 0, prices: [{ currency: 'USD', amountMinor: 1000, providerPriceRefs: { stripe: 'price_credits100' } }] });
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

it.each(['stripe', 'polar'] as const)('[OT-03] %s missing provider price propagates without poisoning the retry', async (providerName) => {
  const clock = new FixedClock(new Date('2026-01-01T00:00:00Z'));
  const ids = new SequentialIdGen('ot03_');
  const repo = new InMemoryRepo();
  const ledger = new InMemoryLedger(ids);
  const policy = resolvePolicy();
  await repo.customers.put({
    id: 'ot03-customer', email: null, providerRefs: [{ provider: providerName, ref: 'cus_ot03' }],
    status: 'active', createdAt: clock.now(),
  });
  await repo.plans.put({
    id: 'ot03-plan', name: 'OT-03', interval: null, creditsPerPeriod: 100, usageIncluded: 0,
    trialDays: 0, prices: [{ currency: 'USD', amountMinor: 1999 }],
  });
  let calls = 0;
  const unused = async (): Promise<never> => { throw new Error('unused'); };
  const provider: PaymentProvider = {
    name: providerName,
    capabilities: () => ({ nativeSubscriptions: true, partialRefund: true, meters: false, scheduling: 'provider', webhookSignature: true, checkout: 'hosted' }),
    createCustomer: unused,
    createCheckout: async (args) => {
      calls += 1;
      if (!args.price.providerPriceRefs?.[providerName]) {
        throw new PaymentKitError('set plan_prices.provider_price_refs for OT-03', 'missing_provider_price_ref');
      }
      return { id: 'cs_ot03', url: 'https://example.test/checkout', providerRef: 'cs_ot03' };
    },
    getPayment: unused, listPayments: unused, getSubscription: unused, changeSubscription: unused,
    cancelSubscription: unused, chargeBillingKey: unused, reportUsage: unused, verifyWebhook: unused, refund: unused,
  };
  const request = {
    clock, ids, repo, ledger, policy, providers: { [providerName]: provider }, customerId: 'ot03-customer',
    planId: 'ot03-plan', provider: providerName, currency: 'USD', requestId: 'ot-03',
    successUrl: 'https://example.test/ok', cancelUrl: 'https://example.test/cancel',
  };

  await expect(startCheckout(request)).rejects.toMatchObject({
    code: 'missing_provider_price_ref', message: expect.stringContaining('plan_prices'),
  });
  expect(calls).toBe(0);
  expect(await repo.operations.get('checkout-result:ot03-customer:ot-03')).toBeNull();

  const legacyKey = 'checkout-result:ot03-customer:ot-03';
  await repo.operations.put({
    id: legacyKey, key: legacyKey, kind: 'checkout.entitlement',
    payloadHash: hashPayload({ key: 'checkout-entitlement:ot03-customer:ot-03', successUrl: request.successUrl, cancelUrl: request.cancelUrl }),
    status: 'done', result: { kind: 'unknown' }, error: null, createdAt: clock.now(), completedAt: clock.now(), attempts: 1,
  });
  await expect(startCheckout(request)).rejects.toMatchObject({ code: 'missing_provider_price_ref' });
  expect(await repo.operations.get(legacyKey)).toMatchObject({ status: 'failed' });
  expect(calls).toBe(0);

  await repo.plans.put({
    id: 'ot03-plan', name: 'OT-03', interval: null, creditsPerPeriod: 100, usageIncluded: 0,
    trialDays: 0, prices: [{ currency: 'USD', amountMinor: 1999, providerPriceRefs: { [providerName]: 'price_ot03' } }],
  });
  await expect(startCheckout(request)).resolves.toMatchObject({ id: 'cs_ot03' });
  expect(calls).toBe(1);
});

it.each([[400, 'provider'], [500, 'checkout_outcome_unknown'], [null, 'checkout_outcome_unknown']] as const)('[OT-03, DC-06] provider HTTP %s maps only uncertain outcomes to unknown', async (status, expectedCode) => {
  const input = await setup();
  const provider = input.providers.stripe;
  provider.createCheckout = async () => {
    throw new ProviderError(`provider ${status ?? 'transport'}`, {
      code: 'unknown', providerCode: status === null ? null : String(status), retryable: status === null || status >= 500, userMessage: 'failed',
    }, status === null ? undefined : { status }, status ?? undefined);
  };
  const call = startCheckout({ ...input, customerId: 'customer', planId: 'credits100', provider: 'stripe',
    currency: 'USD', requestId: `provider-${status ?? 'transport'}`, successUrl: 'https://example.test/ok', cancelUrl: 'https://example.test/cancel' });
  await expect(call).rejects.toMatchObject({ code: expectedCode });
  if (status === 400) {
    expect(await input.repo.operations.get('checkout-entitlement:customer:provider-400')).toBeNull();
    expect(await input.repo.operations.get('checkout-result:customer:provider-400')).toBeNull();
  }
});

it.each([[7, true], [0, false]] as const)('[SB-03] trialDays=%s accepts only a trialing zero-amount first invoice', async (trialDays, accepted) => {
  const input = await setup();
  const provider = input.providers.stripe;
  const period = { start: input.clock.now(), end: new Date('2026-02-01T00:00:00Z') };
  const plan = { id: `sb03-${trialDays}`, name: 'SB-03', interval: 'month' as const, creditsPerPeriod: 1000,
    usageIncluded: 0, trialDays, prices: [{ currency: 'USD', amountMinor: 1999, providerPriceRefs: { stripe: `price_sb03_${trialDays}` } }] };
  const checkoutId = `cs_sb03_${trialDays}`;
  const paymentRef = `in_sb03_${trialDays}`;
  await input.repo.plans.put(plan);
  provider.createCheckout = async () => ({ id: checkoutId, url: 'https://example.test/sub', providerRef: checkoutId });
  const invoice: Payment = { ...input.payment, providerRef: paymentRef, kind: 'subscription', subscriptionId: `sub_sb03_${trialDays}`,
    amount: { amountMinor: 0, currency: 'USD' }, period, customerId: 'cus_1',
    raw: { metadata: { checkoutEntitlementKey: `checkout-entitlement:customer:sb03-${trialDays}` } } };
  provider.getPayment = async () => invoice;
  provider.listPayments = async () => [invoice];
  provider.getSubscription = async () => ({ id: invoice.subscriptionId ?? '', customerId: 'cus_1', planId: plan.id,
    provider: 'stripe', providerRef: invoice.subscriptionId ?? '', status: 'trialing', currentPeriod: period, anchorDay: 1,
    cancelAtPeriodEnd: false, graceUntil: null, billingKey: null, scheduledPlanId: null, currency: 'USD', version: 0,
    createdAt: input.clock.now() });
  await startCheckout({ ...input, planId: plan.id, provider: 'stripe', currency: 'USD', requestId: `sb03-${trialDays}`,
    successUrl: 'https://example.test/ok', cancelUrl: 'https://example.test/cancel' });

  const registration = registerCompletedCheckout({ ...input, checkoutId, paymentRef });
  if (!accepted) {
    // DC-07 — a paid-zero subscription invoice that is not a trial is recorded, never granted.
    const zero = await registration;
    expect(zero.amount).toEqual({ amountMinor: 0, currency: 'USD' });
    const cases = (await input.repo.csCases.list()).filter((item) => item.referenceId === zero.id && item.status === 'needs_human');
    expect(cases).toHaveLength(1);
    expect(await input.repo.operations.get(`purchase-entitlement:${zero.id}`)).toBeNull();
    expect(await input.ledger.entries('customer', { kind: 'grant' })).toHaveLength(0);
    return;
  }
  await expect(registration).resolves.toMatchObject({ amount: { amountMinor: 0, currency: 'USD' } });
  expect(await input.repo.subscriptions.get(`subscription:stripe:${invoice.subscriptionId}`)).toMatchObject({ status: 'trialing', planId: plan.id });
  expect(await input.ledger.entries('customer', { kind: 'grant' })).toHaveLength(0);
});

it('[SB-03] recovery preserves and permanently ignores a marked Stripe trial-opening invoice', async () => {
  const input = await setup();
  await recoverMissingGrant(input);
  const provider = input.providers.stripe;
  const since = new Date('2025-12-31T00:00:00Z');
  const trialPeriod = { start: input.clock.now(), end: new Date('2026-01-15T00:00:00Z') };
  const paidPeriod = { start: trialPeriod.end, end: new Date('2026-02-15T00:00:00Z') };
  const plan = {
    id: 'sb03-recovery', name: 'SB-03 recovery', interval: 'month' as const, creditsPerPeriod: 1000,
    usageIncluded: 0, trialDays: 14,
    prices: [{ currency: 'USD', amountMinor: 1999, providerPriceRefs: { stripe: 'price_sb03_recovery' } }],
  };
  const subscriptionId = 'subscription:stripe:sub_sb03_recovery';
  const sub = {
    id: subscriptionId, customerId: 'customer', planId: plan.id, provider: 'stripe' as const,
    providerRef: 'sub_sb03_recovery', status: 'active' as const, currentPeriod: paidPeriod, anchorDay: 15,
    cancelAtPeriodEnd: false, graceUntil: null, billingKey: null, scheduledPlanId: null, currency: 'USD',
    version: 0, createdAt: input.clock.now(),
  };
  const openingInvoice: Payment = {
    id: 'remote-sb03-opening', customerId: 'cus_1', provider: 'stripe', providerRef: 'in_sb03_opening',
    subscriptionId: sub.providerRef, amount: { amountMinor: 0, currency: 'USD' }, status: 'succeeded',
    kind: 'subscription', period: trialPeriod, occurredAt: trialPeriod.start, failure: null, cashReceipt: null,
    raw: { billing_reason: 'subscription_create' },
  };
  await input.repo.plans.put(plan);
  await input.repo.subscriptions.put(sub);
  await input.repo.payments.put({
    ...openingInvoice,
    id: 'local-sb03-opening',
    customerId: 'customer',
    subscriptionId,
    raw: { billing_reason: 'subscription_create', boilpaymentTrialOpeningInvoice: true },
  });
  provider.listPayments = async () => [openingInvoice];

  const firstCases = await recoverMissingGrants({ ...input, grants: input.grants, since });
  const recorded = (await input.repo.payments.list({ providerRef: openingInvoice.providerRef }))[0];
  expect(recorded).toMatchObject({
    customerId: 'customer', subscriptionId, raw: expect.objectContaining({ boilpaymentTrialOpeningInvoice: true }),
  });
  expect(firstCases).toHaveLength(0);
  expect(await input.ledger.entries('customer', { kind: 'grant', source: 'subscription' })).toHaveLength(0);
  expect(await input.repo.csCases.list({ referenceId: recorded?.id })).toHaveLength(0);

  provider.listPayments = async () => [];
  const replayCases = await recoverMissingGrants({ ...input, grants: input.grants, since });
  expect(replayCases).toHaveLength(0);
  expect(await input.ledger.entries('customer', { kind: 'grant', source: 'subscription' })).toHaveLength(0);
  expect(await input.repo.csCases.list({ referenceId: recorded?.id })).toHaveLength(0);
});

it('[SB-03] recovery does not silently ignore an unmarked active zero-amount invoice', async () => {
  const input = await setup();
  await recoverMissingGrant(input);
  const provider = input.providers.stripe;
  const since = new Date('2025-12-31T00:00:00Z');
  const period = { start: input.clock.now(), end: new Date('2026-01-15T00:00:00Z') };
  const plan = {
    id: 'sb03-unmarked', name: 'SB-03 unmarked', interval: 'month' as const, creditsPerPeriod: 1000,
    usageIncluded: 0, trialDays: 14,
    prices: [{ currency: 'USD', amountMinor: 1999, providerPriceRefs: { stripe: 'price_sb03_unmarked' } }],
  };
  const subscriptionId = 'subscription:stripe:sub_sb03_unmarked';
  const sub = {
    id: subscriptionId, customerId: 'customer', planId: plan.id, provider: 'stripe' as const,
    providerRef: 'sub_sb03_unmarked', status: 'active' as const, currentPeriod: period, anchorDay: 15,
    cancelAtPeriodEnd: false, graceUntil: null, billingKey: null, scheduledPlanId: null, currency: 'USD',
    version: 0, createdAt: input.clock.now(),
  };
  const invoice: Payment = {
    id: 'remote-sb03-unmarked', customerId: 'cus_1', provider: 'stripe', providerRef: 'in_sb03_unmarked',
    subscriptionId: sub.providerRef, amount: { amountMinor: 0, currency: 'USD' }, status: 'succeeded',
    kind: 'subscription', period, occurredAt: period.start, failure: null, cashReceipt: null,
    raw: { billing_reason: 'subscription_create' },
  };
  await input.repo.plans.put(plan);
  await input.repo.subscriptions.put(sub);
  provider.listPayments = async () => [invoice];

  const cases = await recoverMissingGrants({ ...input, grants: input.grants, since });
  const recorded = (await input.repo.payments.list({ providerRef: invoice.providerRef }))[0];
  expect(recorded?.raw).not.toMatchObject({ boilpaymentTrialOpeningInvoice: true });
  expect(cases).toEqual([expect.objectContaining({ kind: 'reconcile_mismatch', status: 'needs_human' })]);
  expect(await input.ledger.entries('customer', { kind: 'grant', source: 'subscription' })).toHaveLength(0);
});

it.each(['stripe', 'polar'] as const)('[SB-06] %s prefers the subscription intended plan when catalog matches are ambiguous', async (providerName) => {
  const input = await setup();
  await recoverMissingGrant(input);
  const provider = input.providers.stripe;
  const since = new Date('2025-12-31T00:00:00Z');
  const previousPeriod = { start: new Date('2025-12-01T00:00:00Z'), end: new Date('2026-01-01T00:00:00Z') };
  const renewalPeriod = { start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-02-01T00:00:00Z') };
  const sharedRef = providerName === 'polar' ? 'product_sb06_shared' : 'price_sb06_intended';
  const intended = { id: `sb06-${providerName}-intended`, name: 'Intended', interval: 'month' as const, creditsPerPeriod: 1000,
    usageIncluded: 0, trialDays: 0, prices: [{ currency: 'usd', amountMinor: 1999, providerPriceRefs: { [providerName]: sharedRef } }] };
  const duplicate = { ...intended, id: `sb06-${providerName}-duplicate`, name: 'Duplicate', creditsPerPeriod: 2000,
    prices: [{ currency: 'USD', amountMinor: 1999, providerPriceRefs: { [providerName]: providerName === 'polar' ? sharedRef : 'price_sb06_duplicate' } }] };
  const subscriptionId = `subscription:${providerName}:sub_sb06_ambiguous`;
  const sub = { id: subscriptionId, customerId: 'customer', planId: intended.id, provider: providerName,
    providerRef: 'sub_sb06_ambiguous', status: 'active' as const, currentPeriod: previousPeriod, anchorDay: 1,
    cancelAtPeriodEnd: false, graceUntil: null, billingKey: null, scheduledPlanId: null, currency: 'USD', version: 0,
    createdAt: input.clock.now() };
  const renewal: Payment = { id: 'provider-payment-sb06-ambiguous', customerId: 'cus_sb06_ambiguous', provider: providerName,
    providerRef: `pay_sb06_${providerName}`, subscriptionId: sub.providerRef, amount: { amountMinor: 1999, currency: 'USD' },
    status: 'succeeded', kind: 'subscription', period: providerName === 'polar' ? null : renewalPeriod,
    occurredAt: renewalPeriod.start, failure: null, cashReceipt: null,
    raw: providerName === 'polar' ? { product: { id: sharedRef } } : undefined };
  await input.repo.customers.put({ id: 'customer', email: null,
    providerRefs: [{ provider: providerName, ref: renewal.customerId }], status: 'active', createdAt: input.clock.now() });
  await input.repo.plans.put(intended); await input.repo.plans.put(duplicate); await input.repo.subscriptions.put(sub);
  provider.listPayments = async () => [renewal];
  provider.getSubscription = async () => ({ ...sub, currentPeriod: renewalPeriod });
  const deps = { ...input, providers: { [providerName]: provider } as Partial<Record<ProviderName, PaymentProvider>> };

  const cases = await recoverMissingGrants({ ...deps, grants: input.grants, since });
  await recoverMissingGrants({ ...deps, grants: input.grants, since });
  const grants = await input.ledger.entries('customer', { kind: 'grant', source: 'subscription' });
  expect(grants).toHaveLength(1);
  expect(grants[0]?.amount).toBe(1000);
  expect(cases).toHaveLength(0);
  expect(await input.repo.csCases.list({ kind: 'reconcile_mismatch' })).toHaveLength(0);
});

it.each([
  ['stripe', 'active'], ['stripe', 'past_due'], ['polar', 'active'], ['polar', 'past_due'],
] as const)('[SB-06] %s %s provider-only renewal is persisted and granted exactly once', async (providerName, status) => {
  const input = await setup();
  await recoverMissingGrant(input);
  const provider = input.providers.stripe;
  const since = new Date('2025-12-31T00:00:00Z');
  const previousPeriod = { start: new Date('2025-12-01T00:00:00Z'), end: new Date('2026-01-01T00:00:00Z') };
  const renewalPeriod = { start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-02-01T00:00:00Z') };
  const plan = {
    id: 'sb06-plan', name: 'SB-06', interval: 'month' as const, creditsPerPeriod: 100,
    usageIncluded: 0, trialDays: 0, prices: [{ currency: 'USD', amountMinor: 1000, providerPriceRefs: { [providerName]: 'price_sb06' } }],
  };
  const subscriptionId = `subscription:${providerName}:sub_sb06`;
  const sub = {
    id: subscriptionId, customerId: 'customer', planId: plan.id, provider: providerName, providerRef: 'sub_sb06',
    status, currentPeriod: previousPeriod, anchorDay: 1, cancelAtPeriodEnd: false, graceUntil: null,
    billingKey: null, scheduledPlanId: null, currency: 'USD', version: 0, createdAt: input.clock.now(),
  };
  const renewal: Payment = {
    id: 'provider-payment-sb06', customerId: 'cus_sb06', provider: providerName, providerRef: 'pay_sb06',
    subscriptionId: 'sub_sb06', amount: { amountMinor: 1000, currency: 'USD' }, status: 'succeeded',
    kind: 'subscription', period: providerName === 'polar' ? null : renewalPeriod,
    occurredAt: renewalPeriod.start, failure: null, cashReceipt: null,
  };
  await input.repo.customers.put({
    id: 'customer', email: null, providerRefs: [{ provider: providerName, ref: 'cus_sb06' }],
    status: 'active', createdAt: input.clock.now(),
  });
  await input.repo.plans.put(plan);
  await input.repo.subscriptions.put(sub);
  const listCalls: Array<{ readonly customerRef: string; readonly since: Date }> = [];
  provider.listPayments = async (args) => { listCalls.push(args); return [renewal]; };
  provider.getSubscription = async () => ({ ...sub, currentPeriod: renewalPeriod });
  const deps = { ...input, providers: { [providerName]: provider } as Partial<Record<ProviderName, PaymentProvider>> };

  await recoverMissingGrants({ ...deps, grants: input.grants, since });
  const recorded = (await input.repo.payments.list()).find((payment) => payment.providerRef === renewal.providerRef);
  expect(recorded).toMatchObject({ customerId: 'customer', subscriptionId, kind: 'subscription', status: 'succeeded' });
  let grants = await input.ledger.entries('customer', { kind: 'grant', source: 'subscription' });
  expect(grants).toHaveLength(1);
  expect(grants[0]).toMatchObject({
    amount: 100, idempotencyKey: `grant:${subscriptionId}:${renewalPeriod.start.toISOString()}`,
    reference: { paymentId: recorded?.id, subscriptionId },
  });

  await recoverMissingGrants({ ...deps, grants: input.grants, since });
  if (!recorded) throw new Error('SB-06 renewal was not persisted');
  await grantForPeriod({ ...deps, sub: { ...sub, status: 'active' }, plan, period: renewalPeriod, payment: recorded });
  grants = await input.ledger.entries('customer', { kind: 'grant', source: 'subscription' });
  expect(grants).toHaveLength(1);
  expect(listCalls).toEqual([
    { customerRef: 'cus_sb06', since }, { customerRef: 'cus_sb06', since },
  ]);
});

it('[SB-06] Polar maps two periodless missed renewals to two sequential periods exactly once', async () => {
  const input = await setup(); await recoverMissingGrant(input);
  const provider = input.providers.stripe;
  const since = new Date('2025-12-31T00:00:00Z');
  const p0 = { start: new Date('2025-12-01T00:00:00Z'), end: new Date('2026-01-01T00:00:00Z') };
  const p1 = { start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-02-01T00:00:00Z') };
  const p2 = { start: new Date('2026-02-01T00:00:00Z'), end: new Date('2026-03-01T00:00:00Z') };
  const plan = { id: 'sb06-polar-plan', name: 'Polar monthly', interval: 'month' as const, creditsPerPeriod: 100,
    usageIncluded: 0, trialDays: 0, prices: [{ currency: 'USD', amountMinor: 1000, providerPriceRefs: { polar: 'product_sb06' } }] };
  const sub = { id: 'subscription:polar:sub_multi', customerId: 'customer', planId: plan.id, provider: 'polar' as const,
    providerRef: 'sub_multi', status: 'active' as const, currentPeriod: p0, anchorDay: 1, cancelAtPeriodEnd: false,
    graceUntil: null, billingKey: null, scheduledPlanId: null, currency: 'USD', version: 0, createdAt: input.clock.now() };
  const payment = (ref: string, occurredAt: Date): Payment => ({
    id: `remote-${ref}`, customerId: 'cus_multi', provider: 'polar', providerRef: ref, subscriptionId: 'sub_multi',
    amount: { amountMinor: 1000, currency: 'USD' }, status: 'succeeded', kind: 'subscription', period: null,
    occurredAt, failure: null, cashReceipt: null, raw: { product_id: 'product_sb06' },
  });
  await input.repo.customers.put({ id: 'customer', email: null, providerRefs: [{ provider: 'polar', ref: 'cus_multi' }],
    status: 'active', createdAt: input.clock.now() });
  await input.repo.plans.put(plan); await input.repo.subscriptions.put(sub);
  provider.listPayments = async () => [payment('order_2', p2.start), payment('order_1', p1.start)];
  const deps = { ...input, providers: { polar: provider } as Partial<Record<ProviderName, PaymentProvider>> };

  await recoverMissingGrants({ ...deps, grants: input.grants, since });
  let grants = await input.ledger.entries('customer', { kind: 'grant', source: 'subscription' });
  expect(grants.map((entry) => entry.idempotencyKey).sort()).toEqual([
    `grant:${sub.id}:${p1.start.toISOString()}`, `grant:${sub.id}:${p2.start.toISOString()}`,
  ]);
  expect((await input.repo.payments.list({ subscriptionId: sub.id })).map((item) => item.period?.start.toISOString()).sort())
    .toEqual([p1.start.toISOString(), p2.start.toISOString()]);

  await recoverMissingGrants({ ...deps, grants: input.grants, since });
  grants = await input.ledger.entries('customer', { kind: 'grant', source: 'subscription' });
  expect(grants).toHaveLength(2);
});

it.each(['stripe', 'polar'] as const)('[SB-14] %s lost renewal webhook grants the plan actually charged and opens one mismatch case', async (providerName) => {
  const input = await setup();
  await recoverMissingGrant(input);
  const provider = input.providers.stripe;
  const since = new Date('2025-12-31T00:00:00Z');
  const previousPeriod = { start: new Date('2025-12-01T00:00:00Z'), end: new Date('2026-01-01T00:00:00Z') };
  const renewalPeriod = { start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-02-01T00:00:00Z') };
  const high = {
    id: 'sb14-high', name: 'High', interval: 'month' as const, creditsPerPeriod: 3000,
    usageIncluded: 0, trialDays: 0, prices: [{ currency: 'USD', amountMinor: 3000, providerPriceRefs: { [providerName]: 'price_sb14_high' } }],
  };
  const low = {
    id: 'sb14-low', name: 'Low', interval: 'month' as const, creditsPerPeriod: 1000,
    usageIncluded: 0, trialDays: 0, prices: [{ currency: 'USD', amountMinor: 1000, providerPriceRefs: { [providerName]: 'price_sb14_low' } }],
  };
  const subscriptionId = `subscription:${providerName}:sub_sb14`;
  const sub = {
    id: subscriptionId, customerId: 'customer', planId: high.id, provider: providerName, providerRef: 'sub_sb14',
    status: 'active' as const, currentPeriod: previousPeriod, anchorDay: 1, cancelAtPeriodEnd: false,
    graceUntil: null, billingKey: null, scheduledPlanId: low.id, currency: 'USD', version: 0, createdAt: input.clock.now(),
  };
  const remote: Payment = {
    id: 'provider-payment-sb14', customerId: 'cus_sb14', provider: providerName, providerRef: 'pay_sb14',
    subscriptionId: 'sub_sb14', amount: { amountMinor: 3000, currency: 'USD' }, status: 'succeeded',
    kind: 'subscription', period: providerName === 'polar' ? null : renewalPeriod,
    occurredAt: renewalPeriod.start, failure: null, cashReceipt: null,
    raw: { line: { price: 'price_sb14_high' } },
  };
  await input.repo.customers.put({
    id: 'customer', email: null, providerRefs: [{ provider: providerName, ref: 'cus_sb14' }],
    status: 'active', createdAt: input.clock.now(),
  });
  await input.repo.plans.put(high); await input.repo.plans.put(low); await input.repo.subscriptions.put(sub);
  provider.listPayments = async () => [remote];
  provider.getSubscription = async () => ({ ...sub, currentPeriod: renewalPeriod });
  const deps = { ...input, providers: { [providerName]: provider } as Partial<Record<ProviderName, PaymentProvider>> };

  const cases = await recoverMissingGrants({ ...deps, grants: input.grants, since });
  const recorded = (await input.repo.payments.list()).find((payment) => payment.providerRef === remote.providerRef);
  if (!recorded) throw new Error('SB-14 renewal was not persisted');
  expect(recorded.raw).toEqual(remote.raw);
  const grants = await input.ledger.entries('customer', { kind: 'grant', source: 'subscription' });
  expect(grants).toHaveLength(1);
  expect(grants[0]).toMatchObject({ amount: 3000, reference: { paymentId: recorded.id, subscriptionId } });
  expect(cases).toHaveLength(1);
  expect(cases[0]).toMatchObject({
    id: `reconcile_mismatch:${recorded.id}`, status: 'needs_human', referenceId: recorded.id,
    decision: { expectedPlanId: low.id, actualPlanId: high.id },
  });
  expect(await input.repo.subscriptions.get(subscriptionId)).toMatchObject({
    planId: high.id, scheduledPlanId: null, currentPeriod: renewalPeriod,
  });

  await recoverMissingGrants({ ...deps, grants: input.grants, since });
  expect(await input.ledger.entries('customer', { kind: 'grant', source: 'subscription' })).toHaveLength(1);
  expect((await input.repo.csCases.list({ referenceId: recorded.id }))).toHaveLength(1);
});
it('[OT-09] registration links a held subscription payment before granting captured entitlement', async () => {
  const input = await setup(); const provider = input.providers.stripe;
  const period = { start: input.clock.now(), end: new Date('2026-02-01T00:00:00Z') };
  const plan = { id: 'monthly', name: 'Monthly', interval: 'month' as const, creditsPerPeriod: 100, usageIncluded: 0, trialDays: 0, prices: [{ currency: 'USD', amountMinor: 1000, providerPriceRefs: { stripe: 'price_monthly' } }] };
  await input.repo.plans.put(plan);
  provider.createCheckout = async () => ({ id: 'cs_sub', url: 'https://example.test/sub', providerRef: 'cs_sub' });
  provider.getPayment = async () => ({ ...input.payment, providerRef: 'pi_sub', kind: 'subscription', subscriptionId: 'sub_remote', period, customerId: 'cus_1', raw: { metadata: { checkoutEntitlementKey: 'checkout-entitlement:customer:sub-sale' } } });
  provider.listPayments = async () => [await provider.getPayment('pi_sub')];
  provider.getSubscription = async () => ({ id: 'sub_remote', customerId: 'cus_1', planId: 'monthly', provider: 'stripe', providerRef: 'sub_remote', status: 'active', currentPeriod: period, anchorDay: 1, cancelAtPeriodEnd: false, graceUntil: null, billingKey: null, scheduledPlanId: null, version: 0, createdAt: input.clock.now() });
  await startCheckout({ ...input, planId: 'monthly', provider: 'stripe', currency: 'USD', requestId: 'sub-sale', successUrl: 'https://example.test/ok', cancelUrl: 'https://example.test/cancel' });
  const held = await provider.getPayment('cs_sub');
  await input.repo.payments.put({ ...held, id: 'payment:stripe:pi_sub', customerId: 'customer', subscriptionId: null });
  await input.repo.plans.put({ ...plan, creditsPerPeriod: 500 });
  const payment = await registerCompletedCheckout({ ...input, checkoutId: 'cs_sub', paymentRef: 'pi_sub' });
  expect(payment.subscriptionId).toBe('subscription:stripe:sub_remote');
  const result = await recoverMissingGrant({ ...input, paymentId: payment.id });
  expect(result.status).toBe('resolved_auto');
  const grants = await input.ledger.entries('customer', { kind: 'grant' });
  expect(grants[0]?.amount).toBe(100); expect(grants[0]?.source).toBe('subscription');
  expect(grants[0]?.expiresAt).toEqual(period.end);
  // EC:A28 — the subscription remembers the currency it was bought in
  expect((await input.repo.subscriptions.get('subscription:stripe:sub_remote'))?.currency).toBe('USD');
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

it('[DC-07] registering a paid-zero sale records it, grants nothing, and opens one case that reconcile leaves alone', async () => {
  const input = await setup();
  const provider = input.providers.stripe;
  let key = '';
  provider.createCheckout = async (args) => { key = args.metadata?.checkoutEntitlementKey ?? ''; return { id: 'cs_zero', url: 'https://example.test/zero', providerRef: 'cs_zero' }; };
  const zero: Payment = { ...input.payment, id: 'remote-zero', providerRef: 'cs_zero', amount: { amountMinor: 0, currency: 'USD' }, customerId: 'cus_1' };
  provider.getPayment = async () => ({ ...zero, raw: { metadata: { checkoutEntitlementKey: key } } });
  provider.listPayments = async () => [];
  await startCheckout({ ...input, planId: 'credits100', provider: 'stripe', currency: 'USD', requestId: 'zero',
    successUrl: 'https://example.test/ok', cancelUrl: 'https://example.test/cancel', presetDiscountCode: undefined });

  const first = await registerCompletedCheckout({ ...input, checkoutId: 'cs_zero', paymentRef: 'cs_zero' });
  const second = await registerCompletedCheckout({ ...input, checkoutId: 'cs_zero', paymentRef: 'cs_zero' });
  const results = await recoverMissingGrants({ ...input, grants: input.grants, since: new Date('2025-12-31T00:00:00Z') });

  expect(second.id).toBe(first.id);
  expect(first.amount.amountMinor).toBe(0);
  expect(await input.repo.operations.get(`purchase-entitlement:${first.id}`)).toBeNull();
  const cases = (await input.repo.csCases.list()).filter((item) => item.referenceId === first.id);
  expect(cases).toHaveLength(1);
  expect(cases[0]).toMatchObject({ status: 'needs_human' });
  expect(results.filter((item) => item.referenceId === first.id)).toHaveLength(0);
  expect((await input.ledger.entries('customer', { kind: 'grant' })).filter((entry) => entry.reference.paymentId === first.id)).toHaveLength(0);
});

it('[DC-07] a preset code the provider refuses as a 100% discount leaves no checkout result and no payment row', async () => {
  const input = await setup();
  const provider = input.providers.stripe;
  const before = (await input.repo.payments.list()).length;
  provider.createCheckout = async () => { throw new PaymentKitError('100% discounts are not supported', 'full_discount_unsupported'); };

  await expect(startCheckout({ ...input, planId: 'credits100', provider: 'stripe', currency: 'USD', requestId: 'free-code',
    successUrl: 'https://example.test/ok', cancelUrl: 'https://example.test/cancel', presetDiscountCode: 'promo_free' }))
    .rejects.toMatchObject({ code: 'full_discount_unsupported' });

  expect((await input.repo.payments.list()).length).toBe(before);
  const results = (await input.repo.operations.list()).filter((operation) => operation.key.startsWith('checkout-result:customer:free-code'));
  expect(results.every((operation) => operation.status !== 'done')).toBe(true);
});
