// EC:C9 — see spec/usage.pseudo.md
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, FixedClock, InMemoryRepo, SequentialIdGen } from '@schift/payment-kit-core';
import { closePeriod } from '../src/closePeriod.js';
import { record } from '../src/record.js';
import { mkSub } from './fixtures.js';

function harness() {
  const ids = new SequentialIdGen('id_');
  const clock = new FixedClock(new Date('2026-05-20T00:00:00Z'));
  const repo = new InMemoryRepo();
  return { ids, clock, repo };
}

describe('EC:C9 usage.closePeriod — aggregate + overage bill', () => {
  it('EC:C9 overageAmount is null when total is within includedQuantity (overage=0), regardless of overage mode', async () => {
    const { ids, clock, repo } = harness();
    const sub = mkSub();
    const policy = { ...DEFAULT_POLICY, usage: { ...DEFAULT_POLICY.usage, includedQuantity: 5, overage: 'bill_overage' as const, overageUnitPriceMinor: 250 } };
    await record({ event: { customerId: sub.customerId, meter: 'api_call', quantity: 4, occurredAt: new Date('2026-05-02T00:00:00Z'), idempotencyKey: 'e1' }, sub, policy, repo, clock, ids });

    const result = await closePeriod({ sub, policy, repo, clock, ids });

    expect(result).toEqual({ total: 4, overage: 0, overageAmount: null });
  });

  it('EC:C9 overageAmount is null when overage>0 but the policy mode is NOT bill_overage', async () => {
    const { ids, clock, repo } = harness();
    const sub = mkSub();
    const policy = { ...DEFAULT_POLICY, usage: { ...DEFAULT_POLICY.usage, includedQuantity: 5, overage: 'hard_block' as const } };
    await record({ event: { customerId: sub.customerId, meter: 'api_call', quantity: 8, occurredAt: new Date('2026-05-02T00:00:00Z'), idempotencyKey: 'e2' }, sub, policy, repo, clock, ids });

    const result = await closePeriod({ sub, policy, repo, clock, ids });

    expect(result).toEqual({ total: 8, overage: 3, overageAmount: null });
  });

  it('EC:C9 bills overage in the configured plan currency', async () => {
    const { ids, clock, repo } = harness();
    const sub = mkSub();
    await repo.plans.put({ id: sub.planId, name: 'Pro', interval: 'month', creditsPerPeriod: 0, usageIncluded: 5, trialDays: 0, prices: [{ amountMinor: 10000, currency: 'KRW' }] });
    const policy = { ...DEFAULT_POLICY, usage: { ...DEFAULT_POLICY.usage, includedQuantity: 5, overage: 'bill_overage' as const, overageUnitPriceMinor: 250 } };
    await record({ event: { customerId: sub.customerId, meter: 'api_call', quantity: 8, occurredAt: new Date('2026-05-02T00:00:00Z'), idempotencyKey: 'e3' }, sub, policy, repo, clock, ids });

    const result = await closePeriod({ sub, policy, repo, clock, ids });

    expect(result).toEqual({ total: 8, overage: 3, overageAmount: { amountMinor: 750, currency: 'KRW' } });
  });

  it('EC:C9 total sums ALL meters for the period together -- closePeriod has no per-meter breakdown (repo.usageEvents.list is filtered only by customerId, then periodStart)', async () => {
    const { ids, clock, repo } = harness();
    const sub = mkSub();
    const policy = { ...DEFAULT_POLICY, usage: { ...DEFAULT_POLICY.usage, includedQuantity: 5, overage: 'bill_overage' as const, overageUnitPriceMinor: 250 } };
    await record({ event: { customerId: sub.customerId, meter: 'api_call', quantity: 3, occurredAt: new Date('2026-05-02T00:00:00Z'), idempotencyKey: 'e4a' }, sub, policy, repo, clock, ids });
    await record({ event: { customerId: sub.customerId, meter: 'storage_gb', quantity: 6, occurredAt: new Date('2026-05-03T00:00:00Z'), idempotencyKey: 'e4b' }, sub, policy, repo, clock, ids });

    const result = await closePeriod({ sub, policy, repo, clock, ids, currency: 'USD' });

    expect(result).toEqual({ total: 9, overage: 4, overageAmount: { amountMinor: 1000, currency: 'USD' } });
  });

  it('EC:C9 events attributed to a DIFFERENT periodStart (e.g. late-attributed to the previous period) are excluded from the total', async () => {
    const ids = new SequentialIdGen('id_');
    const clock = new FixedClock(new Date('2026-05-02T00:00:00Z')); // 24h after currentPeriod.start -- within the 48h late-report window
    const repo = new InMemoryRepo();
    const sub = mkSub();
    const policy = { ...DEFAULT_POLICY, usage: { ...DEFAULT_POLICY.usage, includedQuantity: 5, overage: 'hard_block' as const } };
    // received while still within the late-report window -> attributed to the PREVIOUS period, excluded from this close
    await record({ event: { customerId: sub.customerId, meter: 'api_call', quantity: 100, occurredAt: new Date('2026-04-10T00:00:00Z'), idempotencyKey: 'e5b' }, sub, policy, repo, clock, ids });
    // on-time, counts
    await record({ event: { customerId: sub.customerId, meter: 'api_call', quantity: 4, occurredAt: new Date('2026-05-02T00:00:00Z'), idempotencyKey: 'e5a' }, sub, policy, repo, clock, ids });

    clock.advance(18 * 24 * 60 * 60 * 1000); // close the period later; doesn't change already-recorded periodStart values
    const result = await closePeriod({ sub, policy, repo, clock, ids });

    expect(result.total).toBe(4); // the 100-qty late event is NOT counted -- it belongs to the previous period
  });
});
