import { describe, expect, it } from 'vitest';
import {
  CollectingNotifier,
  FixedClock,
  InMemoryLedger,
  InMemoryRepo,
  SequentialIdGen,
  resolvePolicy,
} from 'boilpayment-core';
import type { Payment, PaymentProvider } from 'boilpayment-core';
import { grantForPeriod, topup } from '../../../credits/ts/src/index.js';
import { applyPurchasedGrant, registerCompletedCheckout, startCheckout } from '../src/index.js';

const NOW = new Date('2026-09-28T00:00:00Z');
const CUSTOMER_ID = 'customer_a85';

async function setup(statusAfterCheckout: 'banned' | 'frozen') {
  const clock = new FixedClock(NOW);
  const ids = new SequentialIdGen('a85_');
  const repo = new InMemoryRepo();
  const ledger = new InMemoryLedger(ids);
  const notifier = new CollectingNotifier();
  const policy = resolvePolicy();
  await repo.customers.put({
    id: CUSTOMER_ID,
    email: null,
    providerRefs: [{ provider: 'stripe', ref: 'cus_a85' }],
    status: 'active',
    createdAt: clock.now(),
  });
  await repo.plans.put({
    id: 'credits100',
    name: '100 credits',
    interval: null,
    creditsPerPeriod: 100,
    usageIncluded: 0,
    trialDays: 0,
    prices: [{ currency: 'USD', amountMinor: 1_000 }],
  });

  let checkoutEntitlementKey = '';
  const paid: Payment = {
    id: 'provider_payment_a85',
    customerId: 'cus_a85',
    provider: 'stripe',
    providerRef: `pi_a85_${statusAfterCheckout}`,
    subscriptionId: null,
    amount: { amountMinor: 1_000, currency: 'USD' },
    status: 'succeeded',
    kind: 'topup',
    period: null,
    occurredAt: clock.now(),
    failure: null,
    cashReceipt: null,
  };
  const unused = async (): Promise<never> => {
    throw new Error('unused');
  };
  const provider: PaymentProvider = {
    name: 'stripe',
    capabilities: () => ({
      nativeSubscriptions: true,
      partialRefund: true,
      meters: false,
      scheduling: 'provider',
      webhookSignature: true,
    }),
    createCustomer: unused,
    createCheckout: async (input) => {
      checkoutEntitlementKey = input.metadata?.checkoutEntitlementKey ?? '';
      return { id: `checkout_a85_${statusAfterCheckout}`, url: 'https://example.test/pay', providerRef: `checkout_a85_${statusAfterCheckout}` };
    },
    getPayment: async () => ({ ...paid, raw: { metadata: { checkoutEntitlementKey } } }),
    listPayments: async () => [paid],
    getSubscription: unused,
    changeSubscription: unused,
    cancelSubscription: unused,
    chargeBillingKey: unused,
    refund: unused,
    reportUsage: unused,
    verifyWebhook: unused,
  };
  const deps = { clock, ids, repo, ledger, notifier, policy, providers: { stripe: provider } };
  const checkout = await startCheckout({
    ...deps,
    customerId: CUSTOMER_ID,
    planId: 'credits100',
    provider: 'stripe',
    currency: 'USD',
    requestId: `sale_${statusAfterCheckout}`,
    successUrl: 'https://example.test/ok',
    cancelUrl: 'https://example.test/cancel',
  });
  const activeCustomer = await repo.customers.get(CUSTOMER_ID);
  if (!activeCustomer) throw new Error('customer fixture missing');
  await repo.customers.put({ ...activeCustomer, status: statusAfterCheckout });
  const payment = await registerCompletedCheckout({
    ...deps,
    customerId: CUSTOMER_ID,
    checkoutId: checkout.id,
    paymentRef: paid.providerRef,
  });
  return {
    ...deps,
    customerId: CUSTOMER_ID,
    payment,
    paymentId: payment.id,
    grants: { topup, grantForPeriod },
  };
}

describe('[EC:A85] paid top-up after customer status changes', () => {
  it('records a banned customer payment but grants nothing and requests one refund review across retries', async () => {
    // Given: checkout was created while active, then the customer was banned before payment registration.
    const input = await setup('banned');

    // When: both the initial fulfillment path and its redelivery drive the shared grant seam.
    await applyPurchasedGrant(input);
    await applyPurchasedGrant(input);

    // Then: money remains recorded, no credits land, and exactly one person is asked to refund it.
    expect(await input.repo.payments.get(input.payment.id)).toMatchObject({
      id: input.payment.id,
      customerId: CUSTOMER_ID,
      status: 'succeeded',
      kind: 'topup',
    });
    expect(await input.ledger.entries(CUSTOMER_ID, { kind: 'grant' })).toHaveLength(0);
    expect((await input.ledger.balance(CUSTOMER_ID, 'paid', input.clock.now())).available).toBe(0);
    const cases = await input.repo.csCases.list({
      customerId: CUSTOMER_ID,
      kind: 'refund',
      referenceId: input.payment.id,
      status: 'needs_human',
    });
    expect(cases).toHaveLength(1);
    expect(input.notifier.sent.filter((notice) => notice.type === 'cs.needs_human')).toHaveLength(1);
  });

  it('keeps the existing top-up grant behavior for a frozen customer', async () => {
    // Given: checkout was created while active, then the customer was frozen before payment registration.
    const input = await setup('frozen');

    // When: the shared purchased-grant seam fulfills the paid top-up.
    await applyPurchasedGrant(input);

    // Then: frozen is unchanged by EC:A85 and receives the normal one-time grant without a CS case.
    expect((await input.ledger.balance(CUSTOMER_ID, 'paid', input.clock.now())).available).toBe(100);
    expect(await input.ledger.entries(CUSTOMER_ID, { kind: 'grant' })).toHaveLength(1);
    expect(await input.repo.csCases.list({ customerId: CUSTOMER_ID })).toHaveLength(0);
    expect(input.notifier.sent.filter((notice) => notice.type === 'cs.needs_human')).toHaveLength(0);
  });
});
