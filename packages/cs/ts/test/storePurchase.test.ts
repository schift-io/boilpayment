import { expect, it } from 'vitest';
import { FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen, resolvePolicy, storeAccountToken } from 'boilpayment-core';
import type { PaymentProvider, StoreProof, VerifiedStorePurchase } from 'boilpayment-core';
import { topup, grantForPeriod } from '../../../credits/ts/src/index.js';
import { registerStorePurchase, reackStorePurchases } from '../src/index.js';

const NOW = new Date('2026-01-10T00:00:00Z');
const DAY = 86_400_000;
type Over = Partial<VerifiedStorePurchase> & { status?: 'succeeded' | 'pending' };

function purchase(over: Over = {}, kind: 'sub' | 'coins' = 'sub'): VerifiedStorePurchase {
  const sub = kind === 'sub';
  const ref = over.payment?.providerRef ?? (sub ? 'txn-1' : 'txn-c');
  const period = sub ? { start: new Date(NOW.getTime() - DAY), end: new Date(NOW.getTime() + 29 * DAY) } : null;
  return {
    payment: { id: ref, customerId: '', provider: 'apple', providerRef: ref, subscriptionId: sub ? 'orig-1' : null, amount: { amountMinor: 999, currency: 'USD' },
      status: over.status ?? 'succeeded', kind: sub ? 'subscription' : 'topup', period, occurredAt: new Date(NOW.getTime() - DAY), failure: null, cashReceipt: null },
    amountFromStore: true, productId: sub ? 'pro.monthly' : 'coins.100', subscriptionRef: sub ? 'orig-1' : null,
    subscription: sub ? { id: 'orig-1', customerId: '', planId: '', provider: 'apple', providerRef: 'orig-1', status: 'active', currentPeriod: period!, anchorDay: 9,
      cancelAtPeriodEnd: false, graceUntil: null, billingKey: null, scheduledPlanId: null, version: 0, createdAt: period!.start } : null,
    accountToken: storeAccountToken('alice'), environment: 'production', ownership: 'purchased', acknowledged: true, ...over,
  };
}

async function setup(verified: () => VerifiedStorePurchase, ack?: () => Promise<{ acknowledged: boolean }>) {
  const clock = new FixedClock(NOW); const ids = new SequentialIdGen('iap_');
  const repo = new InMemoryRepo(); const ledger = new InMemoryLedger(ids);
  const policy = resolvePolicy({});
  for (const id of ['alice', 'bob']) await repo.customers.put({ id, email: null, providerRefs: [], status: 'active', createdAt: NOW });
  await repo.plans.put({ id: 'pro', name: 'Pro', interval: 'month', creditsPerPeriod: 100, usageIncluded: 0, trialDays: 0, prices: [{ currency: 'USD', amountMinor: 999, providerPriceRefs: { apple: 'pro.monthly', google_play: 'pro.monthly' } }] });
  await repo.plans.put({ id: 'coins', name: 'Coins', interval: null, creditsPerPeriod: 50, usageIncluded: 0, trialDays: 0, prices: [{ currency: 'KRW', amountMinor: 1100, providerPriceRefs: { apple: 'coins.100', google_play: 'coins.100' } }] });
  let acks = 0;
  const unused = async (): Promise<never> => { throw new Error('unused'); };
  const provider = { name: 'apple', capabilities: () => ({ nativeSubscriptions: true, partialRefund: false, meters: false, scheduling: 'provider', webhookSignature: true, checkout: 'on_device' }),
    verifyPurchase: async (_: StoreProof) => verified(), ...(ack ? { acknowledge: async () => { acks += 1; return ack(); } } : {}),
    createCustomer: unused, createCheckout: unused, getPayment: unused, listPayments: unused, getSubscription: unused, changeSubscription: unused, cancelSubscription: unused,
    uncancelSubscription: unused, chargeBillingKey: unused, refund: unused, reportUsage: unused, verifyWebhook: unused } as unknown as PaymentProvider;
  const deps = { clock, ids, repo, ledger, policy, providers: { apple: provider }, grants: { topup, grantForPeriod } };
  const run = (customerId = 'alice', iap = {}) => registerStorePurchase({ ...deps, customerId, provider: 'apple', proof: { signedTransaction: 'jws' }, iap });
  return { ...deps, run, acks: () => acks };
}

it('EC:N1 N2 records, grants once and treats a replayed proof as a no-op', async () => {
  const t = await setup(() => purchase());
  const first = await t.run();
  expect(first).toMatchObject({ replayed: false, acknowledged: true, payment: { id: 'payment:apple:txn-1', customerId: 'alice', subscriptionId: 'subscription:apple:orig-1' } });
  const again = await t.run();
  expect(again.replayed).toBe(true);
  const grants = await t.ledger.entries('alice', { kind: 'grant' });
  expect(grants).toHaveLength(1);
  expect(grants[0]).toMatchObject({ amount: 100, source: 'subscription' });
  expect((await t.repo.subscriptions.get('subscription:apple:orig-1'))?.planId).toBe('pro');
  expect((await t.repo.customers.get('alice'))?.providerRefs).toEqual([{ provider: 'apple', ref: storeAccountToken('alice') }]);
});

it('EC:N4 security: a purchase whose account token belongs to someone else is refused and nothing is written', async () => {
  const t = await setup(() => purchase());
  await expect(t.run('bob')).rejects.toMatchObject({ code: 'iap_account_mismatch' });
  expect(await t.repo.payments.list()).toHaveLength(0);
  expect(await t.ledger.entries('bob', { kind: 'grant' })).toHaveLength(0);
});

it('EC:N4 a purchase without an account token needs allow_first_claim, and then belongs to its first claimer', async () => {
  const t = await setup(() => purchase({ accountToken: null }));
  await expect(t.run('alice')).rejects.toMatchObject({ code: 'iap_account_mismatch' });
  await t.run('alice', { accountLink: 'allow_first_claim' });
  await expect(t.run('bob', { accountLink: 'allow_first_claim' })).rejects.toMatchObject({ code: 'iap_already_claimed' });
});

it('EC:N3 security: sandbox purchases are refused when only production is accepted', async () => {
  const t = await setup(() => purchase({ environment: 'sandbox' }));
  await expect(t.run('alice', { environments: 'production_only' })).rejects.toMatchObject({ code: 'iap_wrong_environment' });
  await expect(t.run('alice')).resolves.toMatchObject({ replayed: false });
});

it('EC:N5 family-shared purchases follow the policy', async () => {
  const t = await setup(() => purchase({ ownership: 'family_shared' }));
  await expect(t.run('alice', { familySharing: 'ignore' })).rejects.toMatchObject({ code: 'iap_family_shared_refused' });
  await expect(t.run('alice')).resolves.toMatchObject({ replayed: false });
});

it('EC:A25 N11 pending, expired, unknown-product purchases are refused', async () => {
  await expect((await setup(() => purchase({ status: 'pending' }))).run()).rejects.toMatchObject({ code: 'iap_payment_not_succeeded' });
  const expired = purchase();
  expired.payment.period = { start: new Date(NOW.getTime() - 40 * DAY), end: new Date(NOW.getTime() - 10 * DAY) };
  await expect((await setup(() => expired)).run()).rejects.toMatchObject({ code: 'iap_purchase_expired' });
  await expect((await setup(() => purchase({ productId: 'nope' }))).run()).rejects.toMatchObject({ code: 'iap_unknown_product' });
});

it('EC:N11 when the store reports no price the catalog price is recorded and the plan grants', async () => {
  const t = await setup(() => ({ ...purchase({}, 'coins'), amountFromStore: false }));
  const r = await t.run();
  expect(r.payment).toMatchObject({ kind: 'topup', amount: { amountMinor: 1100, currency: 'KRW' } });
  expect((await t.ledger.entries('alice', { kind: 'grant' }))[0]).toMatchObject({ amount: 50, source: 'topup' });
});

it('EC:N1 acknowledgement runs after the grant; a failed one is retried by reackStorePurchases', async () => {
  let fail = true;
  const t = await setup(() => purchase({ acknowledged: false }), async () => { if (fail) throw new Error('store down'); return { acknowledged: true }; });
  const r = await t.run();
  expect(r.acknowledged).toBe(false);
  expect(await t.ledger.entries('alice', { kind: 'grant' })).toHaveLength(1);
  fail = false;
  expect(await reackStorePurchases(t)).toEqual({ acknowledged: 1, failed: [] });
  expect(await reackStorePurchases(t)).toEqual({ acknowledged: 0, failed: [] });
  expect(t.acks()).toBe(2);
});

it('EC:N9 a purchase that replaces another subscription ends the old one', async () => {
  const t = await setup(() => purchase());
  await t.run();
  const next = purchase({ subscriptionRef: 'orig-2', replacesSubscriptionRef: 'orig-1' });
  next.payment = { ...next.payment, id: 'txn-2', providerRef: 'txn-2', subscriptionId: 'orig-2' };
  next.subscription = { ...next.subscription!, id: 'orig-2', providerRef: 'orig-2' };
  const t2 = { ...t, providers: { apple: { ...t.providers.apple, verifyPurchase: async () => next } as unknown as PaymentProvider } };
  await registerStorePurchase({ ...t2, customerId: 'alice', provider: 'apple', proof: { signedTransaction: 'jws' } });
  expect((await t.repo.subscriptions.get('subscription:apple:orig-1'))?.status).toBe('canceled');
  expect((await t.repo.subscriptions.get('subscription:apple:orig-2'))?.status).toBe('active');
});
