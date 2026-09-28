// spec: packages/lifecycle/spec/lifecycle.pseudo.md [EC:A3] [EC:A4] [EC:F]
import { describe, expect, it } from 'vitest';
import { FixedClock, InMemoryLedger, InMemoryRepo, Payment, Plan, Subscription, SequentialIdGen, resolvePolicy } from 'boilpayment-core';
import type { PaymentProvider } from 'boilpayment-core';
import { downgrade, onRenewalPaid } from '../src/index.js';
import { FakeNativeProvider, FakeSelfSchedulingProvider } from './helpers.js';

const planA: Plan = { id: 'plan_a', name: 'Plan A', interval: 'month', creditsPerPeriod: 100, usageIncluded: 0, trialDays: 0, prices: [{ currency: 'USD', amountMinor: 1000, providerPriceRefs: { stripe: 'price_stripe_a', polar: 'price_polar_a' } }] };
const planB: Plan = { id: 'plan_b', name: 'Plan B', interval: 'month', creditsPerPeriod: 300, usageIncluded: 0, trialDays: 0, prices: [{ currency: 'USD', amountMinor: 3000 }] };

function mkSub(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 'sub_1', customerId: 'cust_1', planId: planB.id, provider: 'stripe', providerRef: 'stripe_sub_1',
    status: 'active', currentPeriod: { start: new Date('2024-01-01T00:00:00.000Z'), end: new Date('2024-02-01T00:00:00.000Z') },
    anchorDay: 1, cancelAtPeriodEnd: false, graceUntil: null, billingKey: null, scheduledPlanId: null,
    version: 0, createdAt: new Date('2024-01-01T00:00:00.000Z'),
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

class SchedulingNativeProvider extends FakeNativeProvider {
  lastChange: Parameters<PaymentProvider['changeSubscription']>[1] | null = null;

  override async changeSubscription(
    _providerRef: string,
    input: Parameters<PaymentProvider['changeSubscription']>[1],
  ): Promise<Subscription> {
    this.lastChange = input;
    return super.changeSubscription();
  }
}

describe('[SB-14] end-of-period downgrade', () => {
  it.each(['stripe', 'polar'] as const)('%s schedules the lower provider price at the boundary, preserves current credits, and renews on the lower plan', async (providerName) => {
    const { clock, ledger, repo, ids } = await setup(300);
    const sub = mkSub({ provider: providerName, providerRef: `${providerName}_sub_1` });
    await repo.subscriptions.put(sub);
    const provider = new SchedulingNativeProvider();
    provider.setDummySub({ ...sub, planId: planA.id });

    const downgraded = await downgrade({ sub, newPlan: planA, policy: resolvePolicy(), provider, ledger, repo, clock, ids });

    expect(provider.lastChange).toMatchObject({
      newPriceRef: `price_${providerName}_a`, proration: 'none', resetAnchor: false,
    });
    expect(downgraded.sub.planId).toBe(planB.id);
    expect(downgraded.sub.scheduledPlanId).toBe(planA.id);
    expect((await ledger.balance(sub.customerId, 'paid', clock.now())).available).toBe(300);

    const nextPeriod = { start: sub.currentPeriod.end, end: new Date('2024-03-01T00:00:00.000Z') };
    const renewal: Payment = {
      id: `pay_${providerName}_renewal`, customerId: sub.customerId, provider: providerName,
      providerRef: `${providerName}_renewal`, subscriptionId: sub.id,
      amount: { amountMinor: 1000, currency: 'USD' }, status: 'succeeded', kind: 'subscription',
      period: nextPeriod, occurredAt: nextPeriod.start, failure: null,
    };
    const renewed = await onRenewalPaid({ sub: downgraded.sub, payment: renewal, policy: resolvePolicy(), ledger, repo, clock });
    expect(renewed.sub.planId).toBe(planA.id);
    expect(renewed.grant.entry?.amount).toBe(planA.creditsPerPeriod);
  });
});

describe("EC:A3 downgrade.mode='end_of_period' — keeps grants, only schedules", () => {
  it('sets scheduledPlanId, schedules the native provider price, keeps planId unchanged, and performs no clawback', async () => {
    const { clock, ledger, repo, ids } = await setup(300);
    const sub = mkSub();
    await repo.subscriptions.put(sub);
    const provider = new FakeNativeProvider();
    provider.setDummySub({ ...sub, planId: planA.id });
    const policy = resolvePolicy(); // default: end_of_period

    const res = await downgrade({ sub, newPlan: planA, policy, provider, ledger, repo, clock, ids });
    expect(res.sub.scheduledPlanId).toBe(planA.id);
    expect(res.sub.planId).toBe(planB.id); // unchanged now
    expect(res.clawback).toBeNull();
    expect(provider.changeSubscriptionCalled).toBe(1);
    const bal = await ledger.balance('cust_1', undefined, clock.now());
    expect(bal.available).toBe(300); // untouched
  });

  it('keeps a self-scheduled provider local-only', async () => {
    const { clock, ledger, repo, ids } = await setup(300, 'cust_toss_schedule');
    const sub = mkSub({ id: 'sub_toss_schedule', customerId: 'cust_toss_schedule', provider: 'toss', providerRef: null });
    await repo.subscriptions.put(sub);
    const result = await downgrade({ sub, newPlan: planA, policy: resolvePolicy(), provider: new FakeSelfSchedulingProvider(), ledger, repo, clock, ids });
    expect(result.sub.planId).toBe(planB.id);
    expect(result.sub.scheduledPlanId).toBe(planA.id);
  });

  it('[SB-14] keeps an unsupported Apple native provider local-only', async () => {
    const { clock, ledger, repo, ids } = await setup(0, 'cust_apple_schedule');
    const sub = mkSub({ id: 'sub_apple_schedule', customerId: 'cust_apple_schedule', provider: 'apple', providerRef: 'apple_sub' });
    await repo.subscriptions.put(sub);
    const provider = new FakeNativeProvider(); // would throw because no dummy subscription is configured.

    const result = await downgrade({ sub, newPlan: planA, policy: resolvePolicy(), provider, ledger, repo, clock, ids });

    expect(provider.changeSubscriptionCalled).toBe(0);
    expect(result.sub.scheduledPlanId).toBe(planA.id);
  });

  it('[SB-14] grants by the uniquely matched charged plan and opens a needs-human case when provider scheduling did not take effect', async () => {
    const { clock, ledger, repo } = await setup(0);
    const sub = mkSub({ scheduledPlanId: planA.id });
    await repo.subscriptions.put(sub);
    const nextPeriod = { start: sub.currentPeriod.end, end: new Date('2024-03-01T00:00:00.000Z') };
    const payment: Payment = {
      id: 'pay_wrong_price', customerId: sub.customerId, provider: 'stripe', providerRef: 'in_wrong_price',
      subscriptionId: sub.id, amount: { amountMinor: 3000, currency: 'USD' }, status: 'succeeded',
      kind: 'subscription', period: nextPeriod, occurredAt: nextPeriod.start, failure: null,
    };

    const renewed = await onRenewalPaid({ sub, payment, policy: resolvePolicy(), ledger, repo, clock });

    expect(renewed.grant.entry?.amount).toBe(planB.creditsPerPeriod);
    expect(renewed.sub.planId).toBe(planB.id);
    expect(renewed.sub.scheduledPlanId).toBeNull();
    expect((await repo.csCases.get(`reconcile_mismatch:${payment.id}`))?.status).toBe('needs_human');
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
