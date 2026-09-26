// spec: packages/credits/spec/credits.pseudo.md — EC:B3
import {
  Clock,
  ConsumeOrder,
  ConsumeResult,
  InsufficientBalanceError,
  LedgerReference,
  LedgerStore,
  Policy,
  Pool,
} from '@schift/payment-kit-core';

const POOL_ORDER: Record<ConsumeOrder, Pool[]> = {
  expiring_first: ['paid', 'promo', 'trial'],
  promo_first_then_expiring: ['promo', 'trial', 'paid'],
  paid_first: ['paid', 'trial', 'promo'],
};

export interface ConsumeCreditsInput {
  customerId: string;
  amount: number;
  policy: Policy;
  ledger: LedgerStore;
  clock: Clock;
  idempotencyKey: string;
  reference?: LedgerReference;
  reason?: string;
  actor?: string;
  /** EC:L5 — optional delivery-scoped id, merged into `meta.correlationId` (never overwrites one
   *  already set on `reference`). */
  correlationId?: string;
}

// EC:B3 — maps policy.credits.consumeOrder to a pool order, delegates the atomic
// expiring-first-within-pool draw and negative-balance handling (EC:B4/B5/B14) to LedgerStore.consume.
export async function consume(input: ConsumeCreditsInput): Promise<ConsumeResult> {
  const { customerId, amount, policy, ledger, clock, idempotencyKey, reference = {}, reason, actor = 'app', correlationId } = input;
  const poolOrder = POOL_ORDER[policy.credits.consumeOrder];

  const result = await ledger.consume({
    customerId,
    poolOrder,
    amount,
    idempotencyKey,
    meta: { ...reference, reason, actor, correlationId: reference.correlationId ?? correlationId },
    now: clock.now(),
    negativeBalance: policy.credits.negativeBalance,
    negativeFloor: policy.credits.negativeFloor,
  });

  if (!result.ok && policy.credits.negativeBalance === 'block') {
    throw new InsufficientBalanceError(result.shortfall);
  }

  return result;
}
