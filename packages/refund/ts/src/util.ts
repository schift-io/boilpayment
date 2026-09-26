// Local helpers. EC:G2 proration_ratio itself lives in `core` (shared, canonical) — re-exported
// here so evaluate.ts has one import surface; not duplicated.
import type { LedgerEntry, RefundRounding } from '@schift/payment-kit-core';

export { prorationRatio } from '@schift/payment-kit-core';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days elapsed from `from` to `to` (floor). */
export function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS);
}

/** EC:D4 — rounding direction for amount → credits conversion. */
export function applyRounding(raw: number, rounding: RefundRounding): number {
  if (rounding === 'ceil_credits') return Math.ceil(raw);
  if (rounding === 'round_credits') return Math.round(raw);
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
