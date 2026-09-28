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

/** OT-17 — reconstruct the paid value that priceCredits stored without requiring a schema change. */
export function totalGrantValueMinor(grants: LedgerEntry[]): number {
  let totalValue = 0;
  for (const g of grants) {
    const remainder = g.reason?.match(/^remainder_minor:(\d+)$/)?.[1];
    totalValue += g.amount * (g.unitPriceMinor ?? 0) + (remainder === undefined ? 0 : Number(remainder));
  }
  return totalValue;
}

/** EC:B8 OT-17 — grant-weighted average unit price, including the minor-unit remainder recorded at grant time. */
export function weightedAvgUnitPrice(grants: LedgerEntry[]): number {
  const totalAmount = grants.reduce((sum, grant) => sum + grant.amount, 0);
  const totalValue = totalGrantValueMinor(grants);
  return totalAmount > 0 ? totalValue / totalAmount : 0;
}

/** SB-11 — resolve only the append-only markers that assign upgrade delta grants to an anchor invoice. */
export function upgradeInvoiceAttributedGrantIds(entries: LedgerEntry[], paymentId: string): Set<string> {
  return new Set(entries
    .filter((entry) => entry.kind === 'adjust' && entry.reason === 'SB-11 upgrade_invoice_attribution'
      && entry.reference.paymentId === paymentId)
    .flatMap((entry) => entry.reference.grantId === undefined ? [] : [entry.reference.grantId]));
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
  // EC:A80 — once a renewal has started a period at or after the old period's end, that period was paid at
  // the upgraded price: putting the old period back would bill it again. Only the charge's credits come back.
  // (Compared with the stored period, not the payment time, which is the provider's clock.)
  if (sub.currentPeriod.start.getTime() >= new Date(up.fromPeriodEnd).getTime()) return;
  await repo.subscriptions.put({
    ...sub, planId: up.fromPlanId, scheduledPlanId: null,
    currentPeriod: { start: new Date(up.fromPeriodStart), end: new Date(up.fromPeriodEnd) },
    anchorDay: typeof up.fromAnchorDay === 'number' ? up.fromAnchorDay : sub.anchorDay,
  });
}
