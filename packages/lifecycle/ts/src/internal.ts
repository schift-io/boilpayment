// Shared helpers, not part of the public spec surface.
import { Clock, LedgerEntry, LedgerReference, LedgerStore, PaymentKitError, PaymentProvider, Plan, PlanPrice, Pool, ProviderName, Subscription } from 'boilpayment-core';

export function resolvePriceRef(plan: Plan, provider: ProviderName, currency?: string | null): string {
  // EC:A28 A33 — a subscription with a currency only ever gets a price ref in that currency; a plan
  // without a price in it is refused (never a silent switch to another currency's price).
  if (currency) {
    const price = plan.prices.find((p) => p.currency === currency);
    if (!price) throw new PaymentKitError(`plan ${plan.id} has no price in ${currency}`, 'plan_price_missing', { planId: plan.id, currency });
    return price.providerPriceRefs?.[provider] ?? plan.id;
  }
  const withRef = plan.prices.find((p) => p.providerPriceRefs?.[provider]);
  return withRef?.providerPriceRefs?.[provider] ?? plan.id;
}

/** EC:A29 — the plan a renewal moves the subscription into: a scheduled change applies at renewal. */
export function renewalPlanId(sub: Pick<Subscription, 'planId' | 'scheduledPlanId'>): string {
  return sub.scheduledPlanId ?? sub.planId;
}

/**
 * EC:A28 — the plan price a subscription is charged: the one in its currency. A subscription
 * written before `currency` existed falls back to the first price (previous behaviour). Returns null
 * when the plan has no usable price, so the caller refuses the charge instead of switching currency.
 */
export function priceForSubscription(plan: Plan, sub: Pick<Subscription, 'currency'>): PlanPrice | null {
  if (sub.currency) return plan.prices.find((p) => p.currency === sub.currency) ?? null;
  return plan.prices[0] ?? null;
}

/** EC:A28 — priceForSubscription, throwing `plan_price_missing` when there is none. */
export function requirePriceForSubscription(plan: Plan, sub: Pick<Subscription, 'currency'>): PlanPrice {
  const price = priceForSubscription(plan, sub);
  if (!price) throw new PaymentKitError(`plan ${plan.id} has no price in ${sub.currency ?? 'any currency'}`, 'plan_price_missing', { planId: plan.id, currency: sub.currency ?? null });
  return price;
}

/**
 * EC:L5 — scope a provider call to a correlationId via the duck-typed `withCorrelationId` (not
 * part of the `PaymentProvider` interface — mirrors `packages/webhook/ts/src/process.ts`'s
 * identical pattern for webhook-driven provider calls). Falls back to the bare provider when
 * `correlationId` is omitted or the provider doesn't implement `withCorrelationId`.
 */
export function scopeProvider(provider: PaymentProvider, correlationId?: string): PaymentProvider {
  if (!correlationId) return provider;
  const withCorrelation = provider as PaymentProvider & { withCorrelationId?: unknown };
  return typeof withCorrelation.withCorrelationId === 'function'
    ? (withCorrelation as PaymentProvider & { withCorrelationId(id: string): PaymentProvider }).withCorrelationId(correlationId)
    : provider;
}

/** Revoke the full available balance of a single pool (used for trial-cancel / trial-convert-discard). */
export async function revokePoolBalance(
  pool: Pool,
  ledger: LedgerStore,
  clock: Clock,
  customerId: string,
  reference: LedgerReference,
  idempotencyKey: string,
  reason: string,
): Promise<LedgerEntry | null> {
  const balance = await ledger.balance(customerId, pool, clock.now());
  if (balance.available <= 0) return null;
  const { entry } = await ledger.append({
    customerId,
    pool,
    kind: 'revoke',
    amount: -balance.available,
    unitPriceMinor: null,
    currency: null,
    expiresAt: null,
    source: 'trial',
    reference,
    idempotencyKey,
    actor: 'system',
    reason,
  });
  return entry;
}
