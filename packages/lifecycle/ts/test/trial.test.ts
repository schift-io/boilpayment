// spec: packages/lifecycle/spec/lifecycle.pseudo.md [EC:A9]
import { describe, expect, it } from 'vitest';
import { FixedClock, InMemoryLedger, InMemoryRepo, Plan, Payment, Subscription, SequentialIdGen, resolvePolicy } from 'boilpayment-core';
import { convertTrial } from '../src/index.js';

const plan: Plan = { id: 'plan_paid', name: 'Paid', interval: 'month', creditsPerPeriod: 100, usageIncluded: 0, trialDays: 0, prices: [{ currency: 'USD', amountMinor: 1000 }] };
const period = { start: new Date('2024-01-01T00:00:00.000Z'), end: new Date('2024-02-01T00:00:00.000Z') };

function mkSub(): Subscription {
  return {
    id: 'sub_1', customerId: 'cust_1', planId: 'plan_trial', provider: 'stripe', providerRef: 'stripe_sub_1',
    status: 'trialing', currentPeriod: period, anchorDay: 1, cancelAtPeriodEnd: false, graceUntil: null,
    billingKey: null, scheduledPlanId: null, createdAt: period.start,
  };
}
function mkPayment(): Payment {
  return {
    id: 'pay_1', customerId: 'cust_1', provider: 'stripe', providerRef: 'pi_1', subscriptionId: 'sub_1',
    amount: { amountMinor: 1000, currency: 'USD' }, status: 'succeeded', kind: 'subscription', period,
    occurredAt: period.start, failure: null,
  };
}

async function setup(trialBalance: number) {
  const clock = new FixedClock(period.start);
  const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
  const repo = new InMemoryRepo();
  await repo.plans.put(plan);
  if (trialBalance > 0) {
    await ledger.append({
      customerId: 'cust_1', pool: 'trial', kind: 'grant', amount: trialBalance, unitPriceMinor: null, currency: null,
      expiresAt: null, source: 'trial', reference: {}, idempotencyKey: 'trial_seed', actor: 'system', reason: null,
    });
  }
  return { clock, ledger, repo };
}

describe("EC:A9 trial.creditsOnConvert='grant_full' (default) — grants paid, discards trial pool", () => {
  it('grants plan.creditsPerPeriod to paid and revokes the remaining trial balance', async () => {
    const { clock, ledger, repo } = await setup(50);
    const sub = mkSub();
    const policy = resolvePolicy();

    const res = await convertTrial({ sub, plan, payment: mkPayment(), policy, ledger, repo, clock });
    expect(res.sub.status).toBe('active');
    expect(res.sub.planId).toBe(plan.id);
    expect(res.grant?.amount).toBe(100);
    expect(res.trialRevoked?.amount).toBe(-50);
    const paidBal = await ledger.balance('cust_1', 'paid', clock.now());
    const trialBal = await ledger.balance('cust_1', 'trial', clock.now());
    expect(paidBal.available).toBe(100);
    expect(trialBal.available).toBe(0);
  });
});

describe("EC:A9 trial.creditsOnConvert='grant_full_keep_trial' — grants paid, leaves trial pool alone", () => {
  it('trial balance survives the conversion', async () => {
    const { clock, ledger, repo } = await setup(50);
    const sub = mkSub();
    const policy = resolvePolicy({ trial: { creditsOnConvert: 'grant_full_keep_trial' } });

    const res = await convertTrial({ sub, plan, payment: mkPayment(), policy, ledger, repo, clock });
    expect(res.grant?.amount).toBe(100);
    expect(res.trialRevoked).toBeNull();
    const trialBal = await ledger.balance('cust_1', 'trial', clock.now());
    expect(trialBal.available).toBe(50);
  });
});

describe("EC:A9 trial.creditsOnConvert='no_grant_until_next_period' — no grant at conversion time", () => {
  it('grants nothing now; the next onRenewalPaid call grants under its own key', async () => {
    const { clock, ledger, repo } = await setup(50);
    const sub = mkSub();
    const policy = resolvePolicy({ trial: { creditsOnConvert: 'no_grant_until_next_period' } });

    const res = await convertTrial({ sub, plan, payment: mkPayment(), policy, ledger, repo, clock });
    expect(res.grant).toBeNull();
    expect(res.trialRevoked).toBeNull();
    expect(res.sub.status).toBe('active');
    const paidBal = await ledger.balance('cust_1', 'paid', clock.now());
    expect(paidBal.available).toBe(0);
    const trialBal = await ledger.balance('cust_1', 'trial', clock.now());
    expect(trialBal.available).toBe(50); // untouched
  });
});

describe('[SB-03] paid credits begin with the first successful invoice after trial', () => {
  it('keeps a trialing subscription at zero paid credits on day one and grants the first invoice once', async () => {
    const { clock, ledger, repo } = await setup(0);
    const trialPlan: Plan = { ...plan, trialDays: 14 };
    const sub = { ...mkSub(), planId: trialPlan.id };

    expect(sub.status).toBe('trialing');
    expect((await ledger.balance(sub.customerId, 'paid', clock.now())).available).toBe(0);

    const first = await convertTrial({ sub, plan: trialPlan, payment: mkPayment(), policy: resolvePolicy(), ledger, repo, clock });
    const replay = await convertTrial({ sub, plan: trialPlan, payment: mkPayment(), policy: resolvePolicy(), ledger, repo, clock });

    expect(first.grant?.amount).toBe(trialPlan.creditsPerPeriod);
    expect(replay.grant?.id).toBe(first.grant?.id);
    expect((await ledger.balance(sub.customerId, 'paid', clock.now())).available).toBe(trialPlan.creditsPerPeriod);
  });
});
