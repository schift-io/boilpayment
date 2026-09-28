// spec: packages/lifecycle/spec/lifecycle.pseudo.md — EC:A71 A72 (round-9 A9-4 A9-8 A9-9)
import { describe, expect, it } from 'vitest';
import { FixedClock, InMemoryLedger, InMemoryRepo, Payment, Plan, SequentialIdGen, Subscription, resolvePolicy } from 'boilpayment-core';
import { onRenewalPaid, reactivate, scheduler, startSubscription, upgrade } from '../src/index.js';
import { FakeNativeProvider, FakeSelfSchedulingProvider } from './helpers.js';

const basic: Plan = { id: 'basic', name: 'Basic', interval: 'month', creditsPerPeriod: 1000, usageIncluded: 0, trialDays: 0, prices: [{ currency: 'KRW', amountMinor: 9900 }] };
const pro: Plan = { id: 'pro', name: 'Pro', interval: 'month', creditsPerPeriod: 3000, usageIncluded: 0, trialDays: 0, prices: [{ currency: 'KRW', amountMinor: 19900 }] };
const seoul = resolvePolicy({ period: { timezone: 'Asia/Seoul' } });

async function base(at: string, policy = seoul) {
  const clock = new FixedClock(new Date(at));
  const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
  const repo = new InMemoryRepo();
  for (const p of [basic, pro]) await repo.plans.put(p);
  return { clock, ledger, repo, provider: new FakeSelfSchedulingProvider(), policy };
}
const input = (e: Awaited<ReturnType<typeof base>>, requestId: string, customerId = 'u1') => ({
  customerId, planId: 'basic', currency: 'KRW', billingKey: 'bk1', requestId, provider: e.provider, policy: e.policy, ledger: e.ledger, repo: e.repo, clock: e.clock,
});

describe('[EC:A71] the first period is one interval in the policy timezone', () => {
  it.each([
    ['2026-04-30T20:00:00.000Z', '2026-05-31T20:00:00.000Z', 1], // KST 5/1 05:00 -> KST 6/1 05:00
    ['2026-12-31T16:00:00.000Z', '2027-01-31T16:00:00.000Z', 1], // KST 1/1 01:00 -> KST 2/1 01:00
    ['2026-01-30T16:00:00.000Z', '2026-02-27T16:00:00.000Z', 31], // KST 1/31 -> KST 2/28 (clamped)
  ])('Asia/Seoul start at %s ends at %s (anchor %i)', async (at, end, anchor) => {
    const e = await base(at);
    const { sub } = await startSubscription(input(e, 'r1'));
    expect(sub.currentPeriod).toEqual({ start: new Date(at), end: new Date(end) });
    expect(sub.anchorDay).toBe(anchor);
  });

  it('UTC policy keeps the UTC day', async () => {
    const e = await base('2026-04-30T20:00:00.000Z', resolvePolicy());
    const { sub } = await startSubscription(input(e, 'r1'));
    expect(sub.currentPeriod.end).toEqual(new Date('2026-05-30T20:00:00.000Z'));
  });

  it('a reset_anchor upgrade at KST 5/1 05:00 starts a one-month period', async () => {
    const e = await base('2026-04-30T20:00:00.000Z');
    const sub: Subscription = {
      id: 's1', customerId: 'c1', planId: 'basic', provider: 'toss', providerRef: null, status: 'active',
      currentPeriod: { start: new Date('2026-04-14T15:00:00.000Z'), end: new Date('2026-05-14T15:00:00.000Z') },
      anchorDay: 15, cancelAtPeriodEnd: false, graceUntil: null, billingKey: 'bk1', scheduledPlanId: null, currency: 'KRW',
      version: 0, createdAt: new Date('2026-04-14T15:00:00.000Z'),
    };
    await e.repo.subscriptions.put(sub);
    const stored = (await e.repo.subscriptions.get('s1')) as Subscription;
    const res = await upgrade({ sub: stored, newPlan: pro, policy: seoul, provider: e.provider, ledger: e.ledger, repo: e.repo, clock: e.clock, ids: new SequentialIdGen('id_') });
    expect(res.sub.currentPeriod).toEqual({ start: new Date('2026-04-30T20:00:00.000Z'), end: new Date('2026-05-31T20:00:00.000Z') });
  });
});

describe('[EC:A72] startSubscription honors multiplePerCustomer and never hides a paid subscription', () => {
  it('deny: a second sign-up with another requestId is refused before any charge', async () => {
    const e = await base('2026-04-11T03:00:00.000Z');
    await startSubscription(input(e, 'a'));
    await expect(startSubscription(input(e, 'b'))).rejects.toMatchObject({ code: 'subscription_exists' });
    expect((await e.repo.subscriptions.list()).length).toBe(1);
  });

  it('deny: two sign-ups at once leave at most one subscription', async () => {
    const e = await base('2026-04-11T03:00:00.000Z');
    const results = await Promise.allSettled([startSubscription(input(e, 'x')), startSubscription(input(e, 'y'))]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    expect((await e.repo.subscriptions.list()).length).toBe(1);
  });

  it('allow_separate_pools: a second sign-up is allowed', async () => {
    const e = await base('2026-04-11T03:00:00.000Z', resolvePolicy({ subscription: { multiplePerCustomer: 'allow_separate_pools' } }));
    await startSubscription(input(e, 'a'));
    await startSubscription(input(e, 'b'));
    expect((await e.repo.subscriptions.list()).filter((s) => s.status === 'active').length).toBe(2);
  });

  it('a declined sign-up is closed (expired); its requestId stays declined; the next sign-up is allowed', async () => {
    const e = await base('2026-04-11T03:00:00.000Z');
    e.provider.nextChargeHttpError = 402;
    await expect(startSubscription(input(e, 'd1'))).rejects.toMatchObject({ code: 'subscription_start_declined' });
    await expect(startSubscription(input(e, 'd1'))).rejects.toMatchObject({ code: 'subscription_start_declined' });
    e.provider.nextChargeHttpError = null;
    const ok = await startSubscription(input(e, 'd2'));
    expect(ok.sub.status).toBe('active');
    expect((await e.repo.subscriptions.list()).map((s) => s.status).sort()).toEqual(['active', 'expired']);
  });
});

describe('[EC:A73] a banned customer is never charged again', () => {
  async function banned(at = '2026-05-01T01:00:00.000Z') {
    const e = await base(at, resolvePolicy());
    await e.repo.customers.put({ id: 'c1', email: null, providerRefs: [], status: 'banned', createdAt: new Date('2026-01-01T00:00:00.000Z') });
    const sub: Subscription = {
      id: 's1', customerId: 'c1', planId: 'basic', provider: 'toss', providerRef: null, status: 'active',
      currentPeriod: { start: new Date('2026-04-01T00:00:00.000Z'), end: new Date('2026-05-01T00:00:00.000Z') },
      anchorDay: 1, cancelAtPeriodEnd: false, graceUntil: null, billingKey: 'bk1', scheduledPlanId: null, currency: 'KRW',
      version: 0, createdAt: new Date('2026-04-01T00:00:00.000Z'),
    };
    await e.repo.subscriptions.put(sub);
    return { ...e, sub: (await e.repo.subscriptions.get('s1')) as Subscription };
  }

  it('the scheduler does not charge a banned customer\'s due renewal', async () => {
    const e = await banned();
    const res = await scheduler.tick({ provider: e.provider, repo: e.repo, policy: e.policy, ledger: e.ledger, clock: e.clock, ids: new SequentialIdGen('id_') });
    expect(res.errors.map((x) => x.code)).toEqual(['customer_banned']);
    expect(e.provider.orderIds).toEqual([]);
    expect(await e.repo.payments.list()).toEqual([]);
  });

  it('reactivate is refused', async () => {
    const e = await banned('2026-04-20T00:00:00.000Z');
    const canceled = { ...e.sub, status: 'canceled' as const };
    await e.repo.subscriptions.put(canceled);
    const stored = (await e.repo.subscriptions.get('s1')) as Subscription;
    await expect(reactivate({ sub: stored, policy: e.policy, provider: e.provider, ledger: e.ledger, repo: e.repo, clock: e.clock }))
      .rejects.toMatchObject({ code: 'customer_banned' });
    expect((await e.repo.subscriptions.get('s1'))?.status).toBe('canceled');
  });
});

describe('[EC:A77] a provider that bills a plan change as a later order (Polar) grants the delta when that order is paid', () => {
  class OnPaymentProvider extends FakeNativeProvider {
    override capabilities() { return { ...super.capabilities(), upgradeGrant: 'on_payment' as const }; }
  }
  const pay = (id: string, amountMinor: number): Payment => ({
    id, customerId: 'c1', provider: 'stripe', providerRef: `ref_${id}`, subscriptionId: 's1', amount: { amountMinor, currency: 'KRW' },
    status: 'succeeded', kind: 'subscription', period: null, occurredAt: new Date('2026-04-11T00:00:00.000Z'), failure: null, cashReceipt: null,
  });

  it('no grant at upgrade; the change order grants the delta once; a redelivered cycle payment grants nothing', async () => {
    const e = await base('2026-04-11T00:00:00.000Z', resolvePolicy({ upgrade: { mode: 'immediate_prorate_keep_anchor' } }));
    const sub: Subscription = {
      id: 's1', customerId: 'c1', planId: 'basic', provider: 'stripe', providerRef: 'ps_1', status: 'active',
      currentPeriod: { start: new Date('2026-04-01T00:00:00.000Z'), end: new Date('2026-05-01T00:00:00.000Z') },
      anchorDay: 1, cancelAtPeriodEnd: false, graceUntil: null, billingKey: null, scheduledPlanId: null, currency: 'KRW',
      version: 0, createdAt: new Date('2026-04-01T00:00:00.000Z'),
    };
    await e.repo.subscriptions.put(sub);
    const cycle = pay('pay_cycle', 9900);
    await onRenewalPaid({ sub: (await e.repo.subscriptions.get('s1'))!, payment: cycle, policy: e.policy, ledger: e.ledger, repo: e.repo, clock: e.clock });
    const provider = new OnPaymentProvider();
    provider.setDummySub(sub);
    const res = await upgrade({ sub: (await e.repo.subscriptions.get('s1'))!, newPlan: pro, policy: e.policy, provider, ledger: e.ledger, repo: e.repo, clock: e.clock, ids: new SequentialIdGen('id_') });
    expect(res.grant).toBeNull();
    const balance = async () => (await e.ledger.balance('c1', 'paid', e.clock.now())).available;
    expect(await balance()).toBe(1000);
    // A redelivered cycle payment releases nothing.
    await onRenewalPaid({ sub: (await e.repo.subscriptions.get('s1'))!, payment: cycle, policy: e.policy, ledger: e.ledger, repo: e.repo, clock: e.clock });
    expect(await balance()).toBe(1000);
    // The plan-change order is paid: the delta (full_delta 2000) is granted, once.
    const change = pay('pay_change', 6666);
    await onRenewalPaid({ sub: (await e.repo.subscriptions.get('s1'))!, payment: change, policy: e.policy, ledger: e.ledger, repo: e.repo, clock: e.clock });
    await onRenewalPaid({ sub: (await e.repo.subscriptions.get('s1'))!, payment: change, policy: e.policy, ledger: e.ledger, repo: e.repo, clock: e.clock });
    expect(await balance()).toBe(3000);
  });

  it('[EC:A82] the change order paid before the change call returns still grants the delta once', async () => {
    const e = await base('2026-04-11T00:00:00.000Z', resolvePolicy({ upgrade: { mode: 'immediate_prorate_keep_anchor' } }));
    const sub: Subscription = {
      id: 's1', customerId: 'c1', planId: 'basic', provider: 'stripe', providerRef: 'ps_1', status: 'active',
      currentPeriod: { start: new Date('2026-04-01T00:00:00.000Z'), end: new Date('2026-05-01T00:00:00.000Z') },
      anchorDay: 1, cancelAtPeriodEnd: false, graceUntil: null, billingKey: null, scheduledPlanId: null, currency: 'KRW',
      version: 0, createdAt: new Date('2026-04-01T00:00:00.000Z'),
    };
    await e.repo.subscriptions.put(sub);
    await onRenewalPaid({ sub: (await e.repo.subscriptions.get('s1'))!, payment: pay('pay_cycle', 9900), policy: e.policy, ledger: e.ledger, repo: e.repo, clock: e.clock });
    class EarlyWebhookProvider extends OnPaymentProvider {
      override async changeSubscription(ref: string, opts: Parameters<FakeNativeProvider['changeSubscription']>[1]) {
        // The change order's paid webhook lands while the change call is still in flight.
        await onRenewalPaid({ sub: (await e.repo.subscriptions.get('s1'))!, payment: pay('pay_change', 6666), policy: e.policy, ledger: e.ledger, repo: e.repo, clock: e.clock });
        return super.changeSubscription(ref, opts);
      }
    }
    const provider = new EarlyWebhookProvider();
    provider.setDummySub(sub);
    await upgrade({ sub: (await e.repo.subscriptions.get('s1'))!, newPlan: pro, policy: e.policy, provider, ledger: e.ledger, repo: e.repo, clock: e.clock, ids: new SequentialIdGen('id_') });
    expect((await e.ledger.balance('c1', 'paid', e.clock.now())).available).toBe(3000);
  });

  it('[EC:A84] a retried upgrade never reopens a paid delta; a second change while one is unpaid is refused', async () => {
    const e = await base('2026-04-11T00:00:00.000Z', resolvePolicy({ upgrade: { mode: 'immediate_prorate_keep_anchor' } }));
    const max: Plan = { ...pro, id: 'max', creditsPerPeriod: 6000, prices: [{ currency: 'KRW', amountMinor: 29900 }] };
    await e.repo.plans.put(max);
    const sub: Subscription = {
      id: 's1', customerId: 'c1', planId: 'basic', provider: 'stripe', providerRef: 'ps_1', status: 'active',
      currentPeriod: { start: new Date('2026-04-01T00:00:00.000Z'), end: new Date('2026-05-01T00:00:00.000Z') },
      anchorDay: 1, cancelAtPeriodEnd: false, graceUntil: null, billingKey: null, scheduledPlanId: null, currency: 'KRW',
      version: 0, createdAt: new Date('2026-04-01T00:00:00.000Z'),
    };
    await e.repo.subscriptions.put(sub);
    const paid = async (p: Payment) => onRenewalPaid({ sub: (await e.repo.subscriptions.get('s1'))!, payment: p, policy: e.policy, ledger: e.ledger, repo: e.repo, clock: e.clock });
    await paid(pay('pay_cycle', 9900));
    const provider = new OnPaymentProvider();
    provider.setDummySub(sub);
    const up = async (plan: Plan, from: Subscription) => upgrade({ sub: from, newPlan: plan, policy: e.policy, provider, ledger: e.ledger, repo: e.repo, clock: e.clock, ids: new SequentialIdGen('id_') });
    // basic->pro waits for its order; pro->max in the same period is refused until it is paid.
    const afterPro = (await up(pro, (await e.repo.subscriptions.get('s1'))!)).sub;
    await expect(up(max, afterPro)).rejects.toMatchObject({ code: 'upgrade_payment_pending' });
    await paid(pay('pay_change', 6666));
    // The same upgrade retried (a lost response), then the order redelivered under a new id: granted once.
    await up(pro, sub).catch(() => null);
    await paid(pay('pay_change_again', 6666));
    expect((await e.ledger.balance('c1', 'paid', e.clock.now())).available).toBe(3000);
  });
});
