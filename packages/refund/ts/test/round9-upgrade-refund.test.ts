// EC:A76 (round-9 A9-5) — a fully refunded upgrade charge puts the subscription back. Mirrors test_round9_upgrade_refund.py.
import { describe, expect, it } from 'vitest';
import { InMemoryRepo } from 'boilpayment-core';
import type { Payment, Subscription } from 'boilpayment-core';
import { revertRefundedUpgrade } from '../src/index.js';

const upgraded: Subscription = {
  id: 's1', customerId: 'c1', planId: 'pro', provider: 'portone', providerRef: null, status: 'active',
  currentPeriod: { start: new Date('2026-04-11T00:00:00Z'), end: new Date('2026-05-11T00:00:00Z') }, anchorDay: 11,
  cancelAtPeriodEnd: false, graceUntil: null, billingKey: 'bk1', scheduledPlanId: null, currency: 'KRW', version: 0, createdAt: new Date('2026-04-01T00:00:00Z'),
};
const row = (status: Payment['status']): Payment => ({
  id: 'pay_up_1', customerId: 'c1', provider: 'portone', providerRef: 'ord_x', subscriptionId: 's1', amount: { amountMinor: 13300, currency: 'KRW' },
  status, kind: 'subscription', period: null, occurredAt: new Date('2026-04-11T00:00:00Z'), failure: null, cashReceipt: null,
  raw: { boilpaymentUpgrade: { chargeKey: 'k', planId: 'pro', fromPlanId: 'basic', fromPeriodStart: '2026-04-01T00:00:00.000Z', fromPeriodEnd: '2026-05-01T00:00:00.000Z', fromAnchorDay: 1 } },
});

describe('[EC:A76] revertRefundedUpgrade', () => {
  it('a full refund restores the old plan, period and anchor', async () => {
    const repo = new InMemoryRepo();
    await repo.subscriptions.put(upgraded);
    await revertRefundedUpgrade(repo, row('refunded'));
    const sub = await repo.subscriptions.get('s1');
    expect([sub?.planId, sub?.currentPeriod, sub?.anchorDay]).toEqual(['basic', { start: new Date('2026-04-01T00:00:00Z'), end: new Date('2026-05-01T00:00:00Z') }, 1]);
  });

  it('a partial refund, or a plan changed since, changes nothing', async () => {
    const repo = new InMemoryRepo();
    await repo.subscriptions.put(upgraded);
    await revertRefundedUpgrade(repo, row('partially_refunded'));
    expect((await repo.subscriptions.get('s1'))?.planId).toBe('pro');
    await repo.subscriptions.put({ ...(await repo.subscriptions.get('s1'))!, planId: 'max' });
    await revertRefundedUpgrade(repo, row('refunded'));
    expect((await repo.subscriptions.get('s1'))?.planId).toBe('max');
  });
});

describe('[EC:A80] revertRefundedUpgrade after a renewal', () => {
  it('a refund after the next renewal keeps the renewed period (no second bill for it)', async () => {
    const repo = new InMemoryRepo();
    const renewed = { ...upgraded, currentPeriod: { start: new Date('2026-05-11T00:00:00Z'), end: new Date('2026-06-11T00:00:00Z') } };
    await repo.subscriptions.put(renewed);
    await revertRefundedUpgrade(repo, row('refunded'));
    const sub = await repo.subscriptions.get('s1');
    expect([sub?.planId, sub?.currentPeriod]).toEqual(['pro', renewed.currentPeriod]);
  });
});
