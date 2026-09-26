// spec: packages/credits/spec/credits.pseudo.md [EC:A15] [EC:B1] [EC:B7] [EC:B9] [EC:B10]
import { describe, expect, it } from 'vitest';
import { FixedClock, InMemoryLedger, InMemoryRepo, Plan, Payment, Subscription, SequentialIdGen, resolvePolicy } from 'boilpayment-core';
import { grantForPeriod, topup, grantPromo, grantTrial, manualGrant, manualRevoke } from '../src/index.js';
import { clawback } from '../src/clawback.js';
import { consume } from '../src/consume.js';

const clock = new FixedClock(new Date('2024-01-01T00:00:00.000Z'));

const plan: Plan = {
  id: 'plan_a', name: 'Plan A', interval: 'month', creditsPerPeriod: 100, usageIncluded: 0, trialDays: 0,
  prices: [{ currency: 'USD', amountMinor: 1000 }],
};
const period = { start: new Date('2024-01-01T00:00:00.000Z'), end: new Date('2024-02-01T00:00:00.000Z') };

function mkSub(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 'sub_1', customerId: 'cust_1', planId: plan.id, provider: 'stripe', providerRef: 'stripe_sub_1',
    status: 'active', currentPeriod: period, anchorDay: 1, cancelAtPeriodEnd: false, graceUntil: null,
    billingKey: null, scheduledPlanId: null, createdAt: clock.now(),
    ...overrides,
  };
}
function mkPayment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: 'pay_1', customerId: 'cust_1', provider: 'stripe', providerRef: 'pi_1', subscriptionId: 'sub_1',
    amount: { amountMinor: 1000, currency: 'USD' }, status: 'succeeded', kind: 'subscription', period,
    occurredAt: clock.now(), failure: null,
    ...overrides,
  };
}

describe('EC:A15 grantForPeriod — defer during grace', () => {
  it("EC:A15 past_due + grantDuringGrace='defer_until_paid' (default) defers, writes nothing", async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const policy = resolvePolicy();
    const sub = mkSub({ status: 'past_due' });
    const res = await grantForPeriod({ sub, plan, period, payment: mkPayment(), policy, ledger, clock });
    expect(res).toEqual({ entry: null, duplicated: false, deferred: true, offset: 0, offsetEntries: [] });
    const bal = await ledger.balance('cust_1', undefined, clock.now());
    expect(bal.available).toBe(0);
  });

  it("EC:A15 past_due + grantDuringGrace='grant_anyway' grants normally", async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const policy = resolvePolicy({ dunning: { grantDuringGrace: 'grant_anyway' } });
    const sub = mkSub({ status: 'past_due' });
    const res = await grantForPeriod({ sub, plan, period, payment: mkPayment(), policy, ledger, clock });
    expect(res.deferred).toBe(false);
    expect(res.entry?.amount).toBe(100);
    const bal = await ledger.balance('cust_1', undefined, clock.now());
    expect(bal.available).toBe(100);
  });

  it('grantForPeriod on an active subscription grants plan.creditsPerPeriod with unit price + remainder', async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const policy = resolvePolicy();
    const sub = mkSub();
    // 1000 minor / 100 credits = 10 exactly, no remainder
    const res = await grantForPeriod({ sub, plan, period, payment: mkPayment(), policy, ledger, clock });
    expect(res.entry?.amount).toBe(100);
    expect(res.entry?.unitPriceMinor).toBe(10);
    expect(res.entry?.reason).toBeNull();
  });

  it('grantForPeriod records a leftover minor-unit remainder in reason without losing it', async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const policy = resolvePolicy();
    const sub = mkSub();
    // 1005 minor / 100 credits = 10 with remainder 5
    const payment = mkPayment({ amount: { amountMinor: 1005, currency: 'USD' } });
    const res = await grantForPeriod({ sub, plan, period, payment, policy, ledger, clock });
    expect(res.entry?.unitPriceMinor).toBe(10);
    expect(res.entry?.reason).toBe('remainder_minor:5');
  });
});

describe('EC:B10 topup expiry', () => {
  it('topupExpiryDays=null (default) never expires', async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const policy = resolvePolicy();
    const payment = mkPayment({ id: 'pay_topup', amount: { amountMinor: 500, currency: 'USD' } });
    const res = await topup({ customerId: 'cust_1', payment, credits: 50, policy, ledger, clock });
    expect(res.entry?.expiresAt).toBeNull();
  });

  it('topupExpiryDays=N expires N days from clock.now()', async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const policy = resolvePolicy({ credits: { topupExpiryDays: 30 } });
    const payment = mkPayment({ id: 'pay_topup', amount: { amountMinor: 500, currency: 'USD' } });
    const res = await topup({ customerId: 'cust_1', payment, credits: 50, policy, ledger, clock });
    expect(res.entry?.expiresAt).toEqual(new Date('2024-01-31T00:00:00.000Z'));
  });
});

describe('EC:J1-J5 topup operation idempotency (only when repo is provided)', () => {
  it('[EC:J1] without repo, topup() keeps its pre-existing behavior (ledger-level dedup only)', async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const policy = resolvePolicy();
    const payment = mkPayment({ id: 'pay_topup_norepo', amount: { amountMinor: 500, currency: 'USD' } });
    const first = await topup({ customerId: 'cust_1', payment, credits: 50, policy, ledger, clock });
    const second = await topup({ customerId: 'cust_1', payment, credits: 50, policy, ledger, clock });
    expect(second.duplicated).toBe(true); // ledger.append's own idempotency_key UNIQUE dedup
    expect(first.entry?.id).toBe(second.entry?.id);
    const bal = await ledger.balance('cust_1', 'paid', clock.now());
    expect(bal.available).toBe(50); // granted exactly once
  });

  it('[EC:J1] with repo, a retried topup() with the default key replays the first GrantResult', async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const repo = new InMemoryRepo();
    const policy = resolvePolicy();
    const payment = mkPayment({ id: 'pay_topup_repo', amount: { amountMinor: 500, currency: 'USD' } });
    const first = await topup({ customerId: 'cust_1', payment, credits: 50, policy, ledger, clock, repo });
    const second = await topup({ customerId: 'cust_1', payment, credits: 50, policy, ledger, clock, repo });
    expect(second).toEqual(first);
    const bal = await ledger.balance('cust_1', 'paid', clock.now());
    expect(bal.available).toBe(50); // granted exactly once
  });

  it('[EC:J2] with repo, the same key with a different payload throws idempotency_key_reused', async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const repo = new InMemoryRepo();
    const policy = resolvePolicy();
    const payment = mkPayment({ id: 'pay_topup_j2', amount: { amountMinor: 500, currency: 'USD' } });
    await topup({ customerId: 'cust_1', payment, credits: 50, policy, ledger, clock, repo });
    await expect(topup({ customerId: 'cust_1', payment, credits: 99, policy, ledger, clock, repo })).rejects.toMatchObject({
      code: 'idempotency_key_reused',
    });
  });
});

describe('EC:B7 pools separate — clawback/revoke only ever touches the paid pool', () => {
  it('clawback on paid leaves promo/trial pool balances untouched', async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const policy = resolvePolicy();
    await grantForPeriod({ sub: mkSub(), plan, period, payment: mkPayment(), policy, ledger, clock }); // paid 100
    await grantPromo({ customerId: 'cust_1', amount: 30, ledger, clock, idempotencyKey: 'promo_1' });
    await grantTrial({ customerId: 'cust_1', amount: 20, ledger, clock, idempotencyKey: 'trial_1' });

    await clawback({
      customerId: 'cust_1', amount: 40, policy, ledger, clock, reason: 'test', reference: {},
      actor: 'system', idempotencyKey: 'revoke:manual:1', shortfall: 'clamp_to_zero',
    });

    const paidBal = await ledger.balance('cust_1', 'paid', clock.now());
    const promoBal = await ledger.balance('cust_1', 'promo', clock.now());
    const trialBal = await ledger.balance('cust_1', 'trial', clock.now());
    expect(paidBal.available).toBe(60); // 100 - 40
    expect(promoBal.available).toBe(30); // untouched
    expect(trialBal.available).toBe(20); // untouched
  });
});

describe('EC:B9 manual grant/revoke — reason and actor mandatory', () => {
  it('manualGrant without reason throws', async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    await expect(
      manualGrant({ customerId: 'cust_1', pool: 'paid', amount: 5, reason: '', actor: 'admin', ledger, clock, idempotencyKey: 'k1' }),
    ).rejects.toThrow();
  });

  it('manualRevoke without actor throws', async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    await expect(
      manualRevoke({ customerId: 'cust_1', pool: 'paid', amount: 5, reason: 'abuse', actor: '', ledger, clock, idempotencyKey: 'k1' }),
    ).rejects.toThrow();
  });

  it('manualGrant/manualRevoke with reason+actor succeed with source=manual', async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const g = await manualGrant({ customerId: 'cust_1', pool: 'paid', amount: 5, reason: 'goodwill', actor: 'admin', ledger, clock, idempotencyKey: 'k1' });
    expect(g.entry?.source).toBe('manual');
    expect(g.entry?.amount).toBe(5);
  });
});

describe('EC:B17 credits.negativeOffset — a negative balance settled against the next grant', () => {
  async function seedDebt(ledger: InMemoryLedger, amount: number) {
    // manualRevoke writes exactly -amount regardless of current balance — the simplest way to
    // land an unbucketed negative balance (the same shape EC:A4 allow_negative / EC:B4
    // allow_to_floor|allow_unbounded produce in practice).
    return manualRevoke({ customerId: 'cust_1', pool: 'paid', amount, reason: 'chargeback', actor: 'admin', ledger, clock, idempotencyKey: 'debt_1' });
  }

  it("offset_next_grant (default): grant settles the debt first, only the remainder becomes spendable", async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const policy = resolvePolicy(); // credits.negativeOffset defaults to 'offset_next_grant'
    await seedDebt(ledger, 30);
    expect((await ledger.balance('cust_1', 'paid', clock.now())).available).toBe(-30);

    // plan.creditsPerPeriod = 100 — "80 granted, 30 applied, 50 available" narrative scaled to 100/30/70.
    const res = await grantForPeriod({ sub: mkSub(), plan, period, payment: mkPayment(), policy, ledger, clock });
    expect(res.entry?.amount).toBe(100); // full grant amount still recorded ("100 granted")
    expect(res.offset).toBe(30); // "30 applied to the negative balance"
    expect(res.offsetEntries).toHaveLength(2);
    expect(res.offsetEntries.every((e) => e.kind === 'adjust')).toBe(true);
    expect(res.offsetEntries.map((e) => e.amount).sort((a, b) => a - b)).toEqual([-30, 30]);

    const bal = await ledger.balance('cust_1', 'paid', clock.now());
    expect(bal.available).toBe(70); // "70 available" — same total a plain grant would already net,
    // but now correctly capped at the bucket level too (see the consume() assertion below)
  });

  it("offset_next_grant caps the new grant's own bucket — consume() can no longer overdraw past the true remainder", async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const policy = resolvePolicy();
    await seedDebt(ledger, 30);
    await grantForPeriod({ sub: mkSub(), plan, period, payment: mkPayment(), policy, ledger, clock }); // grants 100, offsets 30 -> 70 spendable

    // Without the bucket cap, a request for the full 100 would draw entirely from the fresh
    // bucket (which structurally has 100 remaining) even though only 70 is truly available.
    await expect(
      consume({ customerId: 'cust_1', amount: 100, policy, ledger, clock, idempotencyKey: 'spend_1' }),
    ).rejects.toMatchObject({ code: 'insufficient_balance', shortfall: 30 });

    const res = await consume({ customerId: 'cust_1', amount: 70, policy, ledger, clock, idempotencyKey: 'spend_2' });
    expect(res.ok).toBe(true);
    expect((await ledger.balance('cust_1', 'paid', clock.now())).available).toBe(0);
  });

  it("negativeOffset='never' leaves the debt outstanding — no adjust entries, bucket not capped", async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const policy = resolvePolicy({ credits: { negativeOffset: 'never' } });
    await seedDebt(ledger, 30);

    const res = await grantForPeriod({ sub: mkSub(), plan, period, payment: mkPayment(), policy, ledger, clock });
    expect(res.offset).toBe(0);
    expect(res.offsetEntries).toEqual([]);

    // the fresh bucket is NOT capped: the full grant amount can still be drawn in one request...
    const spend = await consume({ customerId: 'cust_1', amount: 100, policy, ledger, clock, idempotencyKey: 'spend_never' });
    expect(spend.ok).toBe(true);
    // ...which leaves the pre-existing debt sitting there, uncollected, as documented.
    expect((await ledger.balance('cust_1', 'paid', clock.now())).available).toBe(-30);
  });

  it('a duplicated (re-delivered) grant does not re-offset', async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const policy = resolvePolicy();
    await seedDebt(ledger, 30);
    const first = await grantForPeriod({ sub: mkSub(), plan, period, payment: mkPayment(), policy, ledger, clock });
    expect(first.offset).toBe(30);

    const second = await grantForPeriod({ sub: mkSub(), plan, period, payment: mkPayment(), policy, ledger, clock });
    expect(second.duplicated).toBe(true);
    expect(second.offset).toBe(0);
    expect(second.offsetEntries).toEqual([]);
    expect((await ledger.balance('cust_1', 'paid', clock.now())).available).toBe(70); // unchanged
  });

  it('no debt: offset is a no-op even under offset_next_grant', async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const policy = resolvePolicy();
    const res = await grantForPeriod({ sub: mkSub(), plan, period, payment: mkPayment(), policy, ledger, clock });
    expect(res.offset).toBe(0);
    expect(res.offsetEntries).toEqual([]);
    expect((await ledger.balance('cust_1', 'paid', clock.now())).available).toBe(100);
  });

  it('topup() also settles a negative balance against the incoming top-up', async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const policy = resolvePolicy();
    await seedDebt(ledger, 20);
    const payment = mkPayment({ id: 'pay_topup_offset', amount: { amountMinor: 500, currency: 'USD' } });
    const res = await topup({ customerId: 'cust_1', payment, credits: 50, policy, ledger, clock });
    expect(res.offset).toBe(20);
    expect(res.offsetEntries).toHaveLength(2);
    expect((await ledger.balance('cust_1', 'paid', clock.now())).available).toBe(30); // -20 + 50
  });
});

describe('[EC:L5] correlationId propagation', () => {
  it('[EC:L5] grantForPeriod stamps reference.correlationId on the grant entry', async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const policy = resolvePolicy();
    const res = await grantForPeriod({ sub: mkSub(), plan, period, payment: mkPayment(), policy, ledger, clock, correlationId: 'corr_grant_1' });
    expect(res.entry?.reference.correlationId).toBe('corr_grant_1');
  });

  it('[EC:L5] topup stamps reference.correlationId on the grant entry', async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const policy = resolvePolicy();
    const payment = mkPayment({ id: 'pay_topup_corr', amount: { amountMinor: 500, currency: 'USD' } });
    const res = await topup({ customerId: 'cust_1', payment, credits: 50, policy, ledger, clock, correlationId: 'corr_topup_1' });
    expect(res.entry?.reference.correlationId).toBe('corr_topup_1');
  });

  it('[EC:L5] no correlationId -> reference.correlationId stays undefined', async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const policy = resolvePolicy();
    const res = await grantForPeriod({ sub: mkSub(), plan, period, payment: mkPayment(), policy, ledger, clock });
    expect(res.entry?.reference.correlationId).toBeUndefined();
  });
});
