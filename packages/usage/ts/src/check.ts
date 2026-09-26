// EC:C1 EC:C5 EC:C6 EC:A14 EC:C8 — see spec/usage.pseudo.md
import type { Clock, ConsumeOrder, IdGen, LedgerStore, Policy, Pool, Repo, Subscription, UsageEvent } from 'boilpayment-core';

const POOL_ORDER: Record<ConsumeOrder, Pool[]> = {
  expiring_first: ['paid', 'promo', 'trial'],
  promo_first_then_expiring: ['promo', 'trial', 'paid'],
  paid_first: ['paid', 'trial', 'promo'],
};

export interface CheckInput {
  customerId: string;
  meter: string;
  quantity: number;
  sub: Subscription;
  policy: Policy;
  repo: Repo;
  ledger: LedgerStore;
  clock: Clock;
  ids?: IdGen;
  /** override for policy.usage.includedQuantity, e.g. plan.usageIncluded */
  includedQuantity?: number;
  /** override the auto-generated idempotency key used for the EC:C8 credit-conversion consume */
  idempotencyKey?: string;
}

export type CheckReason =
  | 'grace_block' | 'within_included' | 'hard_block' | 'soft_cap_notify' | 'bill_overage'
  | 'grace_block_overage' | 'credit_conversion' | 'credit_conversion_insufficient';

export interface CheckResult {
  allow: boolean;
  overage: number;
  reason: CheckReason;
  remaining: number;
  notify: 'usage.soft_cap' | null;
}

export async function check(input: CheckInput): Promise<CheckResult> {
  const { customerId, meter, quantity, sub, policy, repo, ledger, clock, ids, includedQuantity, idempotencyKey } = input;
  const included = includedQuantity ?? policy.usage.includedQuantity; // EC:C5

  // EC:A14 / EC:C6 — grace-period gating
  if (sub.status === 'past_due' && policy.dunning.usageDuringGrace === 'block') {
    return { allow: false, overage: 0, reason: 'grace_block', remaining: 0, notify: null };
  }
  const blockGraceOverage = sub.status === 'past_due' && policy.dunning.usageDuringGrace === 'allow_existing_only';

  // EC:C8 — credit-conversion hybrid replaces quota math entirely
  if (policy.usage.creditConversion) {
    const conv = policy.usage.creditConversion;
    const creditAmount = quantity * conv.creditsPerUnit;
    const key = idempotencyKey ?? `usage:check:${customerId}:${meter}:${(ids?.newId() ?? clock.now().toISOString())}`;
    const result = await ledger.consume({
      customerId,
      poolOrder: POOL_ORDER[policy.credits.consumeOrder],
      amount: creditAmount,
      idempotencyKey: key,
      meta: { reason: `usage:${meter}` },
      now: clock.now(),
      negativeBalance: policy.credits.negativeBalance,
      negativeFloor: policy.credits.negativeFloor,
    });
    if (result.ok) {
      return { allow: true, overage: 0, reason: 'credit_conversion', remaining: -result.shortfall, notify: null };
    }
    return { allow: false, overage: 0, reason: 'credit_conversion_insufficient', remaining: 0, notify: null };
  }

  // EC:C1 — quota + overage mode
  const periodEvents = await repo.usageEvents.list({ customerId, meter } as Partial<UsageEvent>);
  const periodUsage = periodEvents
    .filter((e) => e.periodStart.getTime() === sub.currentPeriod.start.getTime())
    .reduce((sum, e) => sum + e.quantity, 0);
  const projected = periodUsage + quantity;
  const overage = Math.max(0, projected - included);

  if (overage === 0) {
    return { allow: true, overage: 0, reason: 'within_included', remaining: Math.max(0, included - projected), notify: null };
  }
  const remaining = Math.max(0, included - periodUsage);

  switch (policy.usage.overage) {
    case 'hard_block':
      return { allow: false, overage, reason: 'hard_block', remaining, notify: null };
    case 'soft_cap_notify':
      if (blockGraceOverage) return { allow: false, overage, reason: 'grace_block_overage', remaining, notify: null };
      return { allow: true, overage, reason: 'soft_cap_notify', remaining, notify: 'usage.soft_cap' };
    case 'bill_overage':
      if (blockGraceOverage) return { allow: false, overage, reason: 'grace_block_overage', remaining, notify: null };
      return { allow: true, overage, reason: 'bill_overage', remaining, notify: null };
  }
}
