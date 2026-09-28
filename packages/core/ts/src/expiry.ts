import type { LedgerEntry } from './types.js';

export const GRACE_EXPIRY_EXTENSION_REASON = 'SB-07 grace_expiry_extension';
export const GRACE_EXPIRY_RESTORE_REASON = 'SB-07 grace_expiry_restore';
export const PAID_PERIOD_PRESERVED_REASON = 'SB-07 paid_period_preserved';

// SB-07 — expiry changes are append-only ledger facts. A never-expiring grant stays that way;
// otherwise the latest linked grace extension wins without rewriting the original grant row.
export function effectiveGrantExpiry(grant: LedgerEntry, entries: readonly LedgerEntry[]): Date | null {
  if (grant.expiresAt === null) return null;
  let expiry = grant.expiresAt;
  for (const entry of entries) {
    if (
      entry.kind === 'adjust'
      && entry.amount === 0
      && entry.reason === GRACE_EXPIRY_EXTENSION_REASON
      && entry.reference.grantId === grant.id
      && entry.expiresAt !== null
      && entry.expiresAt.getTime() > expiry.getTime()
    ) {
      expiry = entry.expiresAt;
    }
  }
  return expiry;
}
