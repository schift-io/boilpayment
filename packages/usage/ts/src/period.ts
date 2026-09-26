// EC:C2 — previous-period approximation. See spec/usage.pseudo.md design note:
// core has no shared period-math helper (that lives in `lifecycle.period`,
// built concurrently, not imported here). Contract-change proposal: move a
// `period.previous(period)` helper into `core` so this doesn't get re-derived.
import type { Period } from '@schift/payment-kit-core';

export function previousPeriodStart(period: Period): Date {
  const lengthMs = period.end.getTime() - period.start.getTime();
  return new Date(period.start.getTime() - lengthMs);
}

export function hoursBetween(a: Date, b: Date): number {
  return Math.abs(b.getTime() - a.getTime()) / (1000 * 60 * 60);
}
