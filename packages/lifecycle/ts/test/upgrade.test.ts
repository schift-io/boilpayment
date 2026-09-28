// spec: packages/lifecycle/spec/lifecycle.pseudo.md [EC:A1] [EC:A2] [EC:F]
import { describe, expect, it } from 'vitest';
import { CollectingNotifier, FixedClock, InMemoryLedger, InMemoryRepo, Payment, Plan, Subscription, SequentialIdGen, resolvePolicy } from 'boilpayment-core';
import { dunning, onRenewalPaid, upgrade, upgradeAnchorIntentKey } from '../src/index.js';
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
  it('[SB-11] Stripe grants the full credit difference immediately and the reset-anchor invoice does not grant the new plan again', async () => {
    const { clock, ledger, repo, ids } = await setup();
    const sub = mkSub();
    await repo.subscriptions.put(sub);
    await ledger.append({
      customerId: sub.customerId, pool: 'paid', kind: 'grant', amount: planA.creditsPerPeriod,
      unitPriceMinor: null, currency: null, expiresAt: sub.currentPeriod.end, source: 'subscription',
      reference: { subscriptionId: sub.id, periodStart: sub.currentPeriod.start },
      idempotencyKey: `grant:${sub.id}:${sub.currentPeriod.start.toISOString()}`, actor: 'system', reason: 'initial period',
    });
    const resetPeriod = { start: clock.now(), end: new Date('2024-02-16T00:00:00.000Z') };
    const provider = new FakeNativeProvider();
    provider.setDummySub({ ...sub, planId: planB.id, anchorDay: 16, currentPeriod: resetPeriod });

    const upgraded = await upgrade({ sub, newPlan: planB, policy: resolvePolicy(), provider, ledger, repo, clock, ids });

    expect(upgraded.creditDelta).toBe(200);
    expect(upgraded.sub.currentPeriod).toEqual(resetPeriod);
    expect(upgraded.sub.anchorDay).toBe(16);
    expect((await ledger.balance(sub.customerId, 'paid', clock.now())).available).toBe(300);

    const anchorInvoice: Payment = {
      id: 'pay_upgrade_anchor', customerId: sub.customerId, provider: 'stripe', providerRef: 'in_upgrade_anchor',
      subscriptionId: sub.id, amount: { amountMinor: 2000, currency: 'USD' }, status: 'succeeded',
      kind: 'subscription', period: resetPeriod, occurredAt: clock.now(), failure: null,
    };
    await onRenewalPaid({ sub: upgraded.sub, payment: anchorInvoice, policy: resolvePolicy(), ledger, repo, clock });

    expect((await ledger.balance(sub.customerId, 'paid', clock.now())).available).toBe(300);
    const attribution = (await ledger.entries(sub.customerId)).find((entry) => entry.reason === 'SB-11 upgrade_invoice_attribution');
    expect(attribution?.reference.paymentId).toBe(anchorInvoice.id);
    expect(attribution?.reference.grantId).toBe(upgraded.grant?.id);
    expect((await repo.operations.list({ kind: 'lifecycle.upgrade_anchor' })).map((op) => op.status)).toEqual(['done']);
  });

  it('[SB-11] Stripe reset-anchor invoice does not grant the full new plan after the immediate delta was granted', async () => {
    const { clock, ledger, repo } = await setup();
    const resetPeriod = { start: clock.now(), end: new Date('2024-02-16T00:00:00.000Z') };
    const sub = mkSub({ planId: planB.id, anchorDay: 16, currentPeriod: resetPeriod, version: 0 });
    await repo.subscriptions.put(sub);
    await ledger.append({
      customerId: sub.customerId, pool: 'paid', kind: 'grant', amount: 100,
      unitPriceMinor: null, currency: null, expiresAt: resetPeriod.end, source: 'subscription',
      reference: { subscriptionId: sub.id }, idempotencyKey: 'seed:old-plan', actor: 'system', reason: 'old plan',
    });
    await ledger.append({
      customerId: sub.customerId, pool: 'paid', kind: 'grant', amount: 200,
      unitPriceMinor: null, currency: null, expiresAt: resetPeriod.end, source: 'subscription',
      reference: { subscriptionId: sub.id, periodStart: resetPeriod.start },
      idempotencyKey: `grant:${sub.id}:${resetPeriod.start.toISOString()}`, actor: 'system', reason: 'upgrade:plan_a->plan_b',
    });
    const anchorInvoice: Payment = {
      id: 'pay_upgrade_anchor', customerId: sub.customerId, provider: 'stripe', providerRef: 'in_upgrade_anchor',
      subscriptionId: sub.id, amount: { amountMinor: 2000, currency: 'USD' }, status: 'succeeded',
      kind: 'subscription', period: resetPeriod, occurredAt: clock.now(), failure: null,
    };

    await onRenewalPaid({ sub, payment: anchorInvoice, policy: resolvePolicy(), ledger, repo, clock });

    expect((await ledger.balance(sub.customerId, 'paid', clock.now())).available).toBe(300);
  });

  it("[SB-11] native immediate_prorate_reset_anchor keeps the provider's new period and grants the full credit difference", async () => {
    const { clock, ledger, repo, ids } = await setup();
    const sub = mkSub();
    await repo.subscriptions.put(sub);
    const provider = new FakeNativeProvider();
    provider.setDummySub({ ...sub, anchorDay: 16, currentPeriod: { start: new Date('2024-01-16T00:00:00.000Z'), end: new Date('2024-02-16T00:00:00.000Z') } });
    const policy = resolvePolicy(); // default: immediate_prorate_reset_anchor, full_delta

    const res = await upgrade({ sub, newPlan: planB, policy, provider, ledger, repo, clock, ids });
    expect(res.creditDelta).toBe(200);
    expect(res.sub.anchorDay).toBe(16);
    expect(res.sub.currentPeriod).toEqual({ start: new Date('2024-01-16T00:00:00.000Z'), end: new Date('2024-02-16T00:00:00.000Z') });
    expect(res.sub.planId).toBe(planB.id);
    expect(provider.changeSubscriptionCalled).toBe(1);
    const bal = await ledger.balance('cust_1', undefined, clock.now());
    expect(bal.available).toBe(200);
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

describe('failed provider-billed upgrades', () => {
  class PolarProvider extends FakeNativeProvider {
    override capabilities() { return { ...super.capabilities(), upgradeGrant: 'on_payment' as const }; }
  }

  it('[SB-13] Polar payment failure restores the old plan and fails the pending upgrade grant operation', async () => {
    const { clock, ledger, repo, ids } = await setup();
    const sub = mkSub({ provider: 'polar', providerRef: 'polar_sub_1', version: 0 });
    await repo.subscriptions.put(sub);
    const provider = new PolarProvider();
    provider.setDummySub(sub);
    const policy = resolvePolicy({ upgrade: { mode: 'immediate_prorate_keep_anchor' } });
    const upgraded = await upgrade({ sub, newPlan: planB, policy, provider, ledger, repo, clock, ids });
    const pendingKey = `upgrade-grant:${sub.id}:${sub.currentPeriod.start.toISOString()}`;
    expect((await repo.operations.get(pendingKey))?.status).toBe('in_progress');

    await dunning.onPaymentFailed({ sub: upgraded.sub, policy, ledger, repo, notifier: new CollectingNotifier(), clock });

    expect((await repo.subscriptions.get(sub.id))?.planId).toBe(planA.id);
    expect((await repo.operations.get(pendingKey))?.status).toBe('failed');
    expect((await ledger.balance(sub.customerId, 'paid', clock.now())).available).toBe(0);
  });

  it('[SB-11][SB-13] Polar keeps its billing date, delays the delta, and a later dunning event does not revert the paid upgrade', async () => {
    const { clock, ledger, repo, ids } = await setup();
    const sub = mkSub({ provider: 'polar', providerRef: 'polar_sub_1', version: 0 });
    await repo.subscriptions.put(sub);
    await ledger.append({
      customerId: sub.customerId, pool: 'paid', kind: 'grant', amount: planA.creditsPerPeriod,
      unitPriceMinor: null, currency: null, expiresAt: sub.currentPeriod.end, source: 'subscription',
      reference: { subscriptionId: sub.id, periodStart: sub.currentPeriod.start, paymentId: 'pay_initial' },
      idempotencyKey: `grant:${sub.id}:${sub.currentPeriod.start.toISOString()}`, actor: 'system', reason: 'initial period',
    });
    const provider = new PolarProvider();
    provider.setDummySub({ ...sub, planId: planB.id });

    const upgraded = await upgrade({ sub, newPlan: planB, policy: resolvePolicy(), provider, ledger, repo, clock, ids });

    expect(upgraded.sub.currentPeriod).toEqual(sub.currentPeriod);
    expect(upgraded.sub.anchorDay).toBe(sub.anchorDay);
    expect(upgraded.grant).toBeNull();
    expect((await ledger.balance(sub.customerId, 'paid', clock.now())).available).toBe(100);

    const paidOrder: Payment = {
      id: 'pay_polar_upgrade', customerId: sub.customerId, provider: 'polar', providerRef: 'order_upgrade',
      subscriptionId: sub.id, amount: { amountMinor: 2000, currency: 'USD' }, status: 'succeeded',
      kind: 'subscription', period: sub.currentPeriod, occurredAt: clock.now(), failure: null,
    };
    await onRenewalPaid({ sub: upgraded.sub, payment: paidOrder, policy: resolvePolicy(), ledger, repo, clock });

    expect((await ledger.balance(sub.customerId, 'paid', clock.now())).available).toBe(300);
    const paidSub = (await repo.subscriptions.get(sub.id))!;
    await dunning.onPaymentFailed({
      sub: paidSub, policy: resolvePolicy(), ledger, repo,
      notifier: new CollectingNotifier(), clock,
    });
    expect((await repo.subscriptions.get(sub.id))?.planId).toBe(planB.id);
    expect((await repo.operations.get(`upgrade-grant:${sub.id}:${sub.currentPeriod.start.toISOString()}`))?.status).toBe('done');
  });
});

describe('[SB-11] Stripe reset-anchor provider/webhook race', () => {
  it('grants only the delta with the invoice payment attribution when the webhook wins the race', async () => {
    const { clock, ledger, repo, ids } = await setup();
    const sub = mkSub({ version: 0 });
    await repo.subscriptions.put(sub);
    await ledger.append({
      customerId: sub.customerId, pool: 'paid', kind: 'grant', amount: planA.creditsPerPeriod,
      unitPriceMinor: null, currency: null, expiresAt: sub.currentPeriod.end, source: 'subscription',
      reference: { subscriptionId: sub.id, periodStart: sub.currentPeriod.start, paymentId: 'pay_initial' },
      idempotencyKey: `grant:${sub.id}:${sub.currentPeriod.start.toISOString()}`, actor: 'system', reason: 'initial period',
    });
    const resetPeriod = { start: clock.now(), end: new Date('2024-02-16T00:00:00.000Z') };
    const invoice: Payment = {
      id: 'pay_racing_anchor', customerId: sub.customerId, provider: 'stripe', providerRef: 'in_racing_anchor',
      subscriptionId: sub.id, amount: { amountMinor: 2000, currency: 'USD' }, status: 'succeeded',
      kind: 'subscription', period: resetPeriod, occurredAt: clock.now(), failure: null,
    };
    class RacingProvider extends FakeNativeProvider {
      override async changeSubscription(): Promise<Subscription> {
        await onRenewalPaid({ sub, payment: invoice, policy: resolvePolicy(), ledger, repo, clock });
        return { ...sub, planId: planB.id, anchorDay: 16, currentPeriod: resetPeriod };
      }
    }

    const upgraded = await upgrade({
      sub, newPlan: planB, policy: resolvePolicy(), provider: new RacingProvider(), ledger, repo, clock, ids,
    });

    expect(upgraded.creditDelta).toBe(200);
    expect(upgraded.grant?.reference.paymentId).toBe(invoice.id);
    expect((await ledger.balance(sub.customerId, 'paid', clock.now())).available).toBe(300);
    expect((await ledger.entries(sub.customerId, { kind: 'grant' }))).toHaveLength(2);
    expect((await repo.operations.list({ kind: 'lifecycle.upgrade_anchor' })).map((op) => op.status)).toEqual(['done']);
  });

  it('[SB-11] refuses a different target/delta when the source period already has an anchor intent', async () => {
    const { clock, ledger, repo, ids } = await setup();
    const sub = mkSub({ version: 0 });
    await repo.subscriptions.put(sub);
    const key = upgradeAnchorIntentKey(sub.id, sub.currentPeriod.start);
    await repo.operations.put({
      id: key, key, kind: 'lifecycle.upgrade_anchor', payloadHash: '', status: 'in_progress',
      result: {
        subId: sub.id, fromPlanId: planA.id, toPlanId: 'plan_c', delta: 400,
        sourcePeriodStart: sub.currentPeriod.start.toISOString(), sourcePeriodEnd: sub.currentPeriod.end.toISOString(),
      },
      error: null, createdAt: clock.now(), completedAt: null, attempts: 0,
    });
    const provider = new FakeNativeProvider();

    await expect(upgrade({
      sub, newPlan: planB, policy: resolvePolicy(), provider, ledger, repo, clock, ids,
    })).rejects.toMatchObject({ code: 'upgrade_payment_pending' });

    expect(provider.changeSubscriptionCalled).toBe(0);
    expect((await repo.operations.get(key))?.result).toMatchObject({ toPlanId: 'plan_c', delta: 400 });
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
