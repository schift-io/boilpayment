// [EC:A28] A subscription charges in the currency it was bought in. Renewals, dunning retries and
// upgrade proration pick the plan price in the subscription's currency; a plan with no price in
// that currency is refused, never charged in another currency.
import { describe, expect, it } from 'vitest';
import { CollectingNotifier, FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen, resolvePolicy } from 'boilpayment-core';
import type { Plan, Subscription } from 'boilpayment-core';
import { dunning, scheduler, upgrade } from '../src/index.js';
import { resolvePriceRef } from '../src/internal.js';
import { FakeSelfSchedulingProvider } from './helpers.js';

const planA: Plan = { id: 'plan_a', name: 'A', interval: 'month', creditsPerPeriod: 100, usageIncluded: 0, trialDays: 0,
  prices: [{ currency: 'USD', amountMinor: 1000, providerPriceRefs: { stripe: 'price_a_usd' } }, { currency: 'KRW', amountMinor: 13000, providerPriceRefs: { stripe: 'price_a_krw' } }] };
const planB: Plan = { id: 'plan_b', name: 'B', interval: 'month', creditsPerPeriod: 300, usageIncluded: 0, trialDays: 0,
  prices: [{ currency: 'USD', amountMinor: 3000, providerPriceRefs: { stripe: 'price_b_usd' } }, { currency: 'KRW', amountMinor: 39000, providerPriceRefs: { stripe: 'price_b_krw' } }] };

function mkSub(o: Partial<Subscription> = {}): Subscription {
  return { id: 'sub_1', customerId: 'cust_1', planId: planA.id, provider: 'toss', providerRef: null, status: 'active',
    currentPeriod: { start: new Date('2024-01-01T00:00:00.000Z'), end: new Date('2024-02-01T00:00:00.000Z') }, anchorDay: 1,
    cancelAtPeriodEnd: false, graceUntil: null, billingKey: 'bk_1', scheduledPlanId: null, version: 0, currency: 'KRW',
    createdAt: new Date('2024-01-01T00:00:00.000Z'), ...o };
}
async function harness(at: string) {
  const repo = new InMemoryRepo();
  await repo.plans.put(planA);
  await repo.plans.put(planB);
  return { repo, ledger: new InMemoryLedger(new SequentialIdGen('led_')), clock: new FixedClock(new Date(at)), ids: new SequentialIdGen('id_') };
}

describe('[EC:A28] subscription currency', () => {
  it('[EC:A28] a KRW renewal charges the KRW price', async () => {
    const h = await harness('2024-02-01T00:00:00.000Z');
    await h.repo.subscriptions.put(mkSub());
    const provider = new FakeSelfSchedulingProvider();
    await scheduler.tick({ provider, policy: resolvePolicy(), ...h });
    expect([provider.lastCharge?.currency, provider.lastCharge?.amountMinor]).toEqual(['KRW', 13000]);
  });

  it('[EC:A28] a plan without a price in the subscription currency is not charged', async () => {
    const h = await harness('2024-02-01T00:00:00.000Z');
    await h.repo.subscriptions.put(mkSub({ currency: 'EUR' }));
    const provider = new FakeSelfSchedulingProvider();
    const res = await scheduler.tick({ provider, policy: resolvePolicy(), ...h });
    expect([provider.lastCharge, res.failed.length]).toEqual([null, 1]);
  });

  it('[EC:A28] a dunning retry charges the KRW price', async () => {
    const h = await harness('2024-01-16T00:00:00.000Z');
    const sub = mkSub({ status: 'past_due' });
    await h.repo.subscriptions.put(sub);
    const base = resolvePolicy({ dunning: { retryAttempts: 3 } });
    const policy = { ...base, dunning: { ...base.dunning, retryIntervalHours: [24] } };
    const notifier = new CollectingNotifier();
    await dunning.onPaymentFailed({ sub, policy, repo: h.repo, notifier, clock: h.clock });
    const retryClock = new FixedClock(new Date('2024-01-17T00:00:00.001Z'));
    const [item] = await dunning.retryDue({ repo: h.repo, clock: retryClock });
    const provider = new FakeSelfSchedulingProvider();
    await dunning.runRetry({ item, provider, repo: h.repo, ledger: h.ledger, policy, notifier, clock: retryClock });
    expect([provider.lastCharge?.currency, provider.lastCharge?.amountMinor]).toEqual(['KRW', 13000]);
  });

  it('[EC:A28] a self-scheduled upgrade prorates the KRW prices', async () => {
    const h = await harness('2024-01-16T00:00:00.000Z');
    const sub = mkSub();
    await h.repo.subscriptions.put(sub);
    const provider = new FakeSelfSchedulingProvider();
    await upgrade({ sub, newPlan: planB, policy: resolvePolicy(), provider, ...h });
    expect(provider.lastCharge?.currency).toBe('KRW');
  });

  it('[EC:A28] the native price ref follows the subscription currency', () => {
    expect([resolvePriceRef(planB, 'stripe', 'KRW'), resolvePriceRef(planB, 'stripe', 'USD'), resolvePriceRef(planB, 'stripe')]).toEqual(['price_b_krw', 'price_b_usd', 'price_b_usd']);
  });
});
