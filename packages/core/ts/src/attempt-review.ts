// EC:A50 — whether a provider's record of an order is the renewal charge the kit asked for, and the
// review hold a person resolves when it is not. Lives in core because two paths settle an attempt row:
// the lifecycle's lookup (scheduler, dunning) and the webhook's self-scheduled renewal branch (EC:A45).
import type { Money, Notifier, Payment, Repo } from './types.js';

/**
 * A looked-up order settles an attempt only when it is the charge the kit asked for: same amount and
 * currency, same customer, and not refunded or disputed since. Anything else is a reason a person has
 * to look (the attempt is held: no grant, and nothing is charged for the period meanwhile).
 */
export function lookupMismatch(found: Payment, expected: { amount: Money | null; customerId: string; currency?: string | null }): string | null {
  if (found.status === 'refunded' || found.status === 'partially_refunded' || found.status === 'disputed') return `order_${found.status}`;
  const currency = expected.amount?.currency ?? expected.currency ?? null;
  if (currency && found.amount?.currency && found.amount.currency !== currency) return 'currency_mismatch';
  if (expected.amount && expected.amount.amountMinor > 0 && found.amount && found.amount.amountMinor !== expected.amount.amountMinor) return 'amount_mismatch';
  if (found.customerId && found.customerId !== expected.customerId) return 'customer_mismatch';
  return null;
}

/** An attempt a person has to look at: never charged, re-driven or granted by the kit. */
export function isUnderReview(row: Payment): boolean {
  return !!(row.raw as { boilpaymentReview?: unknown } | undefined)?.boilpaymentReview;
}

/** A row for a charge an earlier release made (orderId = the attempt key itself, EC:A39). */
export function isLegacyAttemptRow(row: Payment): boolean {
  return typeof (row.raw as { boilpaymentLegacyOrderId?: unknown } | undefined)?.boilpaymentLegacyOrderId === 'string';
}

/**
 * EC:A50 (A6-3) — the amount a looked-up order must match: what was sent under this attempt's key, i.e.
 * the row's own amount, never today's plan price (a price change or a scheduled downgrade since the send
 * held paid renewals). A legacy row's sent amount is unknown: null (only currency and customer are checked).
 */
export function expectedAttemptAmount(row: Payment): Money | null {
  if (isLegacyAttemptRow(row)) return null;
  return row.amount.amountMinor > 0 ? row.amount : null;
}

/** Hold `row` for a person (no grant, no charge, no re-drive) and tell them once. */
export async function holdAttemptForReview(repo: Repo, notifier: Notifier, row: Payment, found: Payment, reason: string): Promise<Payment> {
  const held: Payment = { ...row, raw: { ...(row.raw as object | undefined ?? {}), boilpaymentReview: {
    reason, status: found.status, amount: found.amount ?? null, customerId: found.customerId ?? null, providerRef: found.providerRef ?? null } } };
  await repo.payments.put(held);
  await notifier.send({ type: 'cs.needs_human', customerId: row.customerId, payload: {
    kind: 'attempt_lookup_mismatch', subscriptionId: row.subscriptionId, paymentId: row.id, reason } });
  return held;
}
