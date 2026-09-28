// spec: packages/lifecycle/spec/lifecycle.pseudo.md [EC:A1] [EC:A2] [EC:F]
import { describe, expect, it } from 'vitest';
import { FixedClock, InMemoryLedger, InMemoryRepo, Plan, Subscription, SequentialIdGen, resolvePolicy } from 'boilpayment-core';
import { upgrade } from '../src/index.js';
import { FakeNativeProvider, FakeSelfSchedulingProvider } from './helpers.js';

const planA: Plan = { id: 'plan_a', name: 'Plan A', interval: 'month', creditsPerPeriod: 100, usageIncluded: 0, trialDays: 0, prices: [{ currency: 'USD', amountMinor: 1000 }] };
const planB: Plan = { id: 'plan_b', name: 'Plan B', interval: 'month', creditsPerPeriod: 300, usageIncluded: 0, trialDays: 0, prices: [{ currency: 'USD', amountMinor: 3000 }] };

function mkSub(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 'sub_1', customerId: 'cust_1', planId: planA.id, provider: 'stripe', providerRef: 'stripe_sub_1',
    status: 'active', currentPeriod: { start: new Date('2024-01-01T00:00:00.000Z'), end: new Date('2024-02-01T00:00:00.000Z') },
    anchorDay: 1, cancelAtPeriodEnd: false, graceUntil: null, billingKey: null, scheduledPlanId: null,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

async function setup() {
  const clock = new FixedClock(new Date('2024-01-16T00:00:00.000Z')); // day 16 of a 31-day Jan period
  const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
  const repo = new InMemoryRepo();
  const ids = new SequentialIdGen('id_');
  await repo.plans.put(planA);
  await repo.plans.put(planB);
  return { clock, ledger, repo, ids };
}

describe('EC:A1 A2 upgrade.mode x upgrade.creditDelta', () => {
  it("native immediate_prorate_reset_anchor: the provider's new period (Jan16->Feb16, anchor 16) is kept and no delta is granted (EC:A77 — the new period's invoice grants)", async () => {
    const { clock, ledger, repo, ids } = await setup();
    const sub = mkSub();
    await repo.subscriptions.put(sub);
    const provider = new FakeNativeProvider();
    provider.setDummySub({ ...sub, anchorDay: 16, currentPeriod: { start: new Date('2024-01-16T00:00:00.000Z'), end: new Date('2024-02-16T00:00:00.000Z') } });
    const policy = resolvePolicy(); // default: immediate_prorate_reset_anchor, full_delta

    const res = await upgrade({ sub, newPlan: planB, policy, provider, ledger, repo, clock, ids });
    expect(res.creditDelta).toBe(0);
    expect(res.sub.anchorDay).toBe(16);
    expect(res.sub.currentPeriod).toEqual({ start: new Date('2024-01-16T00:00:00.000Z'), end: new Date('2024-02-16T00:00:00.000Z') });
    expect(res.sub.planId).toBe(planB.id);
    expect(provider.changeSubscriptionCalled).toBe(1);
    const bal = await ledger.balance('cust_1', undefined, clock.now());
    expect(bal.available).toBe(0);
  });

  it('immediate_prorate_keep_anchor + full_delta: creditDelta=200, currentPeriod/anchorDay unchanged', async () => {
    const { clock, ledger, repo, ids } = await setup();
    const sub = mkSub();
    await repo.subscriptions.put(sub);
    const provider = new FakeNativeProvider();
    provider.setDummySub(sub);
    const policy = resolvePolicy({ upgrade: { mode: 'immediate_prorate_keep_anchor' } });

    const res = await upgrade({ sub, newPlan: planB, policy, provider, ledger, repo, clock, ids });
    expect(res.creditDelta).toBe(200);
    expect(res.sub.anchorDay).toBe(1);
    expect(res.sub.currentPeriod).toEqual(sub.currentPeriod); // unchanged
    expect(provider.changeSubscriptionCalled).toBe(1);
  });

  it("immediate_prorate_keep_anchor + prorated_delta: creditDelta=floor(200 * 16/31)=103", async () => {
    const { clock, ledger, repo, ids } = await setup();
    const sub = mkSub();
    await repo.subscriptions.put(sub);
    const provider = new FakeNativeProvider();
    provider.setDummySub(sub);
    const policy = resolvePolicy({ upgrade: { mode: 'immediate_prorate_keep_anchor', creditDelta: 'prorated_delta' } });

    const res = await upgrade({ sub, newPlan: planB, policy, provider, ledger, repo, clock, ids });
    expect(res.creditDelta).toBe(103);
  });

  it('next_period: no immediate change, schedules the plan switch, no grant', async () => {
    const { clock, ledger, repo, ids } = await setup();
    const sub = mkSub();
    await repo.subscriptions.put(sub);
    const provider = new FakeNativeProvider(); // must NOT be called
    const policy = resolvePolicy({ upgrade: { mode: 'next_period' } });

    const res = await upgrade({ sub, newPlan: planB, policy, provider, ledger, repo, clock, ids });
    expect(res.creditDelta).toBe(0);
    expect(res.grant).toBeNull();
    expect(res.sub.scheduledPlanId).toBe(planB.id);
    expect(res.sub.planId).toBe(planA.id); // unchanged now
    expect(provider.changeSubscriptionCalled).toBe(0);
    const bal = await ledger.balance('cust_1', undefined, clock.now());
    expect(bal.available).toBe(0);
  });
});

describe('EC:F upgrade on a self-scheduling (Toss-shaped) provider', () => {
  it('does NOT call changeSubscription; charges the prorated money delta via chargeBillingKey (1032 minor for $10->$30 on day 16 of 31)', async () => {
    const { clock, ledger, repo, ids } = await setup();
    const sub = mkSub({ id: 'sub_toss_1', customerId: 'cust_toss_1', provider: 'toss', providerRef: 'toss_sub_1', billingKey: 'bk_toss_1' });
    await repo.subscriptions.put(sub);
    const provider = new FakeSelfSchedulingProvider();
    const policy = resolvePolicy({ upgrade: { mode: 'immediate_prorate_keep_anchor' } });

    const res = await upgrade({ sub, newPlan: planB, policy, provider, ledger, repo, clock, ids });
    expect(res.creditDelta).toBe(200);
    expect(provider.lastCharge).not.toBeNull();
    expect(provider.lastCharge?.amountMinor).toBe(1032);
    expect(provider.lastCharge?.currency).toBe('USD');
    const bal = await ledger.balance('cust_toss_1', undefined, clock.now());
    expect(bal.available).toBe(200); // only the upgrade credit delta itself (no prior period grant in this test)
  });

  it('[EC:A59] reset_anchor charges the new price less the unused share of the old one (3000 - ceil(1000*16/31) = 2483) and grants 300 - floor(100*16/31) = 249 credits', async () => {
    const { clock, ledger, repo, ids } = await setup();
    const sub = mkSub({ id: 'sub_toss_r', customerId: 'cust_toss_r', provider: 'toss', providerRef: null, billingKey: 'bk_toss_r' });
    await repo.subscriptions.put(sub);
    const provider = new FakeSelfSchedulingProvider();

    const res = await upgrade({ sub, newPlan: planB, policy: resolvePolicy(), provider, ledger, repo, clock, ids });
    expect(provider.lastCharge?.amountMinor).toBe(2483);
    expect(res.creditDelta).toBe(249);
    expect(res.sub.currentPeriod.start).toEqual(clock.now());
    // EC:A62 — the charge has a local row and the credits it bought point at it.
    const rows = await repo.payments.list({ subscriptionId: sub.id } as never);
    expect(rows.map((r) => [r.status, r.amount.amountMinor, r.period])).toEqual([['succeeded', 2483, null]]);
    expect(res.grant?.reference.paymentId).toBe(rows[0]!.id);
  });

  it('throws billing_key_required when the subscription has no billing key', async () => {
    const { clock, ledger, repo, ids } = await setup();
    const sub = mkSub({ id: 'sub_toss_2', customerId: 'cust_toss_2', provider: 'toss', providerRef: 'toss_sub_2', billingKey: null });
    await repo.subscriptions.put(sub);
    const provider = new FakeSelfSchedulingProvider();
    const policy = resolvePolicy();

    await expect(upgrade({ sub, newPlan: planB, policy, provider, ledger, repo, clock, ids })).rejects.toThrow(/billing_key_required|billing key/);
  });
});

describe('EC:J1-J5 upgrade operation idempotency', () => {
  it('[EC:J1] calling upgrade() twice with the default key grants exactly once (no double-charge/double-grant)', async () => {
    const { clock, ledger, repo, ids } = await setup();
    const sub = mkSub();
    await repo.subscriptions.put(sub);
    const provider = new FakeNativeProvider();
    provider.setDummySub(sub);
    const policy = resolvePolicy({ upgrade: { mode: 'immediate_prorate_keep_anchor' } });

    const first = await upgrade({ sub, newPlan: planB, policy, provider, ledger, repo, clock, ids });
    const second = await upgrade({ sub, newPlan: planB, policy, provider, ledger, repo, clock, ids });

    expect(second.creditDelta).toBe(first.creditDelta);
    expect(second.sub).toEqual(first.sub);
    expect(provider.changeSubscriptionCalled).toBe(1); // not re-charged at the provider
    const bal = await ledger.balance('cust_1', undefined, clock.now());
    expect(bal.available).toBe(200); // granted exactly once, not 400
  });

  it('[EC:J2] a retried upgrade() with the same key but a different newPlan throws idempotency_key_reused', async () => {
    const { clock, ledger, repo, ids } = await setup();
    const sub = mkSub();
    await repo.subscriptions.put(sub);
    const provider = new FakeNativeProvider();
    provider.setDummySub(sub);
    const policy = resolvePolicy();

    await upgrade({ sub, newPlan: planB, policy, provider, ledger, repo, clock, ids, idempotencyKey: 'upgrade:fixed' });

    const planC = { ...planB, id: 'plan_c', creditsPerPeriod: 500 };
    await expect(
      upgrade({ sub, newPlan: planC, policy, provider, ledger, repo, clock, ids, idempotencyKey: 'upgrade:fixed' }),
    ).rejects.toMatchObject({ code: 'idempotency_key_reused' });
  });
});

describe('[EC:J7] self-scheduled upgrade proration is exact', () => {
  it('[EC:J7] 8.7 of 30 days remaining on a 100 price delta charges 29', async () => {
    const DAY = 86_400_000;
    const now = new Date('2024-01-16T00:00:00.000Z');
    const clock = new FixedClock(now);
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const repo = new InMemoryRepo();
    const ids = new SequentialIdGen('id_');
    const a: Plan = { ...planA, prices: [{ currency: 'USD', amountMinor: 1000 }] };
    const b: Plan = { ...planB, prices: [{ currency: 'USD', amountMinor: 1100 }] };
    await repo.plans.put(a);
    await repo.plans.put(b);
    const sub = mkSub({ provider: 'toss', providerRef: null, billingKey: 'bk', currentPeriod: { start: new Date(now.getTime() - 21.3 * DAY), end: new Date(now.getTime() + 8.7 * DAY) } });
    await repo.subscriptions.put(sub);
    const provider = new FakeSelfSchedulingProvider();
    await upgrade({ sub, newPlan: b, policy: resolvePolicy({ proration: { denominator: 'fixed_30' }, upgrade: { mode: 'immediate_prorate_keep_anchor' } }), provider, ledger, repo, clock, ids });
    expect(provider.lastCharge?.amountMinor).toBe(29);
  });
});
