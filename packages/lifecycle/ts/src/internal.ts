// Shared helpers, not part of the public spec surface.
import { Clock, LedgerEntry, LedgerReference, LedgerStore, PaymentProvider, Plan, Pool, ProviderName } from '@schift/payment-kit-core';

export function resolvePriceRef(plan: Plan, provider: ProviderName): string {
  const withRef = plan.prices.find((p) => p.providerPriceRefs?.[provider]);
  return withRef?.providerPriceRefs?.[provider] ?? plan.prices[0]?.providerPriceRefs?.[provider] ?? plan.id;
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
