// spec: packages/lifecycle/spec/lifecycle.pseudo.md [EC:A13] [EC:A16] [EC:A17] [EC:A24]
import { describe, expect, it } from 'vitest';
import { CollectingNotifier, FixedClock, InMemoryLedger, InMemoryRepo, Plan, Payment, Repo, Subscription, SequentialIdGen, resolvePolicy } from 'boilpayment-core';
import { dunning } from '../src/index.js';
import { expireDue } from 'boilpayment-credits';
import { FakeNativeProvider, FakeSelfSchedulingProvider } from './helpers.js';

const plan: Plan = { id: 'plan_a', name: 'Plan A', interval: 'month', creditsPerPeriod: 100, usageIncluded: 0, trialDays: 0, prices: [{ currency: 'USD', amountMinor: 1000 }] };
const period = { start: new Date('2024-01-01T00:00:00.000Z'), end: new Date('2024-02-01T00:00:00.000Z') };

function mkSub(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 'sub_1', customerId: 'cust_1', planId: plan.id, provider: 'stripe', providerRef: 'stripe_sub_1',
    status: 'active', currentPeriod: period, anchorDay: 1, cancelAtPeriodEnd: false, graceUntil: null,
    billingKey: null, scheduledPlanId: null, version: 0, createdAt: period.start,
    ...overrides,
  };
}
function mkPayment(): Payment {
  return {
    id: 'pay_2', customerId: 'cust_1', provider: 'stripe', providerRef: 'pi_2', subscriptionId: 'sub_1',
    amount: { amountMinor: 1000, currency: 'USD' }, status: 'succeeded', kind: 'subscription', period: null,
    occurredAt: period.start, failure: null,
  };
}

// EC:A24 — resolvePolicy()'s generic array validator (core/ts/src/policy.ts validatePolicy) walks
// `dunning.retryIntervalHours` index-by-index against the DEFAULT_POLICY array's length (3) and
// rejects a SHORTER override as "missing" indices — even though a shorter list than retryAttempts
// is the documented, intentional shape (repeats its last value; see the Policy.dunning.retryIntervalHours
// doc comment in core/ts/src/types.ts and the referenced spec). That's a pre-existing core
// validator gap outside this package's remit (see final report — "contract change to report, not
// fixed"); this helper resolves a valid base policy and overrides the array field afterwards,
// bypassing validatePolicy for that one field so the (already-correct) runtime behavior can still
// be exercised here.
function dunningPolicy(retryAttempts: number, retryIntervalHours: number[]) {
  const base = resolvePolicy({ dunning: { retryAttempts } });
  return { ...base, dunning: { ...base.dunning, retryIntervalHours } };
}

describe('EC:A13 dunning.onPaymentFailed — starts grace period', () => {
  it('[SB-07] serializes grace extension against concurrent expireDue', async () => {
    class TrackingLedger extends InMemoryLedger {
      calls = 0;
      active = 0;
      maxActive = 0;
      override transaction<T>(customerId: string, fn: () => Promise<T>): Promise<T> {
        return super.transaction(customerId, async () => {
          this.calls += 1;
          this.active += 1;
          this.maxActive = Math.max(this.maxActive, this.active);
          await Promise.resolve();
          try { return await fn(); } finally { this.active -= 1; }
        });
      }
    }
    const clock = new FixedClock(period.end);
    const ledger = new TrackingLedger(new SequentialIdGen('led_'), clock);
    const repo = new InMemoryRepo();
    const notifier = new CollectingNotifier();
    const sub = mkSub();
    await repo.subscriptions.put(sub);
    await ledger.append({
      customerId: sub.customerId, pool: 'paid', kind: 'grant', amount: 100,
      unitPriceMinor: null, currency: null, expiresAt: period.end, source: 'subscription',
      reference: { subscriptionId: sub.id, periodStart: period.start },
      idempotencyKey: 'grant:concurrent', actor: 'system', reason: null,
    });

    await Promise.all([
      dunning.onPaymentFailed({ sub, policy: resolvePolicy(), ledger, repo, notifier, clock }),
      expireDue({ ledger, clock, customerId: sub.customerId }),
    ]);

    expect(ledger.calls).toBe(2);
    expect(ledger.maxActive).toBe(1);
    expect((await ledger.balance(sub.customerId, 'paid', clock.now())).available).toBe(100);
  });

  it('graceDays=7 (default): status=past_due, graceUntil=+7d, notifies payment.failed + grace.started', async () => {
    const clock = new FixedClock(new Date('2024-01-16T00:00:00.000Z'));
    const repo = new InMemoryRepo();
    const notifier = new CollectingNotifier();
    const sub = mkSub();
    await repo.subscriptions.put(sub);
    const policy = resolvePolicy();

    const res = await dunning.onPaymentFailed({ sub, policy, repo, notifier, clock });
    expect(res.sub.status).toBe('past_due');
    expect(res.sub.graceUntil).toEqual(new Date('2024-01-23T00:00:00.000Z'));
    expect(notifier.sent.map((n) => n.type)).toEqual(['payment.failed', 'grace.started']);
  });

  it('graceDays=0: graceUntil=now, no grace.started notification', async () => {
    const clock = new FixedClock(new Date('2024-01-16T00:00:00.000Z'));
    const repo = new InMemoryRepo();
    const notifier = new CollectingNotifier();
    const sub = mkSub();
    await repo.subscriptions.put(sub);
    const policy = resolvePolicy({ dunning: { graceDays: 0 } });

    const res = await dunning.onPaymentFailed({ sub, policy, repo, notifier, clock });
    expect(res.sub.graceUntil).toEqual(clock.now());
    expect(notifier.sent.map((n) => n.type)).toEqual(['payment.failed']);
  });

  it('[SB-07] extends the previous period grant through grace without duplicating it on redelivery', async () => {
    const clock = new FixedClock(period.end);
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'), clock);
    const repo = new InMemoryRepo();
    const notifier = new CollectingNotifier();
    const sub = mkSub();
    await repo.subscriptions.put(sub);
    const grant = (await ledger.append({
      customerId: sub.customerId, pool: 'paid', kind: 'grant', amount: 100,
      unitPriceMinor: 10, currency: 'USD', expiresAt: period.end, source: 'subscription',
      reference: { subscriptionId: sub.id, periodStart: period.start },
      idempotencyKey: `grant:${sub.id}:${period.start.toISOString()}`, actor: 'system', reason: null,
    })).entry;
    const policy = resolvePolicy();

    const first = await dunning.onPaymentFailed({ sub, policy, ledger, repo, notifier, clock });
    await dunning.onPaymentFailed({ sub: first.sub, policy, ledger, repo, notifier, clock });

    const grants = await ledger.entries(sub.customerId, { kind: 'grant' });
    expect(grants).toHaveLength(1);
    expect(grants.find((entry) => entry.id === grant.id)?.expiresAt).toEqual(period.end);
    const adjustments = (await ledger.entries(sub.customerId)).filter((entry) => entry.kind === 'adjust');
    expect(adjustments.filter((entry) => entry.reason === 'SB-07 paid_period_preserved')).toHaveLength(1);
    expect(adjustments.find((entry) => entry.reason === 'SB-07 grace_expiry_extension')).toMatchObject({
      amount: 0, reason: 'SB-07 grace_expiry_extension', expiresAt: first.sub.graceUntil,
      reference: { grantId: grant.id },
    });
    expect((await ledger.balance(sub.customerId, 'paid', clock.now())).expiring).toEqual([
      { expiresAt: first.sub.graceUntil, amount: 100 },
    ]);

    clock.advance(7 * 86_400_000 - 60_000);
    const duringGrace = await ledger.consume({
      customerId: sub.customerId, poolOrder: ['paid'], amount: 10, idempotencyKey: 'consume:sb07:during',
      meta: { reason: 'usage' }, now: clock.now(), negativeBalance: 'deny', negativeFloor: 0,
    });
    expect(duringGrace.ok).toBe(true);

    clock.advance(60_000);
    const atGraceEnd = await ledger.consume({
      customerId: sub.customerId, poolOrder: ['paid'], amount: 1, idempotencyKey: 'consume:sb07:after',
      meta: { reason: 'usage' }, now: clock.now(), negativeBalance: 'deny', negativeFloor: 0,
    });
    expect(atGraceEnd.ok).toBe(false);
    expect(atGraceEnd.shortfall).toBe(1);
  });

  it('[SB-07] restores only credits debited by expireDue before starting grace', async () => {
    const clock = new FixedClock(period.end);
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'), clock);
    const repo = new InMemoryRepo();
    const notifier = new CollectingNotifier();
    const sub = mkSub();
    await repo.subscriptions.put(sub);
    const grant = (await ledger.append({
      customerId: sub.customerId, pool: 'paid', kind: 'grant', amount: 100,
      unitPriceMinor: 10, currency: 'USD', expiresAt: period.end, source: 'subscription',
      reference: { subscriptionId: sub.id, periodStart: period.start },
      idempotencyKey: `grant:${sub.id}:${period.start.toISOString()}`, actor: 'system', reason: null,
    })).entry;
    await ledger.consume({
      customerId: sub.customerId, poolOrder: ['paid'], amount: 40, idempotencyKey: 'consume:before-expiry',
      meta: {}, now: new Date(period.end.getTime() - 1), negativeBalance: 'deny', negativeFloor: 0,
    });
    await expireDue({ ledger, clock, customerId: sub.customerId });

    const first = await dunning.onPaymentFailed({ sub, policy: resolvePolicy(), ledger, repo, notifier, clock });
    await dunning.onPaymentFailed({ sub: first.sub, policy: resolvePolicy(), ledger, repo, notifier, clock });

    const linked = (await ledger.entries(sub.customerId)).filter((entry) => entry.reference.grantId === grant.id);
    expect(linked.filter((entry) => entry.kind === 'expire').map((entry) => entry.amount)).toEqual([-60]);
    expect(linked.filter((entry) => entry.reason === 'SB-07 grace_expiry_restore').map((entry) => entry.amount)).toEqual([60]);
    expect(linked.filter((entry) => entry.reason === 'SB-07 grace_expiry_extension').map((entry) => entry.amount)).toEqual([0]);
    expect(await ledger.balance(sub.customerId, 'paid', clock.now())).toMatchObject({
      available: 60, expiring: [{ expiresAt: first.sub.graceUntil, amount: 60 }],
    });
    clock.advance(7 * 86_400_000 - 1);
    expect((await ledger.consume({
      customerId: sub.customerId, poolOrder: ['paid'], amount: 10, idempotencyKey: 'consume:restored-grace',
      meta: {}, now: clock.now(), negativeBalance: 'deny', negativeFloor: 0,
    })).ok).toBe(true);
    clock.advance(1);
    expect((await ledger.consume({
      customerId: sub.customerId, poolOrder: ['paid'], amount: 1, idempotencyKey: 'consume:restored-expired',
      meta: {}, now: clock.now(), negativeBalance: 'deny', negativeFloor: 0,
    })).ok).toBe(false);
  });
});

describe('EC:A16 dunning.onGraceExpired — resolves credits on final failure', () => {
  it('[SB-09] keeps marked paid-period credits after final failure with full rollover', async () => {
    const clock = new FixedClock(period.end);
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'), clock);
    const repo = new InMemoryRepo();
    const notifier = new CollectingNotifier();
    const sub = mkSub();
    await repo.subscriptions.put(sub);
    await ledger.append({
      customerId: sub.customerId, pool: 'paid', kind: 'grant', amount: 100,
      unitPriceMinor: null, currency: null, expiresAt: null, source: 'subscription',
      reference: { subscriptionId: sub.id, periodStart: period.start },
      idempotencyKey: `grant:${sub.id}:${period.start.toISOString()}`, actor: 'system', reason: null,
    });
    const policy = resolvePolicy({ credits: { rollover: 'full' } });
    const failed = await dunning.onPaymentFailed({ sub, policy, ledger, repo, notifier, clock });
    clock.advance(7 * 86_400_000);

    const result = await dunning.onGraceExpired({ sub: failed.sub, policy, ledger, repo, notifier, clock });

    expect(result.revoked).toEqual([]);
    expect((await ledger.balance(sub.customerId, 'paid', clock.now())).available).toBe(100);
    expect((await ledger.entries(sub.customerId)).filter((entry) => entry.reason === 'SB-07 paid_period_preserved')).toHaveLength(1);
  });

  it("onFinalFailure='revoke_unpaid_period' (default) revokes the remaining balance of the current period's grant", async () => {
    const clock = new FixedClock(new Date('2024-01-23T00:00:00.000Z'));
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const repo = new InMemoryRepo();
    const notifier = new CollectingNotifier();
    const sub = mkSub({ status: 'past_due', graceUntil: clock.now() });
    await repo.subscriptions.put(sub);
    await ledger.append({
      customerId: 'cust_1', pool: 'paid', kind: 'grant', amount: 100, unitPriceMinor: null, currency: null,
      expiresAt: null, source: 'subscription', reference: {},
      idempotencyKey: `grant:${sub.id}:${period.start.toISOString()}`, actor: 'system', reason: null,
    });
    const policy = resolvePolicy();

    const res = await dunning.onGraceExpired({ sub, policy, ledger, repo, notifier, clock });
    expect(res.sub.status).toBe('expired');
    expect(res.revoked).toHaveLength(1);
    expect(res.revoked[0].amount).toBe(-100);
    const bal = await ledger.balance('cust_1', undefined, clock.now());
    expect(bal.available).toBe(0);
    expect(notifier.sent.map((n) => n.type)).toEqual(['grace.ending']);
  });

  it("onFinalFailure='revoke_all' revokes the entire paid balance regardless of source grant", async () => {
    const clock = new FixedClock(new Date('2024-01-23T00:00:00.000Z'));
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const repo = new InMemoryRepo();
    const notifier = new CollectingNotifier();
    const sub = mkSub({ status: 'past_due', graceUntil: clock.now() });
    await repo.subscriptions.put(sub);
    await ledger.append({
      customerId: 'cust_1', pool: 'paid', kind: 'grant', amount: 150, unitPriceMinor: null, currency: null,
      expiresAt: null, source: 'manual', reference: {}, idempotencyKey: 'extra_grant', actor: 'system', reason: null,
    });
    const policy = resolvePolicy({ dunning: { onFinalFailure: 'revoke_all' } });

    const res = await dunning.onGraceExpired({ sub, policy, ledger, repo, notifier, clock });
    expect(res.revoked[0].amount).toBe(-150);
    const bal = await ledger.balance('cust_1', undefined, clock.now());
    expect(bal.available).toBe(0);
  });

  it("onFinalFailure='keep' leaves the balance untouched", async () => {
    const clock = new FixedClock(new Date('2024-01-23T00:00:00.000Z'));
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const repo = new InMemoryRepo();
    const notifier = new CollectingNotifier();
    const sub = mkSub({ status: 'past_due', graceUntil: clock.now() });
    await repo.subscriptions.put(sub);
    await ledger.append({
      customerId: 'cust_1', pool: 'paid', kind: 'grant', amount: 80, unitPriceMinor: null, currency: null,
      expiresAt: null, source: 'subscription', reference: {}, idempotencyKey: 'g1', actor: 'system', reason: null,
    });
    const policy = resolvePolicy({ dunning: { onFinalFailure: 'keep' } });

    const res = await dunning.onGraceExpired({ sub, policy, ledger, repo, notifier, clock });
    expect(res.revoked).toEqual([]);
    const bal = await ledger.balance('cust_1', undefined, clock.now());
    expect(bal.available).toBe(80);
  });
});

describe('EC:A17 dunning.onRecovered — payment recovers after grace/final-failure', () => {
  it("onRecovery='regrant_current_period' (default) regrants the current period", async () => {
    const clock = new FixedClock(period.start);
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const repo = new InMemoryRepo();
    await repo.plans.put(plan);
    const sub = mkSub({ status: 'expired', graceUntil: null });
    await repo.subscriptions.put(sub);
    const policy = resolvePolicy();

    const res = await dunning.onRecovered({ sub, payment: mkPayment(), policy, ledger, repo, clock });
    expect(res.sub.status).toBe('active');
    expect(res.sub.graceUntil).toBeNull();
    expect(res.grants).toHaveLength(1);
    expect(res.grants[0].entry?.amount).toBe(100);
    const bal = await ledger.balance('cust_1', undefined, clock.now());
    expect(bal.available).toBe(100);
  });

  it("onRecovery='no_regrant' just reactivates without granting", async () => {
    const clock = new FixedClock(period.start);
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const repo = new InMemoryRepo();
    await repo.plans.put(plan);
    const sub = mkSub({ status: 'expired', graceUntil: null });
    await repo.subscriptions.put(sub);
    const policy = resolvePolicy({ dunning: { onRecovery: 'no_regrant' } });

    const res = await dunning.onRecovered({ sub, payment: mkPayment(), policy, ledger, repo, clock });
    expect(res.sub.status).toBe('active');
    expect(res.grants).toEqual([]);
    const bal = await ledger.balance('cust_1', undefined, clock.now());
    expect(bal.available).toBe(0);
  });

  it("onRecovery='regrant_all_missed' regrants the current period (single-period simplification, see spec note #3)", async () => {
    const clock = new FixedClock(period.start);
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const repo = new InMemoryRepo();
    await repo.plans.put(plan);
    const sub = mkSub({ status: 'expired', graceUntil: null });
    await repo.subscriptions.put(sub);
    const policy = resolvePolicy({ dunning: { onRecovery: 'regrant_all_missed' } });

    const res = await dunning.onRecovered({ sub, payment: mkPayment(), policy, ledger, repo, clock });
    expect(res.grants).toHaveLength(1);
    expect(res.grants[0].entry?.amount).toBe(100);
  });
});

describe('EC:A24 dunning smart retry — scheduling', () => {
  it('onPaymentFailed schedules attempt=1 using retryIntervalHours[0]', async () => {
    const clock = new FixedClock(new Date('2024-01-16T00:00:00.000Z'));
    const repo = new InMemoryRepo();
    const notifier = new CollectingNotifier();
    const sub = mkSub();
    await repo.subscriptions.put(sub);
    const policy = dunningPolicy(3, [24, 72, 120]);

    await dunning.onPaymentFailed({ sub, policy, repo, notifier, clock });

    const due = await dunning.retryDue({ repo, clock: new FixedClock(new Date('2024-01-17T00:00:00.001Z')) });
    expect(due).toHaveLength(1);
    expect(due[0].payload).toMatchObject({ subscriptionId: sub.id, attempt: 1 });
    expect(due[0].nextAttemptAt).toEqual(new Date('2024-01-17T00:00:00.000Z')); // +24h
  });

  it('retryAttempts=0 (only the provider\'s own dunning) schedules nothing', async () => {
    const clock = new FixedClock(new Date('2024-01-16T00:00:00.000Z'));
    const repo = new InMemoryRepo();
    const notifier = new CollectingNotifier();
    const sub = mkSub();
    await repo.subscriptions.put(sub);
    const policy = resolvePolicy({ dunning: { retryAttempts: 0 } });

    await dunning.onPaymentFailed({ sub, policy, repo, notifier, clock });

    const due = await dunning.retryDue({ repo, clock: new FixedClock(new Date('2030-01-01T00:00:00.000Z')) });
    expect(due).toEqual([]);
  });

  it('retryDue only returns items whose dueAt has arrived, ordered earliest-first', async () => {
    const repo = new InMemoryRepo();
    const notifier = new CollectingNotifier();
    const policy = dunningPolicy(3, [24, 72, 120]);
    const subA = mkSub({ id: 'sub_a' });
    const subB = mkSub({ id: 'sub_b' });
    await repo.subscriptions.put(subA);
    await repo.subscriptions.put(subB);
    await dunning.onPaymentFailed({ sub: subA, policy, repo, notifier, clock: new FixedClock(new Date('2024-01-10T00:00:00.000Z')) }); // due 2024-01-11
    await dunning.onPaymentFailed({ sub: subB, policy, repo, notifier, clock: new FixedClock(new Date('2024-01-09T00:00:00.000Z')) }); // due 2024-01-10

    const due = await dunning.retryDue({ repo, clock: new FixedClock(new Date('2024-01-12T00:00:00.000Z')) });
    expect(due.map((d) => d.payload.subscriptionId)).toEqual(['sub_b', 'sub_a']); // earliest dueAt first
  });

  it('a shorter retryIntervalHours list repeats its last value for later attempts', async () => {
    const clock = new FixedClock(new Date('2024-01-16T00:00:00.000Z'));
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const repo = new InMemoryRepo();
    const notifier = new CollectingNotifier();
    await repo.plans.put(plan);
    const sub = mkSub({ status: 'past_due', billingKey: 'bk_1', provider: 'toss' });
    await repo.subscriptions.put(sub);
    const policy = dunningPolicy(3, [24]); // only one interval value

    await dunning.onPaymentFailed({ sub, policy, repo, notifier, clock });
    const [item1] = await dunning.retryDue({ repo, clock: new FixedClock(new Date('2024-01-17T00:00:00.001Z')) });
    expect(item1.nextAttemptAt).toEqual(new Date('2024-01-17T00:00:00.000Z')); // +24h

    const provider = new FakeSelfSchedulingProvider();
    provider.nextChargeStatus = 'failed';
    const retryClock = new FixedClock(new Date('2024-01-17T00:00:00.001Z'));
    await dunning.runRetry({ item: item1, provider, repo, ledger, policy, notifier, clock: retryClock });

    const [item2] = await dunning.retryDue({ repo, clock: new FixedClock(new Date('2024-01-18T00:00:00.001Z')) });
    expect(item2.payload).toMatchObject({ attempt: 2 });
    expect(item2.nextAttemptAt).toEqual(new Date('2024-01-18T00:00:00.001Z')); // +24h again (list repeats its last value)
  });
});

describe('EC:A24 dunning.runRetry — self-scheduling provider charges the billing key', () => {
  it('a failed charge notifies payment.failed and schedules the next attempt', async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const repo = new InMemoryRepo();
    const notifier = new CollectingNotifier();
    await repo.plans.put(plan);
    const sub = mkSub({ status: 'past_due', billingKey: 'bk_1', provider: 'toss' });
    await repo.subscriptions.put(sub);
    const policy = dunningPolicy(3, [24, 72, 120]);
    await dunning.onPaymentFailed({ sub, policy, repo, notifier, clock: new FixedClock(new Date('2024-01-16T00:00:00.000Z')) });

    const retryClock = new FixedClock(new Date('2024-01-17T00:00:00.001Z'));
    const [item] = await dunning.retryDue({ repo, clock: retryClock });
    const provider = new FakeSelfSchedulingProvider();
    provider.nextChargeStatus = 'failed';

    const result = await dunning.runRetry({ item, provider, repo, ledger, policy, notifier, clock: retryClock });
    expect(result.outcome).toBe('failed');
    expect(provider.lastCharge?.idempotencyKey).toMatch(new RegExp(`^dunning-retry:${sub.id}:\\d{4}-\\d{2}-\\d{2}T[^:]+:[^:]+:[^:]+:1$`)); // EC:A35 — the period is part of the key
    expect(notifier.sent.map((n) => n.type)).toContain('payment.failed');
    expect(notifier.sent.some((n) => n.type === 'grace.ending')).toBe(false); // not the last attempt yet

    const nextDue = await dunning.retryDue({ repo, clock: new FixedClock(new Date('2024-01-20T01:00:00.000Z')) }); // +72h from retryClock
    expect(nextDue).toHaveLength(1);
    expect(nextDue[0].payload).toMatchObject({ attempt: 2 });
  });

  it('retries exhausted: the last failed attempt also notifies grace.ending, no further item scheduled', async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const repo = new InMemoryRepo();
    const notifier = new CollectingNotifier();
    await repo.plans.put(plan);
    const sub = mkSub({ status: 'past_due', billingKey: 'bk_1', provider: 'toss' });
    await repo.subscriptions.put(sub);
    const policy = dunningPolicy(1, [24]);
    await dunning.onPaymentFailed({ sub, policy, repo, notifier, clock: new FixedClock(new Date('2024-01-16T00:00:00.000Z')) });

    const retryClock = new FixedClock(new Date('2024-01-17T00:00:00.001Z'));
    const [item] = await dunning.retryDue({ repo, clock: retryClock });
    const provider = new FakeSelfSchedulingProvider();
    provider.nextChargeStatus = 'failed';

    const result = await dunning.runRetry({ item, provider, repo, ledger, policy, notifier, clock: retryClock });
    expect(result.outcome).toBe('failed');
    expect(notifier.sent.map((n) => n.type)).toEqual(['payment.failed', 'grace.started', 'payment.failed', 'grace.ending']);

    const nextDue = await dunning.retryDue({ repo, clock: new FixedClock(new Date('2030-01-01T00:00:00.000Z')) });
    expect(nextDue).toEqual([]); // exhausted — the existing graceUntil-driven onGraceExpired path finishes it
  });

  it('a successful charge routes into onRecovered — subscription reactivates and credits regrant', async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const repo = new InMemoryRepo();
    const notifier = new CollectingNotifier();
    await repo.plans.put(plan);
    const sub = mkSub({ status: 'past_due', billingKey: 'bk_1', provider: 'toss' });
    await repo.subscriptions.put(sub);
    const policy = dunningPolicy(3, [24, 72, 120]);
    await dunning.onPaymentFailed({ sub, policy, repo, notifier, clock: new FixedClock(new Date('2024-01-16T00:00:00.000Z')) });

    const retryClock = new FixedClock(new Date('2024-01-17T00:00:00.001Z'));
    const [item] = await dunning.retryDue({ repo, clock: retryClock });
    const provider = new FakeSelfSchedulingProvider();
    provider.nextChargeStatus = 'succeeded';

    const result = await dunning.runRetry({ item, provider, repo, ledger, policy, notifier, clock: retryClock });
    expect(result.outcome).toBe('recovered');
    expect(result.sub?.status).toBe('active');
    expect(result.grants).toHaveLength(1);
    const bal = await ledger.balance('cust_1', 'paid', retryClock.now());
    expect(bal.available).toBe(100);

    const nextDue = await dunning.retryDue({ repo, clock: new FixedClock(new Date('2030-01-01T00:00:00.000Z')) });
    expect(nextDue).toEqual([]); // recovered — no more retries scheduled
  });

  it('a subscription already recovered by the time the item is due is skipped, not double-charged', async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const repo = new InMemoryRepo();
    const notifier = new CollectingNotifier();
    const sub = mkSub({ status: 'past_due', billingKey: 'bk_1', provider: 'toss' });
    await repo.subscriptions.put(sub);
    const policy = dunningPolicy(3, [24, 72, 120]);
    await dunning.onPaymentFailed({ sub, policy, repo, notifier, clock: new FixedClock(new Date('2024-01-16T00:00:00.000Z')) });

    const retryClock = new FixedClock(new Date('2024-01-17T00:00:00.001Z'));
    const [item] = await dunning.retryDue({ repo, clock: retryClock });

    // the provider's own dunning (or a manual retry) already recovered it via a different path
    await repo.subscriptions.put({ ...(await repo.subscriptions.get(sub.id))!, status: 'active', graceUntil: null });

    const provider = new FakeSelfSchedulingProvider(); // chargeBillingKey throws if called unexpectedly — it isn't
    const result = await dunning.runRetry({ item, provider, repo, ledger, policy, notifier, clock: retryClock });
    expect(result.outcome).toBe('skipped');
    expect(provider.lastCharge).toBeNull();
  });

  it('EC:K1 — a version conflict during recovery re-reads and retries instead of losing the write', async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const repo = new InMemoryRepo();
    const notifier = new CollectingNotifier();
    await repo.plans.put(plan);
    const sub = mkSub({ status: 'past_due', billingKey: 'bk_1', provider: 'toss' });
    await repo.subscriptions.put(sub);
    const policy = dunningPolicy(3, [24, 72, 120]);
    await dunning.onPaymentFailed({ sub, policy, repo, notifier, clock: new FixedClock(new Date('2024-01-16T00:00:00.000Z')) });

    const retryClock = new FixedClock(new Date('2024-01-17T00:00:00.001Z'));
    const [item] = await dunning.retryDue({ repo, clock: retryClock });

    // Simulate another writer (e.g. an unrelated webhook) touching the row WHILE our charge is
    // in flight, exactly the race EC:K1 exists for.
    class ConflictOnceProvider extends FakeSelfSchedulingProvider {
      fired = false;
      constructor(private repo2: Repo, private subId: string) {
        super();
      }
      async chargeBillingKey(input: Parameters<FakeSelfSchedulingProvider['chargeBillingKey']>[0]) {
        if (!this.fired) {
          this.fired = true;
          const current = await this.repo2.subscriptions.get(this.subId);
          if (current) await this.repo2.subscriptions.put({ ...current }); // same version -> bumps the stored version
        }
        return super.chargeBillingKey(input);
      }
    }
    const provider = new ConflictOnceProvider(repo, sub.id);
    provider.nextChargeStatus = 'succeeded';

    const result = await dunning.runRetry({ item, provider, repo, ledger, policy, notifier, clock: retryClock });
    expect(result.outcome).toBe('recovered');
    expect(result.sub?.status).toBe('active');
    expect(provider.fired).toBe(true);
  });
});

describe('EC:A24 dunning.runRetry — provider-scheduled dunning (Stripe/Polar/PortOne) only advances our own counter', () => {
  it('never calls chargeBillingKey; reschedules bookkeeping so grace.ending still fires on time', async () => {
    const repo = new InMemoryRepo();
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const notifier = new CollectingNotifier();
    const sub = mkSub({ status: 'past_due', provider: 'stripe' }); // no billingKey — native provider
    await repo.subscriptions.put(sub);
    const policy = dunningPolicy(2, [24, 72]);
    await dunning.onPaymentFailed({ sub, policy, repo, notifier, clock: new FixedClock(new Date('2024-01-16T00:00:00.000Z')) });

    const retryClock = new FixedClock(new Date('2024-01-17T00:00:00.001Z'));
    const [item] = await dunning.retryDue({ repo, clock: retryClock });
    const provider = new FakeNativeProvider(); // chargeBillingKey throws 'unexpected call' if invoked

    const result = await dunning.runRetry({ item, provider, repo, ledger, policy, notifier, clock: retryClock });
    expect(result.outcome).toBe('deferred_to_provider');
    expect(notifier.sent.map((n) => n.type)).toEqual(['payment.failed', 'grace.started']); // no extra notify from runRetry itself

    const nextDue = await dunning.retryDue({ repo, clock: new FixedClock(new Date('2024-01-20T01:00:00.000Z')) });
    expect(nextDue).toHaveLength(1);
    expect(nextDue[0].payload).toMatchObject({ attempt: 2 });
  });
});
