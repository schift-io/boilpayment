// Local helpers. EC:G2 proration_ratio itself lives in `core` (shared, canonical) — re-exported
// here so evaluate.ts has one import surface; not duplicated.
import type { LedgerEntry, Payment, RefundRounding, Repo } from 'boilpayment-core';
import { roundHalfAwayFromZero } from 'boilpayment-core';

export { prorationRatio } from 'boilpayment-core';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days elapsed from `from` to `to` (floor). */
export function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS);
}

/** EC:D4 — rounding direction for amount → credits conversion. */
export function applyRounding(raw: number, rounding: RefundRounding): number {
  if (rounding === 'ceil_credits') return Math.ceil(raw);
  if (rounding === 'round_credits') return roundHalfAwayFromZero(raw); // EC:J9 same .5 rule as Python
  return Math.floor(raw);
}

/** EC:B8 — grant-weighted average unit price across a set of grant ledger entries. */
export function weightedAvgUnitPrice(grants: LedgerEntry[]): number {
  let totalAmount = 0;
  let totalValue = 0;
  for (const g of grants) {
    totalAmount += g.amount;
    totalValue += g.amount * (g.unitPriceMinor ?? 0);
  }
  return totalAmount > 0 ? totalValue / totalAmount : 0;
}

/**
 * EC:A76 — a fully refunded upgrade charge puts the subscription back where the upgrade found it: the
 * old plan, period and anchor (the refund took the upgrade's money and credits back, so it keeps no
 * plan either). Only while the upgraded plan is still the current one; a partial refund changes nothing.
 */
export async function revertRefundedUpgrade(repo: Repo, payment: Payment): Promise<void> {
  if (payment.status !== 'refunded' || !payment.subscriptionId) return;
  const up = (payment.raw as { boilpaymentUpgrade?: Record<string, unknown> } | undefined)?.boilpaymentUpgrade;
  if (!up || typeof up.fromPlanId !== 'string' || typeof up.fromPeriodStart !== 'string' || typeof up.fromPeriodEnd !== 'string') return;
  const sub = await repo.subscriptions.get(payment.subscriptionId);
  if (!sub || sub.planId !== up.planId) return;
  await repo.subscriptions.put({
    ...sub, planId: up.fromPlanId, scheduledPlanId: null,
    currentPeriod: { start: new Date(up.fromPeriodStart), end: new Date(up.fromPeriodEnd) },
    anchorDay: typeof up.fromAnchorDay === 'number' ? up.fromAnchorDay : sub.anchorDay,
  });
}
