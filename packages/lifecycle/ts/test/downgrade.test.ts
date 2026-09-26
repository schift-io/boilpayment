// spec: packages/lifecycle/spec/lifecycle.pseudo.md [EC:A3] [EC:A4] [EC:F]
import { describe, expect, it } from 'vitest';
import { FixedClock, InMemoryLedger, InMemoryRepo, Plan, Subscription, SequentialIdGen, resolvePolicy } from '@schift/payment-kit-core';
import { downgrade } from '../src/index.js';
import { FakeNativeProvider, FakeSelfSchedulingProvider } from './helpers.js';

const planA: Plan = { id: 'plan_a', name: 'Plan A', interval: 'month', creditsPerPeriod: 100, usageIncluded: 0, trialDays: 0, prices: [{ currency: 'USD', amountMinor: 1000 }] };
const planB: Plan = { id: 'plan_b', name: 'Plan B', interval: 'month', creditsPerPeriod: 300, usageIncluded: 0, trialDays: 0, prices: [{ currency: 'USD', amountMinor: 3000 }] };

function mkSub(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 'sub_1', customerId: 'cust_1', planId: planB.id, provider: 'stripe', providerRef: 'stripe_sub_1',
    status: 'active', currentPeriod: { start: new Date('2024-01-01T00:00:00.000Z'), end: new Date('2024-02-01T00:00:00.000Z') },
    anchorDay: 1, cancelAtPeriodEnd: false, graceUntil: null, billingKey: null, scheduledPlanId: null,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

async function setup(paidBalance: number, customerId = 'cust_1') {
  const clock = new FixedClock(new Date('2024-01-16T00:00:00.000Z'));
  const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
  const repo = new InMemoryRepo();
  const ids = new SequentialIdGen('id_');
  await repo.plans.put(planA);
  await repo.plans.put(planB);
  if (paidBalance > 0) {
    await ledger.append({
      customerId, pool: 'paid', kind: 'grant', amount: paidBalance, unitPriceMinor: null, currency: null,
      expiresAt: null, source: 'subscription', reference: {}, idempotencyKey: 'seed_grant', actor: 'system', reason: null,
    });
  }
  return { clock, ledger, repo, ids };
}

describe("EC:A3 downgrade.mode='end_of_period' — keeps grants, only schedules", () => {
  it('sets scheduledPlanId, does not touch provider, planId unchanged, no clawback', async () => {
    const { clock, ledger, repo, ids } = await setup(300);
    const sub = mkSub();
    await repo.subscriptions.put(sub);
    const provider = new FakeNativeProvider(); // must not be called
    const policy = resolvePolicy(); // default: end_of_period

    const res = await downgrade({ sub, newPlan: planA, policy, provider, ledger, repo, clock, ids });
    expect(res.sub.scheduledPlanId).toBe(planA.id);
    expect(res.sub.planId).toBe(planB.id); // unchanged now
    expect(res.clawback).toBeNull();
    expect(provider.changeSubscriptionCalled).toBe(0);
    const bal = await ledger.balance('cust_1', undefined, clock.now());
    expect(bal.available).toBe(300); // untouched
  });
});

describe("EC:A3 downgrade.mode='immediate_keep' — price changes now, grants kept", () => {
  it('calls changeSubscription, updates planId immediately, no clawback', async () => {
    const { clock, ledger, repo, ids } = await setup(300);
    const sub = mkSub();
    await repo.subscriptions.put(sub);
    const provider = new FakeNativeProvider();
    provider.setDummySub(sub);
    const policy = resolvePolicy({ downgrade: { mode: 'immediate_keep' } });

    const res = await downgrade({ sub, newPlan: planA, policy, provider, ledger, repo, clock, ids });
    expect(res.sub.planId).toBe(planA.id);
    expect(res.sub.scheduledPlanId).toBeNull();
    expect(res.clawback).toBeNull();
    expect(provider.changeSubscriptionCalled).toBe(1);
    const bal = await ledger.balance('cust_1', undefined, clock.now());
    expect(bal.available).toBe(300); // untouched
  });
});

describe("EC:A3 A4 downgrade.mode='immediate_clawback'", () => {
  it('claws back the credit surplus (300 -> 100 = delta 200) when balance covers it', async () => {
    const { clock, ledger, repo, ids } = await setup(250);
    const sub = mkSub();
    await repo.subscriptions.put(sub);
    const provider = new FakeNativeProvider();
    provider.setDummySub(sub);
    const policy = resolvePolicy({ downgrade: { mode: 'immediate_clawback' } });

    const res = await downgrade({ sub, newPlan: planA, policy, provider, ledger, repo, clock, ids });
    expect(res.sub.planId).toBe(planA.id);
    expect(res.clawback?.revoked).toBe(200);
    expect(res.clawback?.shortfall).toBe(0);
    const bal = await ledger.balance('cust_1', undefined, clock.now());
    expect(bal.available).toBe(50); // 250 - 200
  });

  it("EC:A4 clawback_shortfall='clamp_to_zero' clamps the revoke when balance is short", async () => {
    const { clock, ledger, repo, ids } = await setup(20); // only 20 available, delta wants 200
    const sub = mkSub();
    await repo.subscriptions.put(sub);
    const provider = new FakeNativeProvider();
    provider.setDummySub(sub);
    const policy = resolvePolicy({ downgrade: { mode: 'immediate_clawback', clawbackShortfall: 'clamp_to_zero' } });

    const res = await downgrade({ sub, newPlan: planA, policy, provider, ledger, repo, clock, ids });
    expect(res.clawback?.revoked).toBe(20);
    expect(res.clawback?.shortfall).toBe(180);
    const bal = await ledger.balance('cust_1', undefined, clock.now());
    expect(bal.available).toBe(0);
  });
});

describe('EC:F downgrade on a self-scheduling (Toss-shaped) provider never calls changeSubscription', () => {
  it('immediate_clawback still claws back credits without touching the provider', async () => {
    const { clock, ledger, repo, ids } = await setup(250, 'cust_toss_1');
    const sub = mkSub({ id: 'sub_toss_1', customerId: 'cust_toss_1', provider: 'toss', providerRef: 'toss_sub_1' });
    await repo.subscriptions.put(sub);
    const provider = new FakeSelfSchedulingProvider(); // changeSubscription throws 'unsupported' if called
    const policy = resolvePolicy({ downgrade: { mode: 'immediate_clawback' } });

    const res = await downgrade({ sub, newPlan: planA, policy, provider, ledger, repo, clock, ids });
    expect(res.sub.planId).toBe(planA.id);
    expect(res.clawback?.revoked).toBe(200);
    const bal = await ledger.balance('cust_toss_1', undefined, clock.now());
    expect(bal.available).toBe(50);
  });
});
