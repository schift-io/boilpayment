import { expect, it } from 'vitest';
import { FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen, resolvePolicy, type Subscription } from '@schift/payment-kit-core';
import { cancel, downgrade, reactivate, upgrade } from '../src/index.js';
import { FakeNativeProvider, FakeSelfSchedulingProvider } from './helpers.js';

it.each(['cancel', 'upgrade', 'downgrade', 'reactivate'] as const)('rejects native %s without a remote subscription reference before calling provider', async (action) => {
  const repo = new InMemoryRepo();
  const clock = new FixedClock(new Date('2026-01-15T00:00:00Z'));
  const ledger = new InMemoryLedger();
  const ids = new SequentialIdGen('id_');
  const policy = resolvePolicy({ downgrade: { mode: 'immediate_keep' } });
  const plan = { id: 'plan', name: 'Plan', interval: 'month', creditsPerPeriod: 100, usageIncluded: 0, trialDays: 0, prices: [{ currency: 'USD', amountMinor: 1000 }] } as const;
  await repo.plans.put({ ...plan, prices: [...plan.prices] });
  const newPlan = { ...plan, id: 'new', prices: [...plan.prices] };
  const sub: Subscription = { id: 'sub', customerId: 'customer', planId: 'plan', provider: 'stripe', providerRef: null, status: 'active', currentPeriod: { start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-02-01T00:00:00Z') }, anchorDay: 1, cancelAtPeriodEnd: true, graceUntil: null, billingKey: null, scheduledPlanId: null, version: 0, createdAt: clock.now() };
  await repo.subscriptions.put(sub);
  const provider = new FakeNativeProvider();
  provider.setDummySub(sub);
  const input = { repo, clock, ledger, ids, policy, sub, provider, newPlan };
  const actions = { cancel, upgrade, downgrade, reactivate };
  await expect(actions[action](input)).rejects.toMatchObject({ code: 'subscription_provider_ref_required' });
  expect(provider.cancelSubscriptionCalled + provider.changeSubscriptionCalled + provider.uncancelSubscriptionCalled).toBe(0);
});

it('self scheduling cancellation accepts a null remote subscription reference', async () => {
  const repo = new InMemoryRepo();
  const clock = new FixedClock(new Date('2026-01-15T00:00:00Z'));
  const sub: Subscription = { id: 'self', customerId: 'customer', planId: 'plan', provider: 'toss', providerRef: null, status: 'active', currentPeriod: { start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-02-01T00:00:00Z') }, anchorDay: 1, cancelAtPeriodEnd: false, graceUntil: null, billingKey: 'billing-key', scheduledPlanId: null, version: 0, createdAt: clock.now() };
  await repo.subscriptions.put(sub);
  const result = await cancel({ repo, clock, sub, ledger: new InMemoryLedger(), policy: resolvePolicy(), provider: new FakeSelfSchedulingProvider() });
  expect(result.sub.providerRef).toBeNull();
  expect(result.sub.cancelAtPeriodEnd).toBe(true);
});
