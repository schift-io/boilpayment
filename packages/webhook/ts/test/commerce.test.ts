import { describe, expect, it } from 'vitest';
// allow: SIZE_OK — paired provider contract scenarios intentionally share one fixture matrix.
import {
  CollectingNotifier,
  DEFAULT_POLICY,
  FixedClock,
  InMemoryLedger,
  InMemoryRepo,
  SequentialIdGen,
} from 'boilpayment-core';
import type { NormalizedEvent, Payment, Plan, ProviderName, Subscription } from 'boilpayment-core';
import { defaultHandlers } from '../src/index.js';
import { FakeProvider } from './helpers.js';

const now = new Date('2026-09-28T00:00:00Z');

function plan(provider: ProviderName, interval: Plan['interval'] = null): Plan {
  return {
    id: `plan-${interval ?? 'once'}`,
    name: 'Plan',
    interval,
    creditsPerPeriod: 100,
    usageIncluded: 0,
    trialDays: 0,
    prices: [{ currency: 'USD', amountMinor: 2_000, providerPriceRefs: { [provider]: 'price-1' } }],
  };
}

function remote(provider: ProviderName, overrides: Partial<Payment> = {}): Payment {
  return {
    id: 'provider-payment',
    customerId: '',
    provider,
    providerRef: 'pi-canonical',
    subscriptionId: null,
    amount: { amountMinor: 1_600, currency: 'USD' },
    status: 'succeeded',
    kind: 'topup',
    period: null,
    occurredAt: now,
    failure: null,
    cashReceipt: null,
    saleEvidence: {
      providerSubtotal: { amountMinor: 2_000, currency: 'USD' },
      discountAmount: { amountMinor: 400, currency: 'USD' },
      priceRef: 'price-1',
      checkoutId: null,
      paymentLinkId: 'plink-1',
      linkReference: 'valid',
    },
    affiliateId: null,
    ...overrides,
  };
}

function event(provider: ProviderName, subscriptionRef: string | null = null): NormalizedEvent {
  return {
    id: 'event-1',
    provider,
    type: 'payment.succeeded',
    occurredAt: now,
    customerRef: null,
    subscriptionRef,
    paymentRef: 'checkout-session-ref',
    amount: null,
    raw: {},
  };
}

describe.each(['stripe', 'polar'] as const)('%s commerce webhooks', (providerName) => {
  it('[OT-09] records and holds an unregistered checkout exactly once', async () => {
    // Given
    const repo = new InMemoryRepo();
    const clock = new FixedClock(now);
    const providerPayment = remote(providerName, {
      saleEvidence: {
        providerSubtotal: { amountMinor: 2_000, currency: 'USD' },
        discountAmount: { amountMinor: 0, currency: 'USD' },
        priceRef: 'price-1',
        checkoutId: 'checkout-1',
        paymentLinkId: null,
        linkReference: null,
      },
    });
    await repo.operations.put({
      id: 'checkout-entitlement-by-id:checkout-1',
      key: 'checkout-entitlement-by-id:checkout-1',
      kind: 'checkout.entitlement',
      payloadHash: 'snapshot',
      status: 'done',
      result: { customerId: 'customer-1', plan: { id: 'plan-1', interval: null }, affiliateId: 'affiliate-1' },
      error: null,
      createdAt: now,
      completedAt: now,
      attempts: 1,
    });
    const provider = new FakeProvider({ name: providerName, verify: () => event(providerName), getPaymentImpl: () => providerPayment });
    let grants = 0;
    const handlers = defaultHandlers({
      policy: DEFAULT_POLICY,
      ledger: new InMemoryLedger(),
      repo,
      notifier: new CollectingNotifier(),
      clock,
      ids: new SequentialIdGen('id-'),
      grantLinkPayment: async () => { grants += 1; },
      credits: { topup: async () => { throw new Error('held checkout replay must not grant'); } },
      resolveTopupCredits: async () => null,
    });
    const handler = handlers['payment.succeeded'];
    if (!handler) throw new Error('payment handler missing');

    // When
    await handler({ event: event(providerName), provider, repo, clock, correlationId: 'correlation-1' });
    providerPayment.status = 'refunded';
    await handler({ event: { ...event(providerName), id: 'event-2' }, provider, repo, clock, correlationId: 'correlation-2' });

    // Then
    expect(await repo.payments.list()).toEqual([
      expect.objectContaining({ id: `payment:${providerName}:pi-canonical`, customerId: 'customer-1', affiliateId: 'affiliate-1' }),
    ]);
    expect(await repo.operations.get(`checkout-payment-held:payment:${providerName}:pi-canonical`)).toMatchObject({
      kind: 'checkout.paymentHeld',
      status: 'done',
    });
    expect(grants).toBe(0);
  });

  it('[OT-09] a PaymentIntent naming the kit checkout key is held before registration', async () => {
    // Given -- the PaymentIntent carries the kit's key in metadata, never the session id
    if (providerName !== 'stripe') return;
    const repo = new InMemoryRepo();
    const clock = new FixedClock(now);
    for (const [key, result] of [
      ['checkout-entitlement-by-id:checkout-1', { customerId: 'customer-1', plan: { id: 'plan-1', interval: null }, affiliateId: null }],
      ['checkout-id-by-key:intent-1', { checkoutId: 'checkout-1' }],
    ] as const) {
      await repo.operations.put({ id: key, key, kind: 'checkout.entitlement', payloadHash: 'x', status: 'done', result, error: null,
        createdAt: now, completedAt: now, attempts: 1 });
    }
    const intent = remote(providerName, { saleEvidence: null, raw: { metadata: { checkoutEntitlementKey: 'intent-1' } } });
    const provider = new FakeProvider({ name: providerName, verify: () => event(providerName), getPaymentImpl: () => intent });
    let grants = 0;
    const handlers = defaultHandlers({
      policy: DEFAULT_POLICY, ledger: new InMemoryLedger(), repo, notifier: new CollectingNotifier(), clock, ids: new SequentialIdGen('id-'),
      grantLinkPayment: async () => { grants += 1; },
    });
    const handler = handlers['payment.succeeded'];
    if (!handler) throw new Error('payment handler missing');

    // When
    await handler({ event: event(providerName), provider, repo, clock, correlationId: 'correlation-1' });

    // Then
    expect(await repo.operations.get('checkout-payment-held:payment:stripe:pi-canonical')).toMatchObject({ status: 'done' });
    expect(await repo.payments.list()).toHaveLength(1);
    expect(grants).toBe(0);
  });

  it('[PL-02, AF-01/02] grants a valid link once and accrues once', async () => {
    // Given
    const repo = new InMemoryRepo();
    const clock = new FixedClock(now);
    const currentPlan = plan(providerName);
    await repo.plans.put(currentPlan);
    await repo.customers.put({ id: 'customer-1', email: null, providerRefs: [], status: 'active', createdAt: now });
    const basePayment = remote(providerName);
    const providerPayment = providerName === 'polar' && basePayment.saleEvidence
      ? remote(providerName, { saleEvidence: { ...basePayment.saleEvidence, paymentLinkId: null } })
      : basePayment;
    const provider = new FakeProvider({ name: providerName, verify: () => event(providerName), getPaymentImpl: () => providerPayment });
    const granted: string[] = [];
    const handlers = defaultHandlers({
      policy: DEFAULT_POLICY,
      ledger: new InMemoryLedger(),
      repo,
      notifier: new CollectingNotifier(),
      clock,
      ids: new SequentialIdGen('id-'),
      decodeLinkReference: () => ({ customerId: 'customer-1', affiliateId: 'affiliate-1' }),
      grantLinkPayment: async ({ payment }) => { granted.push(payment.id); },
      commissionForPayment: async () => ({ amountMinor: 160, currency: 'USD' }),
      credits: { topup: async () => { throw new Error('link replay must not use checkout grants'); } },
      resolveTopupCredits: async () => null,
    });
    const handler = handlers['payment.succeeded'];
    if (!handler) throw new Error('payment handler missing');

    // When
    await handler({ event: event(providerName), provider, repo, clock, correlationId: 'correlation-1' });
    await handler({ event: { ...event(providerName), id: 'event-2', paymentRef: 'pi-canonical' }, provider, repo, clock, correlationId: 'correlation-2' });

    // Then
    expect(granted).toEqual([`payment:${providerName}:pi-canonical`]);
    expect(await repo.payments.list()).toEqual([
      expect.objectContaining({ customerId: 'customer-1', amount: { amountMinor: 1_600, currency: 'USD' }, affiliateId: 'affiliate-1' }),
    ]);
    expect(await repo.affiliateCommissions.list({ affiliateId: 'affiliate-1' })).toHaveLength(1);
  });

  it('[PL-02, AF-01/02] a link grant that failed once completes on redelivery, granting and accruing once', async () => {
    // Given -- the payment is recorded, then the grant fails once
    const repo = new InMemoryRepo();
    const clock = new FixedClock(now);
    await repo.plans.put(plan(providerName));
    await repo.customers.put({ id: 'customer-1', email: null, providerRefs: [], status: 'active', createdAt: now });
    const basePayment = remote(providerName);
    const providerPayment = providerName === 'polar' && basePayment.saleEvidence
      ? remote(providerName, { saleEvidence: { ...basePayment.saleEvidence, paymentLinkId: null } })
      : basePayment;
    const provider = new FakeProvider({ name: providerName, verify: () => event(providerName), getPaymentImpl: () => providerPayment });
    const granted: string[] = [];
    let failNext = true;
    const handlers = defaultHandlers({
      policy: DEFAULT_POLICY,
      ledger: new InMemoryLedger(),
      repo,
      notifier: new CollectingNotifier(),
      clock,
      ids: new SequentialIdGen('id-'),
      decodeLinkReference: () => ({ customerId: 'customer-1', affiliateId: 'affiliate-1' }),
      grantLinkPayment: async ({ payment }) => {
        if (failNext) { failNext = false; throw new Error('transient'); }
        granted.push(payment.id);
      },
      commissionForPayment: async () => ({ amountMinor: 160, currency: 'USD' }),
      credits: { topup: async () => { throw new Error('link replay must not use checkout grants'); } },
      resolveTopupCredits: async () => null,
    });
    const handler = handlers['payment.succeeded'];
    if (!handler) throw new Error('payment handler missing');

    // When
    await expect(handler({ event: event(providerName), provider, repo, clock, correlationId: 'correlation-1' })).rejects.toThrow();
    await handler({ event: { ...event(providerName), id: 'event-2', paymentRef: 'pi-canonical' }, provider, repo, clock, correlationId: 'correlation-2' });
    await handler({ event: { ...event(providerName), id: 'event-3', paymentRef: 'pi-canonical' }, provider, repo, clock, correlationId: 'correlation-3' });

    // Then
    expect(granted).toEqual([`payment:${providerName}:pi-canonical`]);
    expect(await repo.operations.get(`payment-link-grant:payment:${providerName}:pi-canonical`)).toMatchObject({ status: 'done' });
    expect(await repo.affiliateCommissions.list({ affiliateId: 'affiliate-1' })).toHaveLength(1);
  });

  it('[PL-03] a link mismatch case that failed to open once is opened exactly once on redelivery', async () => {
    // Given
    const repo = new InMemoryRepo();
    const clock = new FixedClock(now);
    await repo.plans.put(plan(providerName));
    const basePayment = remote(providerName);
    if (!basePayment.saleEvidence) throw new Error('sale evidence missing');
    const providerPayment = remote(providerName, { saleEvidence: { ...basePayment.saleEvidence, linkReference: 'invalid' } });
    const provider = new FakeProvider({ name: providerName, verify: () => event(providerName), getPaymentImpl: () => providerPayment });
    const opened: string[] = [];
    let failNext = true;
    const handlers = defaultHandlers({
      policy: DEFAULT_POLICY,
      ledger: new InMemoryLedger(),
      repo,
      notifier: new CollectingNotifier(),
      clock,
      ids: new SequentialIdGen('id-'),
      decodeLinkReference: () => null,
      openLinkMismatchCase: async ({ reason }) => {
        if (failNext) { failNext = false; throw new Error('transient'); }
        opened.push(reason);
      },
      credits: { topup: async () => { throw new Error('link mismatch replay must not grant'); } },
      resolveTopupCredits: async () => null,
    });
    const handler = handlers['payment.succeeded'];
    if (!handler) throw new Error('payment handler missing');

    // When
    await expect(handler({ event: event(providerName), provider, repo, clock, correlationId: 'correlation-1' })).rejects.toThrow();
    await handler({ event: { ...event(providerName), id: 'event-2', paymentRef: 'pi-canonical' }, provider, repo, clock, correlationId: 'correlation-2' });
    await handler({ event: { ...event(providerName), id: 'event-3', paymentRef: 'pi-canonical' }, provider, repo, clock, correlationId: 'correlation-3' });

    // Then
    expect(opened).toEqual(['invalid_reference']);
    expect(await repo.payments.list()).toHaveLength(1);
  });

  it.each([
    ['missing_reference', null, null],
    ['invalid_reference', 'invalid', null],
    ['unknown_customer', 'valid', { customerId: 'missing-customer', affiliateId: null }],
  ] as const)('[PL-03] records and parks %s exactly once', async (reason, reference, decoded) => {
    // Given
    const repo = new InMemoryRepo();
    const clock = new FixedClock(now);
    await repo.plans.put(plan(providerName));
    const basePayment = remote(providerName);
    if (!basePayment.saleEvidence) throw new Error('sale evidence missing');
    const providerPayment = remote(providerName, { saleEvidence: { ...basePayment.saleEvidence, linkReference: reference,
      paymentLinkId: providerName === 'polar' && reason === 'missing_reference' ? null : basePayment.saleEvidence.paymentLinkId } });
    const provider = new FakeProvider({ name: providerName, verify: () => event(providerName), getPaymentImpl: () => providerPayment });
    const opened: string[] = [];
    const handlers = defaultHandlers({
      policy: DEFAULT_POLICY,
      ledger: new InMemoryLedger(),
      repo,
      notifier: new CollectingNotifier(),
      clock,
      ids: new SequentialIdGen('id-'),
      decodeLinkReference: () => decoded,
      openLinkMismatchCase: async ({ reason: actual }) => { opened.push(actual); },
      credits: { topup: async () => { throw new Error('link mismatch replay must not grant'); } },
      resolveTopupCredits: async () => null,
    });
    const handler = handlers['payment.succeeded'];
    if (!handler) throw new Error('payment handler missing');

    // When
    await handler({ event: event(providerName), provider, repo, clock, correlationId: 'correlation-1' });
    providerPayment.status = 'refunded';
    await handler({ event: { ...event(providerName), id: 'event-2' }, provider, repo, clock, correlationId: 'correlation-2' });

    // Then
    expect(opened).toEqual([reason]);
    expect(await repo.payments.list()).toHaveLength(1);
    expect((await repo.customers.list())[0]?.status).toBe('frozen');
    if (reason === 'unknown_customer') {
      expect((await repo.customers.list())[0]?.id).toBe(`unmatched-link:${providerName}:pi-canonical`);
    }
  });

  it.each(['frozen', 'banned'] as const)('[PL-03] records but never grants a link for a %s customer', async (status) => {
    const repo = new InMemoryRepo();
    const clock = new FixedClock(now);
    await repo.plans.put(plan(providerName));
    await repo.customers.put({ id: 'customer-1', email: null, providerRefs: [], status, createdAt: now });
    const provider = new FakeProvider({ name: providerName, verify: () => event(providerName), getPaymentImpl: () => remote(providerName) });
    let grants = 0;
    const opened: string[] = [];
    const handlers = defaultHandlers({
      policy: DEFAULT_POLICY, ledger: new InMemoryLedger(), repo, notifier: new CollectingNotifier(), clock,
      ids: new SequentialIdGen('id-'), decodeLinkReference: () => ({ customerId: 'customer-1', affiliateId: null }),
      grantLinkPayment: async () => { grants += 1; }, openLinkMismatchCase: async ({ reason }) => { opened.push(reason); },
    });
    const handler = handlers['payment.succeeded']; if (!handler) throw new Error('payment handler missing');

    await handler({ event: event(providerName), provider, repo, clock, correlationId: 'correlation-1' });

    expect(grants).toBe(0);
    expect(opened).toEqual(['customer_inactive']);
    expect(await repo.payments.list()).toHaveLength(1);
  });

  it('[PL-02] refuses a link when authoritative payment status is not succeeded', async () => {
    const repo = new InMemoryRepo();
    const clock = new FixedClock(now);
    await repo.plans.put(plan(providerName));
    await repo.customers.put({ id: 'customer-1', email: null, providerRefs: [], status: 'active', createdAt: now });
    const provider = new FakeProvider({ name: providerName, verify: () => event(providerName),
      getPaymentImpl: () => remote(providerName, { status: 'pending' }) });
    let grants = 0;
    const handlers = defaultHandlers({
      policy: DEFAULT_POLICY, ledger: new InMemoryLedger(), repo, notifier: new CollectingNotifier(), clock,
      ids: new SequentialIdGen('id-'), decodeLinkReference: () => ({ customerId: 'customer-1', affiliateId: null }),
      grantLinkPayment: async () => { grants += 1; },
    });
    const handler = handlers['payment.succeeded']; if (!handler) throw new Error('payment handler missing');

    await expect(handler({ event: event(providerName), provider, repo, clock, correlationId: 'correlation-1' }))
      .rejects.toMatchObject({ code: 'topup_payment_not_succeeded' });
    expect(grants).toBe(0);
    expect(await repo.payments.list()).toHaveLength(0);
  });

  it('[PL-02, DC-05, AF-04] links a subscription by price ref and preserves actual charged amount', async () => {
    // Given
    const repo = new InMemoryRepo();
    const clock = new FixedClock(now);
    const currentPlan = plan(providerName, 'month');
    await repo.plans.put(currentPlan);
    await repo.customers.put({ id: 'customer-1', email: null, providerRefs: [], status: 'active', createdAt: now });
    const period = { start: now, end: new Date('2026-10-28T00:00:00Z') };
    const providerSub: Subscription = {
      id: 'provider-sub', customerId: '', planId: '', provider: providerName, providerRef: 'provider-sub', status: 'active',
      currentPeriod: period, anchorDay: 28, cancelAtPeriodEnd: false, graceUntil: null, billingKey: null,
      scheduledPlanId: null, version: 0, createdAt: now,
    };
    const linkPayment = remote(providerName, { kind: 'subscription', subscriptionId: 'provider-sub', period });
    const providerPayment = providerName === 'polar' && linkPayment.saleEvidence
      ? remote(providerName, { kind: 'subscription', subscriptionId: 'provider-sub', period,
          saleEvidence: { ...linkPayment.saleEvidence, paymentLinkId: null } })
      : linkPayment;
    const provider = new FakeProvider({
      name: providerName,
      verify: () => event(providerName, 'provider-sub'),
      getPaymentImpl: () => providerPayment,
      getSubscriptionImpl: () => providerSub,
    });
    const granted: Array<{ amount: number; plan: string; affiliate: string | null | undefined }> = [];
    const handlers = defaultHandlers({
      policy: DEFAULT_POLICY,
      ledger: new InMemoryLedger(),
      repo,
      notifier: new CollectingNotifier(),
      clock,
      ids: new SequentialIdGen('id-'),
      decodeLinkReference: () => ({ customerId: 'customer-1', affiliateId: 'affiliate-1' }),
      grantLinkPayment: async ({ payment, plan: resolved, subscription }) => {
        granted.push({ amount: payment.amount.amountMinor, plan: resolved.id, affiliate: subscription?.affiliateId });
      },
      affiliateRenewals: 'first_only',
      commissionForPayment: async () => ({ amountMinor: 160, currency: 'USD' }),
    });
    const handler = handlers['payment.succeeded'];
    if (!handler) throw new Error('payment handler missing');

    // When
    await handler({ event: event(providerName, 'provider-sub'), provider, repo, clock, correlationId: 'correlation-1' });

    // Then
    expect(granted).toEqual([{ amount: 1_600, plan: currentPlan.id, affiliate: 'affiliate-1' }]);
    expect((await repo.payments.list())[0]?.amount.amountMinor).toBe(1_600);
  });

  it.each([
    ['include', 1],
    ['first_only', 0],
  ] as const)('[DC-05, AF-04] renews by subscription plan at the actual charge with %s', async (renewals, expectedCommissions) => {
    // Given
    const repo = new InMemoryRepo();
    const clock = new FixedClock(now);
    const currentPlan = plan(providerName, 'month');
    await repo.plans.put(currentPlan);
    const period = { start: now, end: new Date('2026-10-28T00:00:00Z') };
    const localSub: Subscription = {
      id: 'local-sub', customerId: 'customer-1', planId: currentPlan.id, provider: providerName, providerRef: 'provider-sub',
      status: 'active', currentPeriod: period, anchorDay: 28, cancelAtPeriodEnd: false, graceUntil: null, billingKey: null,
      scheduledPlanId: null, version: 0, createdAt: now, affiliateId: 'affiliate-1',
    };
    await repo.subscriptions.put(localSub);
    const providerPayment = remote(providerName, {
      providerRef: 'checkout-session-ref', kind: 'subscription', subscriptionId: 'provider-sub', period,
      amount: { amountMinor: 2_000, currency: 'USD' }, saleEvidence: null, affiliateId: null,
    });
    const provider = new FakeProvider({
      name: providerName,
      verify: () => event(providerName, 'provider-sub'),
      getPaymentImpl: () => providerPayment,
      getSubscriptionImpl: () => localSub,
    });
    const renewed: Array<{ plan: string; amount: number }> = [];
    const lifecycle = {
      onRenewalPaid: async ({ sub, payment }: { sub: Subscription; payment: Payment }) => {
        renewed.push({ plan: sub.planId, amount: payment.amount.amountMinor });
      },
      dunning: { onPaymentFailed: async () => {} },
    };
    const handlers = defaultHandlers({
      policy: DEFAULT_POLICY,
      ledger: new InMemoryLedger(),
      repo,
      notifier: new CollectingNotifier(),
      clock,
      ids: new SequentialIdGen('id-'),
      lifecycle,
      affiliateRenewals: renewals,
      commissionForPayment: async () => ({ amountMinor: 200, currency: 'USD' }),
    });
    const handler = handlers['payment.succeeded'];
    if (!handler) throw new Error('payment handler missing');

    // When
    await handler({ event: event(providerName, 'provider-sub'), provider, repo, clock, correlationId: 'correlation-1' });
    await handler({ event: { ...event(providerName, 'provider-sub'), id: 'event-2' }, provider, repo, clock, correlationId: 'correlation-2' });

    // Then
    expect(renewed).toEqual([{ plan: currentPlan.id, amount: 2_000 }, { plan: currentPlan.id, amount: 2_000 }]);
    expect((await repo.payments.list())[0]?.amount.amountMinor).toBe(2_000);
    expect(await repo.affiliateCommissions.list({ affiliateId: 'affiliate-1' })).toHaveLength(expectedCommissions);
  });
  async function zeroSaleOutcome(repo: InMemoryRepo) {
    const cases = (await repo.csCases.list()).filter((item) => item.decision && (item.decision as { reason?: string }).reason === 'zero_amount_sale');
    return { cases, commissions: await repo.affiliateCommissions.list({ affiliateId: 'affiliate-1' }) };
  }

  it('[DC-07] a paid-zero one-time checkout is recorded, granted nothing, and opens exactly one case', async () => {
    // Given -- the customer typed a 100% code on the provider page
    const repo = new InMemoryRepo();
    const clock = new FixedClock(now);
    await repo.operations.put({
      id: 'checkout-entitlement-by-id:checkout-1', key: 'checkout-entitlement-by-id:checkout-1', kind: 'checkout.entitlement',
      payloadHash: 'snapshot', status: 'done', error: null, createdAt: now, completedAt: now, attempts: 1,
      result: { customerId: 'customer-1', plan: { id: 'plan-once', interval: null, trialDays: 0 }, affiliateId: 'affiliate-1' },
    });
    const zero = remote(providerName, {
      amount: { amountMinor: 0, currency: 'USD' },
      saleEvidence: { providerSubtotal: { amountMinor: 2_000, currency: 'USD' }, discountAmount: { amountMinor: 2_000, currency: 'USD' },
        priceRef: 'price-1', checkoutId: 'checkout-1', paymentLinkId: null, linkReference: null },
    });
    const provider = new FakeProvider({ name: providerName, verify: () => event(providerName), getPaymentImpl: () => zero });
    let grants = 0;
    const handlers = defaultHandlers({
      policy: DEFAULT_POLICY, ledger: new InMemoryLedger(), repo, notifier: new CollectingNotifier(), clock, ids: new SequentialIdGen('id-'),
      grantLinkPayment: async () => { grants += 1; },
      credits: { topup: async () => { throw new Error('a paid-zero sale must not grant'); } },
      resolveTopupCredits: async () => 100,
      commissionForPayment: async () => ({ amountMinor: 160, currency: 'USD' }),
    });
    const handler = handlers['payment.succeeded'];
    if (!handler) throw new Error('payment handler missing');

    // When -- delivered, then redelivered twice
    await handler({ event: event(providerName), provider, repo, clock, correlationId: 'c-1' });
    await handler({ event: { ...event(providerName), id: 'event-2' }, provider, repo, clock, correlationId: 'c-2' });
    await handler({ event: { ...event(providerName), id: 'event-3' }, provider, repo, clock, correlationId: 'c-3' });

    // Then
    expect(await repo.payments.list()).toHaveLength(1);
    const outcome = await zeroSaleOutcome(repo);
    expect(outcome.cases).toHaveLength(1);
    expect(outcome.cases[0]).toMatchObject({ status: 'needs_human', customerId: 'customer-1' });
    expect(outcome.commissions).toHaveLength(0);
    expect(grants).toBe(0);
    expect(await repo.operations.get(`checkout-payment-held:payment:${providerName}:pi-canonical`)).toBeNull();
  });

  it('[DC-07] a paid-zero payment-link sale grants nothing and opens exactly one case', async () => {
    // Given
    const repo = new InMemoryRepo();
    const clock = new FixedClock(now);
    await repo.plans.put(plan(providerName));
    await repo.customers.put({ id: 'customer-1', email: null, providerRefs: [], status: 'active', createdAt: now });
    const base = remote(providerName, { amount: { amountMinor: 0, currency: 'USD' } });
    const zero = providerName === 'polar' && base.saleEvidence
      ? { ...base, saleEvidence: { ...base.saleEvidence, paymentLinkId: null } } : base;
    const provider = new FakeProvider({ name: providerName, verify: () => event(providerName), getPaymentImpl: () => zero });
    let grants = 0;
    const handlers = defaultHandlers({
      policy: DEFAULT_POLICY, ledger: new InMemoryLedger(), repo, notifier: new CollectingNotifier(), clock, ids: new SequentialIdGen('id-'),
      decodeLinkReference: () => ({ customerId: 'customer-1', affiliateId: 'affiliate-1' }),
      grantLinkPayment: async () => { grants += 1; },
      commissionForPayment: async () => ({ amountMinor: 160, currency: 'USD' }),
      credits: { topup: async () => { throw new Error('a paid-zero sale must not grant'); } },
      resolveTopupCredits: async () => null,
    });
    const handler = handlers['payment.succeeded'];
    if (!handler) throw new Error('payment handler missing');

    // When
    await handler({ event: event(providerName), provider, repo, clock, correlationId: 'c-1' });
    await handler({ event: { ...event(providerName), id: 'event-2', paymentRef: 'pi-canonical' }, provider, repo, clock, correlationId: 'c-2' });

    // Then
    expect(grants).toBe(0);
    const outcome = await zeroSaleOutcome(repo);
    expect(outcome.cases).toHaveLength(1);
    expect(outcome.commissions).toHaveLength(0);
  });

  it.each([
    ['not a trial', 'active', 0, 0, 1],
    ['a trial', 'trialing', 7, 1, 0],
  ] as const)('[DC-07] a zero subscription invoice that is %s', async (_name, status, trialDays, renewals, cases) => {
    // Given
    const repo = new InMemoryRepo();
    const clock = new FixedClock(now);
    const currentPlan = { ...plan(providerName, 'month'), trialDays };
    await repo.plans.put(currentPlan);
    const period = { start: now, end: new Date('2026-10-28T00:00:00Z') };
    const localSub: Subscription = {
      id: 'local-sub', customerId: 'customer-1', planId: currentPlan.id, provider: providerName, providerRef: 'provider-sub',
      status, currentPeriod: period, anchorDay: 28, cancelAtPeriodEnd: false, graceUntil: null, billingKey: null,
      scheduledPlanId: null, version: 0, createdAt: now, affiliateId: 'affiliate-1',
    };
    await repo.subscriptions.put(localSub);
    const zero = remote(providerName, {
      providerRef: 'checkout-session-ref', kind: 'subscription', subscriptionId: 'provider-sub', period,
      amount: { amountMinor: 0, currency: 'USD' }, saleEvidence: null, affiliateId: null,
    });
    const provider = new FakeProvider({ name: providerName, verify: () => event(providerName, 'provider-sub'), getPaymentImpl: () => zero, getSubscriptionImpl: () => localSub });
    let renewed = 0;
    const handlers = defaultHandlers({
      policy: DEFAULT_POLICY, ledger: new InMemoryLedger(), repo, notifier: new CollectingNotifier(), clock, ids: new SequentialIdGen('id-'),
      lifecycle: { onRenewalPaid: async () => { renewed += 1; }, dunning: { onPaymentFailed: async () => {} } },
      affiliateRenewals: 'include',
      commissionForPayment: async () => ({ amountMinor: 160, currency: 'USD' }),
    });
    const handler = handlers['payment.succeeded'];
    if (!handler) throw new Error('payment handler missing');

    // When
    await handler({ event: event(providerName, 'provider-sub'), provider, repo, clock, correlationId: 'c-1' });
    await handler({ event: { ...event(providerName, 'provider-sub'), id: 'event-2' }, provider, repo, clock, correlationId: 'c-2' });

    // Then
    expect(renewed).toBe(renewals === 1 ? 2 : 0);
    expect((await zeroSaleOutcome(repo)).cases).toHaveLength(cases);
  });

});
