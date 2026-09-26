// EC:C2 C9 — see spec/usage.pseudo.md. Regression for audit gap #3: usage that lands inside the
// late-report window AFTER closePeriod() ran was never billed.
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, FixedClock, InMemoryRepo, SequentialIdGen } from '@schift/payment-kit-core';
import { closePeriod } from '../src/closePeriod.js';
import { record } from '../src/record.js';
import { resettlePeriod } from '../src/resettlePeriod.js';
import { mkSub } from './fixtures.js';

const BILLED = {
  ...DEFAULT_POLICY,
  usage: { ...DEFAULT_POLICY.usage, includedQuantity: 100, overage: 'bill_overage' as const, overageUnitPriceMinor: 5, lateReportWindowHours: 48 },
};

function harness(now = '2026-06-01T06:00:00Z') {
  return { ids: new SequentialIdGen('id_'), clock: new FixedClock(new Date(now)), repo: new InMemoryRepo() };
}

/** A usage_periods table like schema-postgres has; core's Repo does not declare one (duck-typed). */
function withUsagePeriods(repo: InMemoryRepo) {
  const rows: { subscriptionId: string; periodStart: Date; total: number }[] = [];
  return Object.assign(Object.create(repo) as InMemoryRepo, {
    usagePeriods: {
      async put(row: { subscriptionId: string; periodStart: Date; total: number }) {
        const i = rows.findIndex((r) => r.subscriptionId === row.subscriptionId && r.periodStart.getTime() === row.periodStart.getTime());
        if (i >= 0) rows[i] = row; else rows.push(row);
        return row;
      },
      async list(filter: { subscriptionId?: string; periodStart?: Date }) {
        return rows.filter((r) => (!filter.subscriptionId || r.subscriptionId === filter.subscriptionId)
          && (!filter.periodStart || r.periodStart.getTime() === filter.periodStart.getTime()));
      },
    },
    rows,
  });
}

describe('EC:C2 C9 usage.resettlePeriod — late usage billed after the period closed', () => {
  it('EC:C9 bills usage that arrived after closePeriod (audit gap #3 regression)', async () => {
    const { ids, clock, repo } = harness();
    const sub = mkSub();
    // 120 units before the close -> billed at close
    await record({ event: { customerId: sub.customerId, meter: 'api', quantity: 120, occurredAt: new Date('2026-05-20T00:00:00Z'), idempotencyKey: 'e1' }, sub, policy: BILLED, repo, clock, ids });
    const closed = await closePeriod({ sub, policy: BILLED, repo, clock, ids, currency: 'USD' });
    expect(closed).toEqual({ total: 120, overage: 20, overageAmount: { amountMinor: 100, currency: 'USD' } });

    // 30 more units for the SAME period land after the close, inside the 48h window
    await record({ event: { customerId: sub.customerId, meter: 'api', quantity: 30, occurredAt: new Date('2026-05-31T23:00:00Z'), idempotencyKey: 'e2' }, sub, policy: BILLED, repo, clock, ids });

    const r = await resettlePeriod({ sub, periodStart: sub.currentPeriod.start, policy: BILLED, repo, clock, settledTotal: closed.total, currency: 'KRW' });
    expect(r.total).toBe(150);
    expect(r.newlyReported).toBe(30); // silently dropped before the fix
    expect(r.additionalOverage).toBe(30);
    expect(r.additionalOverageAmount).toEqual({ amountMinor: 150, currency: 'KRW' });
    expect(r.windowOpen).toBe(true);
  });

  it('EC:C9 only the part above includedQuantity is newly billable', async () => {
    const { ids, clock, repo } = harness();
    const sub = mkSub();
    await record({ event: { customerId: sub.customerId, meter: 'api', quantity: 80, occurredAt: new Date('2026-05-20T00:00:00Z'), idempotencyKey: 'e1' }, sub, policy: BILLED, repo, clock, ids });
    await record({ event: { customerId: sub.customerId, meter: 'api', quantity: 40, occurredAt: new Date('2026-05-31T23:00:00Z'), idempotencyKey: 'e2' }, sub, policy: BILLED, repo, clock, ids });
    // settled 80 (under the 100 included) -> total 120 -> only 20 units cross the quota
    const r = await resettlePeriod({ sub, periodStart: sub.currentPeriod.start, policy: BILLED, repo, clock, settledTotal: 80, currency: 'USD' });
    expect(r.newlyReported).toBe(40);
    expect(r.additionalOverage).toBe(20);
    expect(r.additionalOverageAmount).toEqual({ amountMinor: 100, currency: 'USD' });
  });

  it('EC:C9 is idempotent through the duck-typed usagePeriods table: a replay reports nothing new', async () => {
    const { ids, clock } = harness();
    const base = new InMemoryRepo();
    const repo = withUsagePeriods(base);
    const sub = mkSub();
    await record({ event: { customerId: sub.customerId, meter: 'api', quantity: 120, occurredAt: new Date('2026-05-20T00:00:00Z'), idempotencyKey: 'e1' }, sub, policy: BILLED, repo, clock, ids });
    await closePeriod({ sub, policy: BILLED, repo, clock, ids, currency: 'USD' }); // writes the settled row
    await record({ event: { customerId: sub.customerId, meter: 'api', quantity: 30, occurredAt: new Date('2026-05-31T23:00:00Z'), idempotencyKey: 'e2' }, sub, policy: BILLED, repo, clock, ids });

    const first = await resettlePeriod({ sub, periodStart: sub.currentPeriod.start, policy: BILLED, repo, clock, currency: 'USD' });
    expect(first).toMatchObject({ settledTotal: 120, total: 150, newlyReported: 30, additionalOverage: 30 });

    const second = await resettlePeriod({ sub, periodStart: sub.currentPeriod.start, policy: BILLED, repo, clock, currency: 'USD' });
    expect(second).toMatchObject({ settledTotal: 150, total: 150, newlyReported: 0, additionalOverage: 0 });
    expect(second.additionalOverageAmount).toBeNull();
  });

  it('EC:C2 windowOpen is false once late_report_window_hours has passed', async () => {
    const { ids, clock, repo } = harness('2026-06-04T00:00:00Z'); // > 48h after the period start+window
    const sub = mkSub();
    await record({ event: { customerId: sub.customerId, meter: 'api', quantity: 120, occurredAt: new Date('2026-05-20T00:00:00Z'), idempotencyKey: 'e1' }, sub, policy: BILLED, repo, clock, ids });
    const r = await resettlePeriod({ sub, periodStart: sub.currentPeriod.start, policy: BILLED, repo, clock, settledTotal: 120, currency: 'USD' });
    expect(r.windowOpen).toBe(false);
    expect(r.newlyReported).toBe(0);
  });

  it('EC:C9 throws when neither settledTotal nor a usagePeriods table is available', async () => {
    const { ids, clock, repo } = harness();
    void ids;
    const sub = mkSub();
    await expect(resettlePeriod({ sub, periodStart: sub.currentPeriod.start, policy: BILLED, repo, clock })).rejects.toThrow(/settledTotal is required/);
  });
});
