// spec: packages/credits/spec/credits.pseudo.md [EC:B1] [EC:B2]
// Regression: examples/e2e/FINDINGS.md #2 — bank-cap excess must NOT be double-subtracted from
// balance. Fixed 2026-09-09 (team lead resolution): rolloverOnRenewal no longer writes an
// unattributed 'expire' row for the portion over bankCap; the source grants just lapse on their
// own expiresAt. Expected: newPeriodGrant(300) + min(carriedOver=270, bankCap=50) = 350.
import { describe, expect, it } from 'vitest';
import { FixedClock, InMemoryLedger, Plan, Payment, Subscription, SequentialIdGen, resolvePolicy } from 'boilpayment-core';
import { grantForPeriod, rolloverOnRenewal } from '../src/index.js';

const period1 = { start: new Date('2024-01-01T00:00:00.000Z'), end: new Date('2024-02-01T00:00:00.000Z') };
const period2 = { start: new Date('2024-02-01T00:00:00.000Z'), end: new Date('2024-03-01T00:00:00.000Z') };

const planA: Plan = { id: 'plan_a', name: 'Plan A', interval: 'month', creditsPerPeriod: 100, usageIncluded: 0, trialDays: 0, prices: [{ currency: 'USD', amountMinor: 1000 }] };
const planB: Plan = { id: 'plan_b', name: 'Plan B', interval: 'month', creditsPerPeriod: 300, usageIncluded: 0, trialDays: 0, prices: [{ currency: 'USD', amountMinor: 3000 }] };

function mkSub(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 'sub_1', customerId: 'cust_1', planId: planA.id, provider: 'stripe', providerRef: 'stripe_sub_1',
    status: 'active', currentPeriod: period1, anchorDay: 1, cancelAtPeriodEnd: false, graceUntil: null,
    billingKey: null, scheduledPlanId: null, createdAt: period1.start,
    ...overrides,
  };
}
function mkPayment(p: typeof period1, amountMinor: number): Payment {
  return {
    id: `pay_${p.start.toISOString()}`, customerId: 'cust_1', provider: 'stripe', providerRef: 'pi_1', subscriptionId: 'sub_1',
    amount: { amountMinor, currency: 'USD' }, status: 'succeeded', kind: 'subscription', period: p, occurredAt: p.start, failure: null,
  };
}

describe("EC:B1 rollover='none'/'full' — no-op, nothing carried", () => {
  it("rollover='none' returns a no-op regardless of leftover balance", async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const clock = new FixedClock(period2.start);
    const policy = resolvePolicy({ credits: { rollover: 'none' } });
    const sub = mkSub();
    await ledger.append({
      customerId: 'cust_1', pool: 'paid', kind: 'grant', amount: 100, unitPriceMinor: null, currency: null,
      expiresAt: period1.end, source: 'subscription', reference: { subscriptionId: sub.id, periodStart: period1.start },
      idempotencyKey: 'g1', actor: 'system', reason: null,
    });
    const res = await rolloverOnRenewal({ sub, policy, ledger, clock, newPeriod: period2 });
    expect(res).toEqual({ entries: [], banked: 0, expired: 0 });
  });

  it("rollover='full' returns a no-op (previous grants never expire, nothing to move)", async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const clock = new FixedClock(period2.start);
    const policy = resolvePolicy({ credits: { rollover: 'full' } });
    const sub = mkSub();
    const res = await rolloverOnRenewal({ sub, policy, ledger, clock, newPeriod: period2 });
    expect(res).toEqual({ entries: [], banked: 0, expired: 0 });
  });
});

describe("EC:B1 EC:B2 rollover='banked' — regression: bank-cap excess is not double-subtracted", () => {
  it('300 (new period grant) + min(270 carried, bankCap 50) = 350', async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const clock = new FixedClock(period1.start);
    const policy = resolvePolicy({ credits: { rollover: 'banked', bankCap: 50 } });
    const sub = mkSub();

    // period-1 grant (100), consumed 30 -> 70 remaining
    await grantForPeriod({ sub, plan: planA, period: period1, payment: mkPayment(period1, 1000), policy, ledger, clock });
    await ledger.consume({
      customerId: 'cust_1', poolOrder: ['paid'], amount: 30, idempotencyKey: 'consume_1',
      meta: {}, now: clock.now(), negativeBalance: 'block', negativeFloor: 0,
    });

    // upgrade credit delta (200), expiring with the same period — simulates lifecycle.upgrade's grant
    await ledger.append({
      customerId: 'cust_1', pool: 'paid', kind: 'grant', amount: 200, unitPriceMinor: null, currency: null,
      expiresAt: period1.end, source: 'subscription', reference: { subscriptionId: sub.id, periodStart: period1.start },
      idempotencyKey: 'grant:upgrade:sub_1', actor: 'system', reason: 'upgrade:plan_a->plan_b',
    });
    // total unexpired-but-about-to-expire leftover = 70 + 200 = 270

    clock.advance(31 * 86_400_000); // Jan1 -> Feb1 == period2.start

    const rollover = await rolloverOnRenewal({ sub: { ...sub, planId: planB.id }, policy, ledger, clock, newPeriod: period2 });
    expect(rollover.banked).toBe(50);
    expect(rollover.expired).toBe(220); // 270 - 50, NOT written as a ledger entry
    expect(rollover.entries).toHaveLength(1);

    const allEntries = await ledger.entries('cust_1');
    expect(allEntries.filter((e) => e.kind === 'expire')).toHaveLength(0); // no unattributed expire row

    await grantForPeriod({
      sub: { ...sub, planId: planB.id, currentPeriod: period2 }, plan: planB, period: period2,
      payment: mkPayment(period2, 3000), policy, ledger, clock,
    });

    const bal = await ledger.balance('cust_1', undefined, clock.now());
    expect(bal.available).toBe(350); // 300 + min(270, 50)
  });

  it('EC:B2 alreadyBanked — a retried rolloverOnRenewal call for the same period does not double-bank', async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const clock = new FixedClock(period1.start);
    const policy = resolvePolicy({ credits: { rollover: 'banked', bankCap: 50 } });
    const sub = mkSub();

    await grantForPeriod({ sub, plan: planA, period: period1, payment: mkPayment(period1, 1000), policy, ledger, clock });
    await ledger.consume({
      customerId: 'cust_1', poolOrder: ['paid'], amount: 30, idempotencyKey: 'consume_1',
      meta: {}, now: clock.now(), negativeBalance: 'block', negativeFloor: 0,
    });
    await ledger.append({
      customerId: 'cust_1', pool: 'paid', kind: 'grant', amount: 200, unitPriceMinor: null, currency: null,
      expiresAt: period1.end, source: 'subscription', reference: { subscriptionId: sub.id, periodStart: period1.start },
      idempotencyKey: 'grant:upgrade:sub_1', actor: 'system', reason: null,
    });
    clock.advance(31 * 86_400_000);

    const first = await rolloverOnRenewal({ sub, policy, ledger, clock, newPeriod: period2 });
    expect(first.banked).toBe(50);
    expect(first.entries).toHaveLength(1);

    const second = await rolloverOnRenewal({ sub, policy, ledger, clock, newPeriod: period2 });
    expect(second.banked).toBe(0); // already-banked 50 fills the cap; nothing more to append
    expect(second.entries).toHaveLength(0);

    const rolloverGrants = (await ledger.entries('cust_1')).filter((e) => e.kind === 'grant' && e.source === 'rollover');
    expect(rolloverGrants).toHaveLength(1); // still just the one from the first call
    expect(rolloverGrants[0].amount).toBe(50);
  });
});
