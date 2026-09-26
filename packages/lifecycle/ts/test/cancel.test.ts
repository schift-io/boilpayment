// spec: packages/lifecycle/spec/lifecycle.pseudo.md [EC:A5] [EC:A6] [EC:F]
import { describe, expect, it } from 'vitest';
import { FixedClock, InMemoryLedger, InMemoryRepo, Subscription, SequentialIdGen, resolvePolicy } from '@schift/payment-kit-core';
import { cancel } from '../src/index.js';
import { FakeNativeProvider, FakeSelfSchedulingProvider } from './helpers.js';

function mkSub(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 'sub_1', customerId: 'cust_1', planId: 'plan_a', provider: 'stripe', providerRef: 'stripe_sub_1',
    status: 'active', currentPeriod: { start: new Date('2024-01-01T00:00:00.000Z'), end: new Date('2024-02-01T00:00:00.000Z') },
    anchorDay: 1, cancelAtPeriodEnd: false, graceUntil: null, billingKey: null, scheduledPlanId: null,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

async function setup(paidBalance: number) {
  const clock = new FixedClock(new Date('2024-01-16T00:00:00.000Z'));
  const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
  const repo = new InMemoryRepo();
  if (paidBalance > 0) {
    await ledger.append({
      customerId: 'cust_1', pool: 'paid', kind: 'grant', amount: paidBalance, unitPriceMinor: null, currency: null,
      expiresAt: null, source: 'subscription', reference: {}, idempotencyKey: 'seed_grant', actor: 'system', reason: null,
    });
  }
  return { clock, ledger, repo };
}

describe("EC:A5 cancel.mode='end_of_period' (default)", () => {
  it('cancelAtPeriodEnd=true, status stays active, provider.cancelSubscription(atPeriodEnd=true)', async () => {
    const { clock, ledger, repo } = await setup(100);
    const sub = mkSub();
    await repo.subscriptions.put(sub);
    const provider = new FakeNativeProvider();
    provider.setDummySub(sub);
    const policy = resolvePolicy();

    const res = await cancel({ sub, policy, provider, ledger, repo, clock });
    expect(res.sub.status).toBe('active');
    expect(res.sub.cancelAtPeriodEnd).toBe(true);
    expect(provider.cancelSubscriptionCalled).toBe(1);
  });
});

describe("EC:A5 cancel.mode='immediate'", () => {
  it("status='canceled' immediately, provider.cancelSubscription(atPeriodEnd=false)", async () => {
    const { clock, ledger, repo } = await setup(100);
    const sub = mkSub();
    await repo.subscriptions.put(sub);
    const provider = new FakeNativeProvider();
    provider.setDummySub(sub);
    const policy = resolvePolicy({ cancel: { mode: 'immediate' } });

    const res = await cancel({ sub, policy, provider, ledger, repo, clock });
    expect(res.sub.status).toBe('canceled');
    expect(res.sub.cancelAtPeriodEnd).toBe(false);
    expect(provider.cancelSubscriptionCalled).toBe(1);
  });
});

describe('EC:A6 cancel.credits', () => {
  it("'keep_until_period_end' (default) leaves the paid balance untouched", async () => {
    const { clock, ledger, repo } = await setup(100);
    const sub = mkSub();
    await repo.subscriptions.put(sub);
    const provider = new FakeNativeProvider();
    provider.setDummySub(sub);
    const policy = resolvePolicy();

    const res = await cancel({ sub, policy, provider, ledger, repo, clock });
    expect(res.revoked).toBeNull();
    const bal = await ledger.balance('cust_1', undefined, clock.now());
    expect(bal.available).toBe(100);
  });

  it("'revoke_immediately' claws back the full paid balance", async () => {
    const { clock, ledger, repo } = await setup(100);
    const sub = mkSub();
    await repo.subscriptions.put(sub);
    const provider = new FakeNativeProvider();
    provider.setDummySub(sub);
    const policy = resolvePolicy({ cancel: { credits: 'revoke_immediately' } });

    const res = await cancel({ sub, policy, provider, ledger, repo, clock });
    expect(res.revoked?.revoked).toBe(100);
    const bal = await ledger.balance('cust_1', undefined, clock.now());
    expect(bal.available).toBe(0);
  });
});

describe('EC:F cancel on a self-scheduling (Toss-shaped) provider never calls cancelSubscription', () => {
  it('still updates sub.status via repo only', async () => {
    const { clock, ledger, repo } = await setup(0);
    const sub = mkSub({ id: 'sub_toss_1', customerId: 'cust_toss_1', provider: 'toss', providerRef: 'toss_sub_1' });
    await repo.subscriptions.put(sub);
    const provider = new FakeSelfSchedulingProvider(); // cancelSubscription throws 'unsupported' if called
    const policy = resolvePolicy({ cancel: { mode: 'immediate' } });

    const res = await cancel({ sub, policy, provider, ledger, repo, clock });
    expect(res.sub.status).toBe('canceled');
  });
});

it('EC:A6 rejects unsupported keep_forever before any cancellation mutation', async () => {
  const { clock, ledger, repo } = await setup(100);
  const sub = mkSub();
  await repo.subscriptions.put(sub);
  const before = await repo.subscriptions.get(sub.id);
  const provider = new FakeNativeProvider();
  provider.setDummySub(sub);
  const policy = resolvePolicy({ cancel: { credits: 'keep_forever' } });
  await expect(cancel({ sub, policy, provider, ledger, repo, clock })).rejects.toMatchObject({ code: 'unsupported' });
  expect(provider.cancelSubscriptionCalled).toBe(0);
  expect(await repo.subscriptions.get(sub.id)).toEqual(before);
  expect(await repo.operations.list()).toEqual([]);
  expect((await ledger.balance(sub.customerId, undefined, clock.now())).available).toBe(100);
});
