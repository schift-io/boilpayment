// spec: packages/lifecycle/spec/lifecycle.pseudo.md — EC:A59 A60 A61 A62 (round-8 A8-2 A8-3 A8-4 A8-5 A8-8)
import { describe, expect, it } from 'vitest';
import { FixedClock, InMemoryLedger, InMemoryRepo, Money, Payment, Plan, SequentialIdGen, Subscription, resolvePolicy } from 'boilpayment-core';
import { startSubscription, upgrade } from '../src/index.js';
import { FakeSelfSchedulingProvider } from './helpers.js';

const basic: Plan = { id: 'basic', name: 'Basic', interval: 'month', creditsPerPeriod: 1000, usageIncluded: 0, trialDays: 0, prices: [{ currency: 'KRW', amountMinor: 9900 }] };
const pro: Plan = { id: 'pro', name: 'Pro', interval: 'month', creditsPerPeriod: 3000, usageIncluded: 0, trialDays: 0, prices: [{ currency: 'KRW', amountMinor: 19900 }] };
const max: Plan = { id: 'max', name: 'Max', interval: 'month', creditsPerPeriod: 8000, usageIncluded: 0, trialDays: 0, prices: [{ currency: 'KRW', amountMinor: 29900 }] };

/** Records every charge (with the customer key) and can hold a charge open until released. */
class GatedProvider extends FakeSelfSchedulingProvider {
  readonly charges: Array<{ amountMinor: number; customerRef: string; orderId: string }> = [];
  gate: Promise<void> | null = null;
  override async chargeBillingKey(input: { billingKey: string; amount: Money; orderId: string; customerRef: string; idempotencyKey: string }): Promise<Payment> {
    this.charges.push({ amountMinor: input.amount.amountMinor, customerRef: input.customerRef, orderId: input.orderId });
    if (this.gate) await this.gate;
    return super.chargeBillingKey(input);
  }
}

async function setup(status: Subscription['status'] = 'active', extra: Partial<Subscription> = {}) {
  const clock = new FixedClock(new Date('2026-04-11T00:00:00.000Z'));
  const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
  const repo = new InMemoryRepo();
  const ids = new SequentialIdGen('id_');
  for (const p of [basic, pro, max]) await repo.plans.put(p);
  const sub: Subscription = {
    id: 's1', customerId: 'c1', planId: 'basic', provider: 'toss', providerRef: null, status,
    currentPeriod: { start: new Date('2026-04-01T00:00:00.000Z'), end: new Date('2026-05-01T00:00:00.000Z') },
    anchorDay: 1, cancelAtPeriodEnd: false, graceUntil: null, billingKey: 'bk1', scheduledPlanId: null, currency: 'KRW',
    version: 0, createdAt: new Date('2026-04-01T00:00:00.000Z'), ...extra,
  };
  await repo.subscriptions.put(sub);
  const stored = (await repo.subscriptions.get('s1')) as Subscription;
  const provider = new GatedProvider();
  const policy = resolvePolicy({ upgrade: { mode: 'immediate_prorate_keep_anchor' } });
  return { clock, ledger, repo, ids, sub: stored, provider, policy };
}

describe('[EC:A61] upgrades of one subscription run one at a time, against the stored row', () => {
  it('pro and max at once: one charges, the other is refused before any charge; its retry with the old snapshot is refused too', async () => {
    const { clock, ledger, repo, ids, sub, provider, policy } = await setup();
    let release!: () => void;
    provider.gate = new Promise((r) => { release = r; });
    const first = upgrade({ sub, newPlan: pro, policy, provider, ledger, repo, clock, ids });
    await new Promise((r) => setTimeout(r, 10));
    const second = await upgrade({ sub, newPlan: max, policy, provider, ledger, repo, clock, ids }).then(() => 'ok', (e) => e.code);
    release();
    await first;
    expect(second).toBe('subscription_change_in_flight');
    const retry = await upgrade({ sub, newPlan: max, policy, provider, ledger, repo, clock, ids }).then(() => 'ok', (e) => e.code);
    expect(retry).toBe('subscription_changed');
    expect(provider.charges.length).toBe(1);
    // Read again: pro -> max charges the pro -> max difference only.
    const fresh = (await repo.subscriptions.get('s1')) as Subscription;
    await upgrade({ sub: fresh, newPlan: max, policy, provider, ledger, repo, clock, ids });
    expect(provider.charges.map((c) => c.amountMinor)).toEqual([6666, 6666]);
    expect((await repo.subscriptions.get('s1'))?.planId).toBe('max');
  });

  it.each(['canceled', 'expired', 'past_due', 'paused', 'incomplete'] as const)('a %s subscription is refused with subscription_inactive and nothing is charged', async (status) => {
    const { clock, ledger, repo, ids, sub, provider, policy } = await setup(status);
    await expect(upgrade({ sub, newPlan: pro, policy, provider, ledger, repo, clock, ids })).rejects.toMatchObject({ code: 'subscription_inactive' });
    expect(provider.charges).toEqual([]);
    expect((await repo.subscriptions.get('s1'))?.planId).toBe('basic');
  });
});

describe('[EC:A59] a self-scheduled reset_anchor upgrade buys the whole new period', () => {
  it('basic -> pro on day 11 of 30: 19900 - ceil(9900*20/30) = 13300, credits 3000 - floor(1000*20/30) = 2334', async () => {
    const { clock, ledger, repo, ids, sub, provider } = await setup();
    const res = await upgrade({ sub, newPlan: pro, policy: resolvePolicy(), provider, ledger, repo, clock, ids });
    expect(provider.charges.map((c) => c.amountMinor)).toEqual([13300]);
    expect(res.creditDelta).toBe(2334);
    expect(res.sub.currentPeriod).toEqual({ start: new Date('2026-04-11T00:00:00.000Z'), end: new Date('2026-05-11T00:00:00.000Z') });
  });
});

describe('[EC:A60] billing-key charges send the customer key the key was issued under', () => {
  it('the subscription\'s billingCustomerRef, else the customer\'s provider ref, else the local id', async () => {
    const a = await setup('active', { billingCustomerRef: 'toss_cust_1' });
    await upgrade({ sub: a.sub, newPlan: pro, policy: a.policy, provider: a.provider, ledger: a.ledger, repo: a.repo, clock: a.clock, ids: a.ids });
    expect(a.provider.charges[0]?.customerRef).toBe('toss_cust_1');

    const b = await setup();
    await b.repo.customers.put({ id: 'c1', email: null, providerRefs: [{ provider: 'toss', ref: 'cus_abc' }], status: 'active', createdAt: new Date() });
    await upgrade({ sub: b.sub, newPlan: pro, policy: b.policy, provider: b.provider, ledger: b.ledger, repo: b.repo, clock: b.clock, ids: b.ids });
    expect(b.provider.charges[0]?.customerRef).toBe('cus_abc');

    const c = await setup();
    await upgrade({ sub: c.sub, newPlan: pro, policy: c.policy, provider: c.provider, ledger: c.ledger, repo: c.repo, clock: c.clock, ids: c.ids });
    expect(c.provider.charges[0]?.customerRef).toBe('c1');
  });
});

describe('[EC:A62] the upgrade charge has a local payment row', () => {
  it('written before the charge, succeeded after, and the upgrade grant points at it', async () => {
    const { clock, ledger, repo, ids, sub, provider, policy } = await setup();
    const res = await upgrade({ sub, newPlan: pro, policy, provider, ledger, repo, clock, ids });
    const rows = await repo.payments.list({ subscriptionId: 's1' } as never);
    expect(rows.map((r) => [r.kind, r.status, r.amount.amountMinor, r.period])).toEqual([['subscription', 'succeeded', 6666, null]]);
    expect(res.grant?.reference.paymentId).toBe(rows[0]!.id);
  });
});

describe('[EC:A65] startSubscription starts a self-scheduled subscription from a billing key', () => {
  async function base() {
    const clock = new FixedClock(new Date('2026-04-11T03:00:00.000Z'));
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const repo = new InMemoryRepo();
    await repo.plans.put(basic);
    return { clock, ledger, repo, provider: new GatedProvider(), policy: resolvePolicy() };
  }

  it('charges the first period once, activates, grants its credits; the same requestId never charges again', async () => {
    const { clock, ledger, repo, provider, policy } = await base();
    const input = { customerId: 'u1', planId: 'basic', currency: 'KRW', billingKey: 'bk1', customerRef: 'toss_cust_1', requestId: 'signup-1', provider, policy, ledger, repo, clock };
    const first = await startSubscription(input);
    const again = await startSubscription(input);
    expect(first.sub.status).toBe('active');
    expect(again.sub.id).toBe(first.sub.id);
    expect(provider.charges).toEqual([{ amountMinor: 9900, customerRef: 'toss_cust_1', orderId: expect.stringMatching(/^ord_[0-9a-f]{40}$/) }]);
    expect((await ledger.balance('u1', 'paid', clock.now())).available).toBe(1000);
    expect((await repo.customers.get('u1'))?.providerRefs).toEqual([{ provider: 'toss', ref: 'toss_cust_1' }]);
    expect(first.sub.currentPeriod).toEqual({ start: clock.now(), end: new Date('2026-05-11T03:00:00.000Z') });
  });

  it('a declined first charge closes the subscription (expired, EC:A72) and throws subscription_start_declined', async () => {
    const { clock, ledger, repo, provider, policy } = await base();
    provider.nextChargeHttpError = 402;
    const input = { customerId: 'u1', planId: 'basic', currency: 'KRW', billingKey: 'bk1', requestId: 'signup-2', provider, policy, ledger, repo, clock };
    await expect(startSubscription(input)).rejects.toMatchObject({ code: 'subscription_start_declined' });
    const [sub] = await repo.subscriptions.list();
    expect(sub?.status).toBe('expired');
    expect((await ledger.balance('u1', 'paid', clock.now())).available).toBe(0);
  });

  it('a frozen customer does not start a subscription', async () => {
    const { clock, ledger, repo, provider, policy } = await base();
    await repo.customers.put({ id: 'u1', email: null, providerRefs: [], status: 'frozen', createdAt: clock.now() });
    await expect(startSubscription({ customerId: 'u1', planId: 'basic', currency: 'KRW', billingKey: 'bk1', requestId: 'r', provider, policy, ledger, repo, clock }))
      .rejects.toMatchObject({ code: 'customer_frozen' });
    expect(provider.charges).toEqual([]);
  });
});

describe('[EC:A64 A60] backfill: a billing key belongs to one customer, and its customer key is kept', () => {
  it('the second customer with the same billing key is refused; the first keeps customer_ref as billingCustomerRef', async () => {
    const { backfill } = await import('../src/index.js');
    const repo = new InMemoryRepo();
    await repo.plans.put(basic);
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const toss = new FakeSelfSchedulingProvider();
    const mk = (customerId: string) => ({ customerId, email: null, provider: 'toss' as const, customerRef: 'toss_cust_1', subscriptionRef: null, planId: 'basic',
      billingKey: 'bk1', periodStart: new Date('2026-03-05T00:00:00Z'), periodEnd: new Date('2026-04-05T00:00:00Z'), credits: null, creditsExpireAt: null, currency: 'KRW' });
    const report = await backfill({ repo, ledger, providers: { toss }, clock: new FixedClock(new Date('2026-03-10T00:00:00Z')), ids: new SequentialIdGen('s_'), rows: [mk('user_1'), mk('user_2')] });
    expect(report.results.map((r) => [r.status, r.reason])).toEqual([['ok', null], ['error', 'billing_key_owned_by_other_customer']]);
    const [sub] = await repo.subscriptions.list({ customerId: 'user_1' } as never);
    expect(sub?.billingCustomerRef).toBe('toss_cust_1');
  });
});

describe('[EC:A66] a banned customer\'s renewal payment buys nothing', () => {
  it('onRenewalPaid refuses with customer_banned and grants nothing', async () => {
    const { onRenewalPaid } = await import('../src/index.js');
    const { clock, ledger, repo, sub } = await setup('canceled');
    await repo.customers.put({ id: 'c1', email: null, providerRefs: [], status: 'banned', createdAt: clock.now() });
    const payment = { id: 'p1', customerId: 'c1', provider: 'toss' as const, providerRef: 'pk', subscriptionId: 's1', amount: { amountMinor: 9900, currency: 'KRW' },
      status: 'succeeded' as const, kind: 'subscription' as const, period: { start: new Date('2026-05-01T00:00:00Z'), end: new Date('2026-06-01T00:00:00Z') },
      occurredAt: clock.now(), failure: null, cashReceipt: null };
    await expect(onRenewalPaid({ sub, payment, policy: resolvePolicy(), ledger, repo, clock })).rejects.toMatchObject({ code: 'customer_banned' });
    expect((await ledger.balance('c1', 'paid', clock.now())).available).toBe(0);
  });
});
