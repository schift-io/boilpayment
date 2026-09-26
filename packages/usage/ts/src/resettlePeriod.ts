// EC:C2 C9 — see spec/usage.pseudo.md
import type { Clock, Money, Policy, Repo, Subscription, UsageEvent } from '@schift/payment-kit-core';
import { billingCurrency } from './billingCurrency.js';

export interface ResettlePeriodInput {
  sub: Subscription;
  /** Start of the ALREADY CLOSED period to re-settle. */
  periodStart: Date;
  policy: Policy;
  repo: Repo;
  clock: Clock;
  /**
   * Quantity that was billed when the period was closed. Falls back to the `usagePeriods` row a
   * concrete Repo may duck-type in (schema-postgres has the table); required when it does not.
   */
  settledTotal?: number;
  /** Selected billing currency; inferred only for a single-currency plan. */
  currency?: string;
}

export interface ResettlePeriodResult {
  total: number;
  settledTotal: number;
  /** Usage that arrived after the period was closed (0 on a replay). */
  newlyReported: number;
  additionalOverage: number;
  additionalOverageAmount: Money | null;
  /** False once `late_report_window_hours` after the period end has passed. */
  windowOpen: boolean;
}

type UsagePeriodRow = { subscriptionId: string; periodStart: Date; total: number };
type MaybeUsagePeriods = {
  usagePeriods?: {
    put(row: unknown): Promise<unknown>;
    list?(filter: Record<string, unknown>): Promise<UsagePeriodRow[]>;
  };
};

/**
 * EC:C2 C9 — bill usage that landed in a period AFTER that period was closed.
 *
 * `record()` attributes an event to the previous period while it is inside
 * `policy.usage.late_report_window_hours`, but `closePeriod()` has already computed its total by
 * then, so without this call that usage is never invoiced (silent revenue loss). Idempotent: the
 * settled total is advanced to the recomputed total, so a second call reports `newlyReported: 0`.
 */
export async function resettlePeriod(input: ResettlePeriodInput): Promise<ResettlePeriodResult> {
  const { sub, periodStart, policy, repo, clock } = input;
  const table = (repo as unknown as MaybeUsagePeriods).usagePeriods;

  let settledTotal = input.settledTotal;
  if (settledTotal === undefined && table?.list) {
    const rows = await table.list({ subscriptionId: sub.id, periodStart });
    settledTotal = rows[0]?.total;
  }
  if (settledTotal === undefined) {
    throw new Error(
      'usage.resettlePeriod: settledTotal is required when the Repo has no usagePeriods table to read it from',
    );
  }

  const events = await repo.usageEvents.list({ customerId: sub.customerId } as Partial<UsageEvent>);
  const total = events
    .filter((e) => e.periodStart.getTime() === periodStart.getTime())
    .reduce((sum, e) => sum + e.quantity, 0);

  const newlyReported = Math.max(0, total - settledTotal);
  const included = policy.usage.includedQuantity;
  const additionalOverage = Math.max(0, total - included) - Math.max(0, settledTotal - included);

  let additionalOverageAmount: Money | null = null;
  if (additionalOverage > 0 && policy.usage.overage === 'bill_overage' && policy.usage.overageUnitPriceMinor !== null) {
    additionalOverageAmount = {
      amountMinor: additionalOverage * policy.usage.overageUnitPriceMinor,
      currency: await billingCurrency(repo, sub.planId, input.currency),
    };
  }

  // `record()` can attribute to this period until its END + the late-report window. Periods are
  // contiguous, so a closed earlier period ends where the current one begins.
  const periodEnd = periodStart.getTime() === sub.currentPeriod.start.getTime()
    ? sub.currentPeriod.end
    : sub.currentPeriod.start;
  const windowEnd = new Date(periodEnd.getTime() + policy.usage.lateReportWindowHours * 3_600_000);
  const windowOpen = clock.now().getTime() < windowEnd.getTime();

  if (newlyReported > 0 && table) {
    await table.put({ subscriptionId: sub.id, periodStart, total, overage: Math.max(0, total - included), closedAt: clock.now() });
  }

  return { total, settledTotal, newlyReported, additionalOverage, additionalOverageAmount, windowOpen };
}
