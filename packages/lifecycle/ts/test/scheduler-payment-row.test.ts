// [EC:A26] Self-scheduled renewals (Toss, PortOne scheduler=self) store the charged payment so
// refunds, settlement, timeline and recovery see it. Toss sends no webhook for billing payments.
import { describe, expect, it } from 'vitest';
import { FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen, resolvePolicy } from 'boilpayment-core';
import type { Payment, Plan, Subscription } from 'boilpayment-core';
import { scheduler } from '../src/index.js';
import { FakeSelfSchedulingProvider } from './helpers.js';

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

describe('[EC:A26] scheduler.tick records the renewal payment', () => {
  it('[EC:A26] a succeeded charge is stored with the subscription, period and customer; the grant points at it', async () => {
    const clock = new FixedClock(new Date('2024-02-01T00:00:00.000Z'));
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const repo = new InMemoryRepo();
    await repo.plans.put(plan);
    await repo.subscriptions.put(mkSub());
    const provider = new FakeSelfSchedulingProvider();
    await scheduler.tick({ provider, repo, policy: resolvePolicy(), ledger, clock, ids: new SequentialIdGen('id_') });
    const rows = await repo.payments.list({ subscriptionId: 'sub_1' } as Partial<Payment>);
    expect(rows.map((p) => [p.status, p.kind, p.customerId, p.provider, p.period?.start.toISOString()])).toEqual([
      ['succeeded', 'subscription', 'cust_1', 'toss', '2024-02-01T00:00:00.000Z'],
    ]);
    const grants = await ledger.entries('cust_1', { kind: 'grant' });
    expect(grants.map((g) => g.reference.paymentId)).toEqual([rows[0].id]);
  });

  it('[EC:A26] a retried charge that returns the same provider payment reuses the stored row', async () => {
    const clock = new FixedClock(new Date('2024-02-01T00:00:00.000Z'));
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const repo = new InMemoryRepo();
    await repo.plans.put(plan);
    const sub = mkSub();
    await repo.subscriptions.put(sub);
    const key = `charge:${sub.id}:${sub.currentPeriod.end.toISOString()}`;
    await repo.payments.put({ id: 'pay_local_earlier', customerId: 'cust_1', provider: 'toss', providerRef: key, subscriptionId: sub.id,
      amount: { amountMinor: plan.prices[0].amountMinor, currency: plan.prices[0].currency }, status: 'succeeded', kind: 'subscription',
      period: null, occurredAt: clock.now(), failure: null });
    await scheduler.tick({ provider: new FakeSelfSchedulingProvider(), repo, policy: resolvePolicy(), ledger, clock, ids: new SequentialIdGen('id_') });
    const rows = await repo.payments.list({ subscriptionId: sub.id } as Partial<Payment>);
    expect(rows.map((p) => p.id)).toEqual(['pay_local_earlier']);
  });

  it('[EC:A34] a declined charge is recorded as a failed attempt (dunning handles the retries)', async () => {
    const clock = new FixedClock(new Date('2024-02-01T00:00:00.000Z'));
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const repo = new InMemoryRepo();
    await repo.plans.put(plan);
    await repo.subscriptions.put(mkSub());
    const provider = new FakeSelfSchedulingProvider();
    provider.nextChargeStatus = 'failed';
    await scheduler.tick({ provider, repo, policy: resolvePolicy(), ledger, clock, ids: new SequentialIdGen('id_') });
    expect((await repo.payments.list()).map((p) => [p.status, p.period?.start.toISOString()])).toEqual([['failed', '2024-02-01T00:00:00.000Z']]);
    expect((await repo.subscriptions.get('sub_1'))?.status).toBe('past_due');
  });
});
