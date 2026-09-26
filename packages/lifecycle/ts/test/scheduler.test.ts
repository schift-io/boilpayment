// spec: packages/lifecycle/spec/lifecycle.pseudo.md [EC:F]
import { describe, expect, it, vi } from 'vitest';
import { FixedClock, InMemoryLedger, InMemoryRepo, Plan, Subscription, SequentialIdGen, PaymentKitError, resolvePolicy } from 'boilpayment-core';
import { scheduler } from '../src/index.js';
import { FakeNativeProvider, FakeSelfSchedulingProvider } from './helpers.js';

const plan: Plan = { id: 'plan_a', name: 'Plan A', interval: 'month', creditsPerPeriod: 100, usageIncluded: 0, trialDays: 0, prices: [{ currency: 'USD', amountMinor: 1000 }] };

function mkSub(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 'sub_1', customerId: 'cust_1', planId: plan.id, provider: 'toss', providerRef: 'toss_sub_1',
    status: 'active', currentPeriod: { start: new Date('2024-01-01T00:00:00.000Z'), end: new Date('2024-02-01T00:00:00.000Z') },
    version: 0, anchorDay: 1, cancelAtPeriodEnd: false, graceUntil: null, billingKey: 'bk_1', scheduledPlanId: null,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('EC:F scheduler.dueSubscriptions', () => {
  it('picks only active subscriptions with a billingKey whose period has ended', async () => {
    const clock = new FixedClock(new Date('2024-02-01T00:00:00.000Z'));
    const repo = new InMemoryRepo();
    await repo.subscriptions.put(mkSub({ id: 'due_1' }));
    await repo.subscriptions.put(mkSub({ id: 'not_due_yet', currentPeriod: { start: new Date('2024-01-15T00:00:00.000Z'), end: new Date('2024-02-15T00:00:00.000Z') } }));
    await repo.subscriptions.put(mkSub({ id: 'no_billing_key', billingKey: null }));
    await repo.subscriptions.put(mkSub({ id: 'canceled', status: 'canceled' }));

    const due = await scheduler.dueSubscriptions({ repo, clock });
    expect(due.map((s) => s.id)).toEqual(['due_1']);
  });
});

describe("EC:F scheduler.tick — only runs for provider.capabilities().scheduling === 'self'", () => {
  it("scheduling='provider' (e.g. Stripe/PortOne) is a no-op — chargeBillingKey never called", async () => {
    const clock = new FixedClock(new Date('2024-02-01T00:00:00.000Z'));
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const repo = new InMemoryRepo();
    const ids = new SequentialIdGen('id_');
    await repo.plans.put(plan);
    await repo.subscriptions.put(mkSub());
    const provider = new FakeNativeProvider(); // scheduling='provider'; chargeBillingKey throws if called
    const policy = resolvePolicy();

    const res = await scheduler.tick({ provider, repo, policy, ledger, clock, ids });
    expect(res).toEqual({ charged: [], failed: [], errors: [] });
  });

  it("scheduling='self' (Toss) charges due subscriptions and drives onRenewalPaid on success", async () => {
    const clock = new FixedClock(new Date('2024-02-01T00:00:00.000Z'));
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const repo = new InMemoryRepo();
    const ids = new SequentialIdGen('id_');
    await repo.plans.put(plan);
    await repo.subscriptions.put(mkSub());
    const provider = new FakeSelfSchedulingProvider();
    provider.nextChargeStatus = 'succeeded';
    const policy = resolvePolicy();

    const res = await scheduler.tick({ provider, repo, policy, ledger, clock, ids });
    expect(res.charged).toHaveLength(1);
    expect(res.failed).toHaveLength(0);
    expect(res.charged[0].status).toBe('active');
    expect(res.charged[0].currentPeriod.start).toEqual(new Date('2024-02-01T00:00:00.000Z'));
    const bal = await ledger.balance('cust_1', undefined, clock.now());
    expect(bal.available).toBe(100); // plan.creditsPerPeriod granted for the new period
  });

  it("scheduling='self' drives dunning.onPaymentFailed when the charge fails", async () => {
    const clock = new FixedClock(new Date('2024-02-01T00:00:00.000Z'));
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const repo = new InMemoryRepo();
    const ids = new SequentialIdGen('id_');
    await repo.plans.put(plan);
    await repo.subscriptions.put(mkSub());
    const provider = new FakeSelfSchedulingProvider();
    provider.nextChargeStatus = 'failed';
    const policy = resolvePolicy();

    const res = await scheduler.tick({ provider, repo, policy, ledger, clock, ids });
    expect(res.charged).toHaveLength(0);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].status).toBe('past_due');
    const bal = await ledger.balance('cust_1', undefined, clock.now());
    expect(bal.available).toBe(0);
  });

  it("preserves unknown provider outcomes without starting dunning", async () => {
    const clock = new FixedClock(new Date('2024-02-01T00:00:00.000Z'));
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const repo = new InMemoryRepo();
    const ids = new SequentialIdGen('id_');
    await repo.plans.put(plan);
    await repo.subscriptions.put(mkSub());
    const provider = new FakeSelfSchedulingProvider();
    provider.nextChargeThrows = true;
    const policy = resolvePolicy();

    // EC:A30 — reported per subscription, not thrown out of the whole tick.
    const res = await scheduler.tick({ provider, repo, policy, ledger, clock, ids });
    expect(res.errors.map((e) => [e.subscriptionId, e.message])).toEqual([['sub_1', expect.stringContaining('provider unavailable')]]);
    expect((await repo.subscriptions.get('sub_1'))?.status).toBe('active');
    expect(await repo.outbox.list()).toEqual([]);
  });
});

// EC:F — unknown outcomes must never be converted into customer delinquency.
describe('scheduler bad-case boundaries', () => {
  async function setup() {
    const repo = new InMemoryRepo();
    await repo.plans.put(plan);
    await repo.subscriptions.put(mkSub());
    return { repo, provider: new FakeSelfSchedulingProvider(), policy: resolvePolicy(),
      ledger: new InMemoryLedger(new SequentialIdGen('led_')), ids: new SequentialIdGen('id_'),
      clock: new FixedClock(new Date('2024-02-01T00:00:00.000Z')) };
  }

  it('does not select a subscription scheduled to cancel at period end', async () => {
    const input = await setup();
    const sub = await input.repo.subscriptions.get('sub_1');
    if (!sub) throw new Error('fixture missing');
    await input.repo.subscriptions.put({ ...sub, cancelAtPeriodEnd: true });
    expect(await scheduler.dueSubscriptions(input)).toEqual([]);
    expect(await scheduler.tick(input)).toEqual({ charged: [], failed: [], errors: [] });
    expect(input.provider.lastCharge).toBeNull();
    const canceled = await input.repo.subscriptions.get('sub_1');
    expect(canceled?.status).toBe('canceled');
    expect(canceled?.cancelAtPeriodEnd).toBe(false);
    await scheduler.tick(input);
    expect(await input.repo.subscriptions.get('sub_1')).toEqual(canceled);
    expect(input.provider.lastCharge).toBeNull();
  });

  it.each(['canceled', 'advanced', 'wrong_provider', 'deleted'] as const)('revalidates %s rows before charging', async (change) => {
    const input = await setup();
    const sub = mkSub();
    const current = change === 'deleted' ? null : { ...sub,
      cancelAtPeriodEnd: change === 'canceled',
      provider: change === 'wrong_provider' ? 'stripe' : sub.provider,
      currentPeriod: change === 'advanced' ? { start: sub.currentPeriod.end, end: new Date('2024-03-01T00:00:00.000Z') } : sub.currentPeriod };
    vi.spyOn(input.repo.subscriptions, 'get').mockResolvedValue(current);
    expect(await scheduler.tick(input)).toEqual({ charged: [], failed: [], errors: [] });
    expect(input.provider.lastCharge).toBeNull();
  });

  it('does not dunn a pending charge', async () => {
    const input = await setup();
    input.provider.nextChargeStatus = 'pending';
    expect((await scheduler.tick(input)).errors).toMatchObject([{ subscriptionId: 'sub_1', code: 'scheduler_charge_unresolved' }]);
    expect((await input.repo.subscriptions.get('sub_1'))?.status).toBe('active');
    expect(await input.repo.outbox.list()).toEqual([]);
  });

  it.each(['ledger', 'repository'] as const)('reports post-charge %s failure without dunning', async (failure) => {
    const input = await setup();
    const error = new PaymentKitError('storage unavailable', 'storage_unavailable');
    if (failure === 'ledger') vi.spyOn(input.ledger, 'append').mockRejectedValue(error);
    else vi.spyOn(input.repo.subscriptions, 'put').mockRejectedValue(error);
    expect((await scheduler.tick(input)).errors).toMatchObject([{ subscriptionId: 'sub_1', code: 'storage_unavailable' }]);
    expect(input.provider.lastCharge).not.toBeNull();
    expect((await input.repo.subscriptions.get('sub_1'))?.status).toBe('active');
    expect(await input.repo.outbox.list()).toEqual([]);
  });
  it('recovers an already granted renewal after a failed subscription write', async () => {
    const input = await setup();
    const put = vi.spyOn(input.repo.subscriptions, 'put');
    put.mockRejectedValueOnce(new PaymentKitError('storage unavailable', 'storage_unavailable'));
    expect((await scheduler.tick(input)).errors).toMatchObject([{ subscriptionId: 'sub_1', code: 'storage_unavailable' }]);
    const firstCharge = input.provider.lastCharge;
    const result = await scheduler.tick(input);
    expect(result.charged[0].currentPeriod.start).toEqual(new Date('2024-02-01T00:00:00.000Z'));
    expect((await input.repo.subscriptions.get('sub_1'))?.currentPeriod.start).toEqual(new Date('2024-02-01T00:00:00.000Z'));
    expect(input.provider.lastCharge).toEqual(firstCharge);
    expect((await input.ledger.balance('cust_1', undefined, input.clock.now())).available).toBe(100);
  });

  it('finalizes elapsed cancellation without a billing key and retries version conflicts', async () => {
    const input = await setup();
    const sub = await input.repo.subscriptions.get('sub_1');
    if (!sub) throw new Error('fixture missing');
    await input.repo.subscriptions.put({ ...sub, cancelAtPeriodEnd: true, billingKey: null });
    const put = vi.spyOn(input.repo.subscriptions, 'put');
    put.mockRejectedValueOnce(new PaymentKitError('concurrent write', 'subscription_version_conflict'));
    const get = vi.spyOn(input.repo.subscriptions, 'get');
    await scheduler.tick(input);
    expect(put).toHaveBeenCalledTimes(2);
    expect(get.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect((await input.repo.subscriptions.get('sub_1'))?.status).toBe('canceled');
    expect(input.provider.lastCharge).toBeNull();
  });

  it.each(['future', 'other_provider'] as const)('does not finalize %s cancellation', async (condition) => {
    const input = await setup();
    const sub = await input.repo.subscriptions.get('sub_1');
    if (!sub) throw new Error('fixture missing');
    await input.repo.subscriptions.put({ ...sub, cancelAtPeriodEnd: true,
      provider: condition === 'other_provider' ? 'stripe' : sub.provider,
      currentPeriod: condition === 'future' ? { start: sub.currentPeriod.start, end: new Date('2024-03-01T00:00:00.000Z') } : sub.currentPeriod });
    await scheduler.tick(input);
    expect((await input.repo.subscriptions.get('sub_1'))?.status).toBe('active');
    expect(input.provider.lastCharge).toBeNull();
  });

});
