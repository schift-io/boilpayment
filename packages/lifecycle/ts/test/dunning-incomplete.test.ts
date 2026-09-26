// [EC:A27] A failed first payment of an incomplete subscription (Stripe `incomplete`: never paid)
// starts no grace period and no dunning: there is nothing to keep access for.
import { describe, expect, it } from 'vitest';
import { CollectingNotifier, FixedClock, InMemoryRepo, Subscription, resolvePolicy } from 'boilpayment-core';
import type { Plan } from 'boilpayment-core';
import { dunning } from '../src/index.js';

const plan: Plan = { id: 'plan_a', name: 'Plan A', interval: 'month', creditsPerPeriod: 100, usageIncluded: 0, trialDays: 0, prices: [{ currency: 'USD', amountMinor: 1000 }] };
const period = { start: new Date('2024-01-01T00:00:00.000Z'), end: new Date('2024-02-01T00:00:00.000Z') };
function mkSub(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 'sub_1', customerId: 'cust_1', planId: plan.id, provider: 'stripe', providerRef: 'stripe_sub_1',
    status: 'active', currentPeriod: period, anchorDay: 1, cancelAtPeriodEnd: false, graceUntil: null,
    billingKey: null, scheduledPlanId: null, version: 0, createdAt: period.start,
    ...overrides,
  };
}

describe('[EC:A27] dunning on an incomplete subscription', () => {
  it('[EC:A27] onPaymentFailed leaves it incomplete, no grace, no notification', async () => {
    const clock = new FixedClock(new Date('2024-01-01T01:00:00.000Z'));
    const repo = new InMemoryRepo();
    const notifier = new CollectingNotifier();
    const sub = mkSub({ status: 'incomplete' });
    await repo.subscriptions.put(sub);
    const res = await dunning.onPaymentFailed({ sub, policy: resolvePolicy(), repo, notifier, clock });
    const stored = await repo.subscriptions.get(sub.id);
    expect([res.sub.status, stored?.status, stored?.graceUntil, notifier.sent.length]).toEqual(['incomplete', 'incomplete', null, 0]);
    void plan;
  });
});
