// spec: packages/lifecycle/spec/lifecycle.pseudo.md [EC:A7] [EC:A15] [EC:A17] [EC:B12]
import { describe, expect, it } from 'vitest';
import { FixedClock, InMemoryLedger, InMemoryRepo, Plan, Payment, Subscription, SequentialIdGen, resolvePolicy } from 'boilpayment-core';
import { onRenewalPaid } from '../src/index.js';

const plan: Plan = { id: 'plan_a', name: 'Plan A', interval: 'month', creditsPerPeriod: 100, usageIncluded: 0, trialDays: 0, prices: [{ currency: 'USD', amountMinor: 1000 }] };
const period = { start: new Date('2024-01-01T00:00:00.000Z'), end: new Date('2024-02-01T00:00:00.000Z') };

function mkSub(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 'sub_1', customerId: 'cust_1', planId: plan.id, provider: 'stripe', providerRef: 'stripe_sub_1',
    status: 'active', currentPeriod: period, anchorDay: 1, cancelAtPeriodEnd: false, graceUntil: null,
    billingKey: null, scheduledPlanId: null, createdAt: period.start,
    ...overrides,
  };
}
function mkPayment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: 'pay_1', customerId: 'cust_1', provider: 'stripe', providerRef: 'pi_1', subscriptionId: 'sub_1',
    amount: { amountMinor: 1000, currency: 'USD' }, status: 'succeeded', kind: 'subscription', period: null,
    occurredAt: period.start, failure: null,
    ...overrides,
  };
}

async function setup() {
  const clock = new FixedClock(period.start);
  const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
  const repo = new InMemoryRepo();
  await repo.plans.put(plan);
  return { clock, ledger, repo };
}

describe('EC:A7 B12 onRenewalPaid — same-period reactivation must not regrant', () => {
  it('a second call for the same period returns duplicated=true and does not double-grant', async () => {
    const { clock, ledger, repo } = await setup();
    const sub = mkSub();
    await repo.subscriptions.put(sub);
    const policy = resolvePolicy();

    const first = await onRenewalPaid({ sub, payment: mkPayment(), policy, ledger, repo, clock });
    expect(first.duplicated).toBe(false);
    expect(first.grant.entry?.amount).toBe(100);

    const second = await onRenewalPaid({ sub: first.sub, payment: mkPayment({ id: 'pay_2', providerRef: 'pi_2' }), policy, ledger, repo, clock });
    expect(second.duplicated).toBe(true);
    expect(second.grant.duplicated).toBe(true);
    expect(second.grant.entry?.id).toBe(first.grant.entry?.id);

    const bal = await ledger.balance('cust_1', undefined, clock.now());
    expect(bal.available).toBe(100); // only granted once
  });

  it('[SB-08] provider-active recovery ends the linked prior-period grace extension', async () => {
    const { clock, ledger, repo } = await setup();
    const recoveryPlan: Plan = { ...plan, creditsPerPeriod: 1000 };
    await repo.plans.put(recoveryPlan);
    const nextPeriod = { start: period.end, end: new Date('2024-03-01T00:00:00.000Z') };
    const recoveredAt = new Date('2024-02-04T00:00:00.000Z');
    clock.advance(recoveredAt.getTime() - period.start.getTime());
    const previous = (await ledger.append({
      customerId: 'cust_1', pool: 'paid', kind: 'grant', amount: 1000, unitPriceMinor: 1,
      currency: 'USD', expiresAt: period.end, source: 'subscription',
      reference: { subscriptionId: 'sub_1', periodStart: period.start, paymentId: 'pay_previous' },
      idempotencyKey: `grant:sub_1:${period.start.toISOString()}`, actor: 'system', reason: null,
    })).entry;
    await ledger.consume({
      customerId: 'cust_1', poolOrder: ['paid'], amount: 101, idempotencyKey: 'consume:previous',
      meta: {}, now: period.start, negativeBalance: 'block', negativeFloor: 0,
    });
    await ledger.append({
      customerId: 'cust_1', pool: 'paid', kind: 'adjust', amount: 0, unitPriceMinor: null,
      currency: 'USD', expiresAt: new Date('2024-02-08T00:00:00.000Z'), source: 'subscription',
      reference: { subscriptionId: 'sub_1', periodStart: period.start, grantId: previous.id },
      idempotencyKey: `adjust:grace-expiry:sub_1:${previous.id}:2024-02-08T00:00:00.000Z`,
      actor: 'system', reason: 'SB-07 grace_expiry_extension',
    });
    const providerAdvanced = mkSub({ status: 'active', currentPeriod: nextPeriod, graceUntil: null });
    await repo.subscriptions.put(providerAdvanced);

    const result = await onRenewalPaid({
      sub: providerAdvanced,
      payment: mkPayment({ id: 'pay_recovery', providerRef: 'pi_recovery', period: nextPeriod, occurredAt: recoveredAt }),
      policy: resolvePolicy(), ledger, repo, clock,
    });

    const grants = await ledger.entries('cust_1', { kind: 'grant', source: 'subscription' });
    expect(grants.map((entry) => entry.amount)).toEqual([1000, 1000]);
    expect(result.sub.status).toBe('active');
    expect((await ledger.balance('cust_1', undefined, recoveredAt)).available).toBe(1000);
  });

  it('[SB-08] an existing-grant replay still closes the linked grace extension', async () => {
    const { clock, ledger, repo } = await setup();
    const nextPeriod = { start: period.end, end: new Date('2024-03-01T00:00:00.000Z') };
    const recoveredAt = new Date('2024-02-04T00:00:00.000Z');
    clock.advance(recoveredAt.getTime() - period.start.getTime());
    const previous = (await ledger.append({
      customerId: 'cust_1', pool: 'paid', kind: 'grant', amount: 100, unitPriceMinor: 10,
      currency: 'USD', expiresAt: period.end, source: 'subscription',
      reference: { subscriptionId: 'sub_1', periodStart: period.start, paymentId: 'pay_previous' },
      idempotencyKey: `grant:sub_1:${period.start.toISOString()}`, actor: 'system', reason: null,
    })).entry;
    await ledger.append({
      customerId: 'cust_1', pool: 'paid', kind: 'adjust', amount: 0, unitPriceMinor: null,
      currency: 'USD', expiresAt: new Date('2024-02-08T00:00:00.000Z'), source: 'subscription',
      reference: { subscriptionId: 'sub_1', periodStart: period.start, grantId: previous.id },
      idempotencyKey: `adjust:grace-expiry:sub_1:${previous.id}`, actor: 'system', reason: 'SB-07 grace_expiry_extension',
    });
    await ledger.append({
      customerId: 'cust_1', pool: 'paid', kind: 'grant', amount: 100, unitPriceMinor: 10,
      currency: 'USD', expiresAt: nextPeriod.end, source: 'subscription',
      reference: { subscriptionId: 'sub_1', periodStart: nextPeriod.start, paymentId: 'pay_recovery' },
      idempotencyKey: `grant:sub_1:${nextPeriod.start.toISOString()}`, actor: 'system', reason: null,
    });
    const providerAdvanced = mkSub({ status: 'active', currentPeriod: nextPeriod, graceUntil: null });
    await repo.subscriptions.put(providerAdvanced);

    const result = await onRenewalPaid({
      sub: providerAdvanced,
      payment: mkPayment({ id: 'pay_recovery', providerRef: 'pi_recovery', period: nextPeriod, occurredAt: recoveredAt }),
      policy: resolvePolicy(), ledger, repo, clock,
    });

    expect(result.duplicated).toBe(true);
    expect((await ledger.balance('cust_1', undefined, recoveredAt)).available).toBe(100);
    expect((await ledger.entries('cust_1')).filter((entry) => entry.reason === 'SB-08 grace_expiry_end')).toHaveLength(1);
  });

  it('[SB-08] a late grace extension cannot revive credits after recovery', async () => {
    const { clock, ledger, repo } = await setup();
    const nextPeriod = { start: period.end, end: new Date('2024-03-01T00:00:00.000Z') };
    const recoveredAt = new Date('2024-02-04T00:00:00.000Z');
    clock.advance(recoveredAt.getTime() - period.start.getTime());
    const previous = (await ledger.append({
      customerId: 'cust_1', pool: 'paid', kind: 'grant', amount: 100, unitPriceMinor: 10,
      currency: 'USD', expiresAt: period.end, source: 'subscription',
      reference: { subscriptionId: 'sub_1', periodStart: period.start, paymentId: 'pay_previous' },
      idempotencyKey: `grant:sub_1:${period.start.toISOString()}`, actor: 'system', reason: null,
    })).entry;
    const providerAdvanced = mkSub({ status: 'active', currentPeriod: nextPeriod, graceUntil: null });
    await repo.subscriptions.put(providerAdvanced);

    await onRenewalPaid({
      sub: providerAdvanced,
      payment: mkPayment({ id: 'pay_recovery', providerRef: 'pi_recovery', period: nextPeriod, occurredAt: recoveredAt }),
      policy: resolvePolicy(), ledger, repo, clock,
    });
    await ledger.append({
      customerId: 'cust_1', pool: 'paid', kind: 'adjust', amount: 0, unitPriceMinor: null,
      currency: 'USD', expiresAt: new Date('2024-02-08T00:00:00.000Z'), source: 'subscription',
      reference: { subscriptionId: 'sub_1', periodStart: period.start, grantId: previous.id },
      idempotencyKey: `adjust:grace-expiry:sub_1:${previous.id}`, actor: 'system', reason: 'SB-07 grace_expiry_extension',
    });

    expect((await ledger.entries('cust_1')).filter((entry) => entry.reason === 'SB-08 grace_expiry_end')).toHaveLength(1);
    expect((await ledger.balance('cust_1', undefined, recoveredAt)).available).toBe(100);
  });

  it('EC:A17 recovered=true when the subscription was past_due before this call', async () => {
    const { clock, ledger, repo } = await setup();
    const sub = mkSub({ status: 'past_due', graceUntil: new Date('2024-01-08T00:00:00.000Z') });
    await repo.subscriptions.put(sub);
    const policy = resolvePolicy();

    const res = await onRenewalPaid({ sub, payment: mkPayment(), policy, ledger, repo, clock });
    expect(res.recovered).toBe(true);
    expect(res.sub.status).toBe('active');
    expect(res.sub.graceUntil).toBeNull();
  });

  it('recovered=false on a normal (already active) renewal', async () => {
    const { clock, ledger, repo } = await setup();
    const sub = mkSub();
    await repo.subscriptions.put(sub);
    const policy = resolvePolicy();

    const res = await onRenewalPaid({ sub, payment: mkPayment(), policy, ledger, repo, clock });
    expect(res.recovered).toBe(false);
  });

  it('EC:A15 forces active status internally so grantForPeriod does not defer for a stale past_due', async () => {
    const { clock, ledger, repo } = await setup();
    // sub is past_due AND policy defers grants during grace — onRenewalPaid must still grant,
    // because the payment already succeeded (that's why we're here).
    const sub = mkSub({ status: 'past_due' });
    await repo.subscriptions.put(sub);
    const policy = resolvePolicy(); // default grantDuringGrace='defer_until_paid'

    const res = await onRenewalPaid({ sub, payment: mkPayment(), policy, ledger, repo, clock });
    expect(res.grant.deferred).toBe(false);
    expect(res.grant.entry?.amount).toBe(100);
  });
});

describe('EC:A25 onRenewalPaid — only a succeeded payment grants or advances the period', () => {
  for (const status of ['pending', 'failed', 'requires_action'] as const) {
    it(`a ${status} payment is refused with no ledger write and no period change`, async () => {
      const { clock, ledger, repo } = await setup();
      const sub = mkSub();
      await repo.subscriptions.put(sub);
      const next = { start: period.end, end: new Date('2024-03-01T00:00:00.000Z') };
      await expect(
        onRenewalPaid({ sub, payment: mkPayment({ status, period: next }), policy: resolvePolicy(), ledger, repo, clock }),
      ).rejects.toMatchObject({ code: 'renewal_payment_not_succeeded' });
      expect(await ledger.entries('cust_1')).toHaveLength(0);
      expect((await repo.subscriptions.get('sub_1'))!.currentPeriod.end).toEqual(period.end);
    });
  }

  it('the same period grants once the payment is presented as succeeded', async () => {
    const { clock, ledger, repo } = await setup();
    const sub = mkSub();
    await repo.subscriptions.put(sub);
    const policy = resolvePolicy();
    await expect(onRenewalPaid({ sub, payment: mkPayment({ status: 'pending' }), policy, ledger, repo, clock })).rejects.toThrow();
    const ok = await onRenewalPaid({ sub, payment: mkPayment(), policy, ledger, repo, clock });
    expect(ok.grant.entry?.amount).toBe(100);
  });
});

describe('[SB-10] terminal native subscriptions reject late successful renewals', () => {
  it.each(['stripe', 'polar'] as const)('%s canceled/expired subscription is not granted or revived', async (provider) => {
    for (const status of ['canceled', 'expired'] as const) {
      const { clock, ledger, repo } = await setup();
      const sub = mkSub({ provider, providerRef: `${provider}_sub_1`, status });
      await repo.subscriptions.put(sub);

      await expect(onRenewalPaid({
        sub,
        payment: mkPayment({ provider, providerRef: `${provider}_late_payment` }),
        policy: resolvePolicy(), ledger, repo, clock,
      })).rejects.toMatchObject({ code: 'subscription_terminal_payment' });

      expect(await ledger.entries(sub.customerId)).toHaveLength(0);
      expect((await repo.subscriptions.get(sub.id))?.status).toBe(status);
    }
  });
});
