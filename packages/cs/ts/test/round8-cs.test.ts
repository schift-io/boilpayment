// Round-8 audit regressions (bp-audit8.md): A8-9 (EC:A66 a ban ends the customer's subscriptions) and
// A8-7 (EC:A65 A67 Toss checkout registration). Mirrors py/tests/test_round8_cs.py.
import { describe, expect, it } from 'vitest';
import { CollectingNotifier, FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen, resolvePolicy } from 'boilpayment-core';
import type { NormalizedEvent, Payment, PaymentProvider, Subscription } from 'boilpayment-core';
import { dispute, registerCompletedCheckout, startCheckout } from '../src/index.js';

const clock = new FixedClock(new Date('2026-02-20T00:00:00Z'));
const unused = async (): Promise<never> => { throw new Error('unused'); };

function sub(id: string, provider: Subscription['provider'], providerRef: string | null): Subscription {
  return { id, customerId: 'c1', planId: 'basic', provider, providerRef, status: 'active',
    currentPeriod: { start: new Date('2026-02-01T00:00:00Z'), end: new Date('2026-03-01T00:00:00Z') }, anchorDay: 1,
    cancelAtPeriodEnd: false, graceUntil: null, billingKey: providerRef ? null : 'bk1', scheduledPlanId: null, version: 0, createdAt: clock.now() };
}

async function lostDispute(provider?: PaymentProvider) {
  const repo = new InMemoryRepo(); const ids = new SequentialIdGen('id_'); const ledger = new InMemoryLedger(ids);
  const notifier = new CollectingNotifier(); const policy = resolvePolicy();
  await repo.customers.put({ id: 'c1', email: null, providerRefs: [{ provider: 'stripe', ref: 'cus_1' }], status: 'active', createdAt: clock.now() });
  await repo.subscriptions.put(sub('s_stripe', 'stripe', 'sub_st'));
  await repo.subscriptions.put(sub('s_toss', 'toss', null));
  const ev = (type: NormalizedEvent['type'], outcome?: string): NormalizedEvent => ({ id: `evt_${type}`, provider: 'stripe', type, occurredAt: clock.now(),
    customerRef: 'c1', subscriptionRef: null, paymentRef: 'pi_1', amount: null, raw: {}, ...(outcome ? { disputeOutcome: outcome } : {}) } as NormalizedEvent);
  await dispute({ event: ev('dispute.opened'), policy, ledger, repo, notifier, clock, ids, provider });
  await dispute({ event: ev('dispute.closed', 'lost'), policy, ledger, repo, notifier, clock, ids, provider });
  return { repo, notifier };
}

describe('[EC:A66] a lost dispute with revoke_and_ban ends the customer\'s subscriptions', () => {
  it('cancels the native one at the provider the event came from and both locally', async () => {
    const canceled: string[] = [];
    const stripe = { name: 'stripe', capabilities: () => ({ nativeSubscriptions: true, partialRefund: true, meters: false, scheduling: 'provider', webhookSignature: true }),
      cancelSubscription: async (ref: string) => { canceled.push(ref); return sub('x', 'stripe', ref); } } as unknown as PaymentProvider;
    const { repo, notifier } = await lostDispute(stripe);
    expect((await repo.customers.get('c1'))?.status).toBe('banned');
    expect((await repo.subscriptions.list()).map((s) => [s.id, s.status])).toEqual([['s_stripe', 'canceled'], ['s_toss', 'canceled']]);
    expect(canceled).toEqual(['sub_st']);
    expect(notifier.sent.filter((n) => (n.payload as { kind?: string }).kind === 'banned_customer_subscription')).toEqual([]);
  });

  it('without the provider, the native one is ended locally and a person is told to cancel it', async () => {
    const { repo, notifier } = await lostDispute();
    expect((await repo.subscriptions.list()).every((s) => s.status === 'canceled')).toBe(true);
    const told = notifier.sent.filter((n) => (n.payload as { kind?: string }).kind === 'banned_customer_subscription');
    expect(told.map((n) => (n.payload as { subscriptionId: string }).subscriptionId)).toEqual(['s_stripe']);
  });
});

describe('[EC:A65 A67] Toss checkout registration', () => {
  async function tossSetup(interval: 'month' | null) {
    const repo = new InMemoryRepo(); const ids = new SequentialIdGen('id_'); const ledger = new InMemoryLedger(ids);
    const policy = resolvePolicy();
    await repo.customers.put({ id: 'u1', email: null, providerRefs: [{ provider: 'toss', ref: 'toss_u1' }], status: 'active', createdAt: clock.now() });
    await repo.plans.put({ id: 'p', name: 'p', interval, creditsPerPeriod: 1000, usageIncluded: 0, trialDays: 0, prices: [{ currency: 'KRW', amountMinor: 9900 }] });
    const live: Payment = { id: 'x', customerId: '', provider: 'toss', providerRef: 'pk_1', subscriptionId: null, amount: { amountMinor: 9900, currency: 'KRW' },
      status: 'succeeded', kind: 'topup', period: null, occurredAt: clock.now(), failure: null, cashReceipt: null, raw: { orderId: 'ord_checkout_1' } };
    const toss = { name: 'toss', capabilities: () => ({ nativeSubscriptions: false, partialRefund: true, meters: false, scheduling: 'self', webhookSignature: false }),
      createCheckout: async () => ({ id: 'ord_checkout_1', url: 'https://example.test/pay', providerRef: 'ord_checkout_1' }),
      getPayment: async () => live,
      // Toss's transaction list lags a fresh payment: it is not there yet.
      listPayments: async () => [], getSubscription: unused, createCustomer: unused } as unknown as PaymentProvider;
    const deps = { clock, ids, repo, ledger, policy, providers: { toss } };
    await startCheckout({ ...deps, customerId: 'u1', planId: 'p', provider: 'toss', currency: 'KRW', requestId: 'r1', successUrl: 'https://x/ok', cancelUrl: 'https://x/no' });
    return deps;
  }

  it('a top-up paid a moment ago registers from its order id, without the lagging list', async () => {
    const deps = await tossSetup(null);
    const payment = await registerCompletedCheckout({ ...deps, customerId: 'u1', checkoutId: 'ord_checkout_1', paymentRef: 'pk_1' });
    expect(payment.kind).toBe('topup');
  });

  it('a Toss subscription plan is refused with use_start_subscription', async () => {
    const deps = await tossSetup('month');
    await expect(registerCompletedCheckout({ ...deps, customerId: 'u1', checkoutId: 'ord_checkout_1', paymentRef: 'pk_1' }))
      .rejects.toMatchObject({ code: 'use_start_subscription' });
  });
});
