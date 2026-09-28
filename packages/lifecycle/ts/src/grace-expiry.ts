import { GRACE_EXPIRY_END_REASON } from 'boilpayment-core';
import type {
  Clock,
  LedgerEntry,
  LedgerStore,
  Subscription,
} from 'boilpayment-core';

export interface EndGraceExpiryInput {
  sub: Subscription;
  currentGrant: LedgerEntry;
  ledger: LedgerStore;
  clock: Clock;
}

/** SB-08 — preemptively cap every dated prior-period grant once the paid-period grant exists. */
export async function endGraceExpiry(input: EndGraceExpiryInput): Promise<void> {
  const { sub, currentGrant, ledger, clock } = input;
  const paidPeriodStart = currentGrant.reference.periodStart;
  if (paidPeriodStart === undefined) return;
  const entries = await ledger.entries(sub.customerId);
  const priorGrants = entries.filter((entry) => entry.kind === 'grant'
    && entry.source === 'subscription'
    && entry.reference.subscriptionId === sub.id
    && entry.reference.periodStart !== undefined
    && entry.expiresAt !== null
    && entry.reference.periodStart.getTime() < paidPeriodStart.getTime()
  );
  const endedAt = clock.now();
  for (const grant of priorGrants) {
    await ledger.append({
      customerId: sub.customerId,
      pool: grant.pool,
      kind: 'adjust',
      amount: 0,
      unitPriceMinor: null,
      currency: grant.currency,
      expiresAt: endedAt,
      source: 'subscription',
      reference: { ...grant.reference, grantId: grant.id },
      idempotencyKey: `adjust:grace-expiry-end:${sub.id}:${grant.id}`,
      actor: 'system',
      reason: GRACE_EXPIRY_END_REASON,
    });
  }
}
