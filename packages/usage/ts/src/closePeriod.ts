// EC:C9 — see spec/usage.pseudo.md
import type { Clock, IdGen, Money, PaymentProvider, Policy, Repo, Subscription, UsageEvent } from 'boilpayment-core';
import { billingCurrency } from './billingCurrency.js';

export interface ClosePeriodInput {
  sub: Subscription;
  policy: Policy;
  repo: Repo;
  provider?: PaymentProvider | null;
  clock: Clock;
  ids: IdGen;
  /** Selected billing currency; inferred only for a single-currency plan. */
  currency?: string;
}

export interface ClosePeriodResult {
  total: number;
  overage: number;
  overageAmount: Money | null;
}

export async function closePeriod(input: ClosePeriodInput): Promise<ClosePeriodResult> {
  const { sub, policy, repo, clock } = input;
  const events = await repo.usageEvents.list({ customerId: sub.customerId } as Partial<UsageEvent>);
  const periodEvents = events.filter((e) => e.periodStart.getTime() === sub.currentPeriod.start.getTime());
  const total = periodEvents.reduce((sum, e) => sum + e.quantity, 0);
  const overage = Math.max(0, total - policy.usage.includedQuantity);

  let overageAmount: Money | null = null;
  if (overage > 0 && policy.usage.overage === 'bill_overage' && policy.usage.overageUnitPriceMinor !== null) {
    overageAmount = { amountMinor: overage * policy.usage.overageUnitPriceMinor, currency: await billingCurrency(repo, sub.planId, input.currency) };
  }

  // Repo (core §3.4) has no `usagePeriods` table. Best-effort: use one if a
  // concrete Repo implementation duck-types it in, otherwise just return.
  const maybeRepo = repo as unknown as { usagePeriods?: { put(row: unknown): Promise<unknown> } };
  if (maybeRepo.usagePeriods) {
    await maybeRepo.usagePeriods.put({
      subscriptionId: sub.id,
      periodStart: sub.currentPeriod.start,
      total,
      overage,
      closedAt: clock.now(),
    });
  }

  return { total, overage, overageAmount };
}
