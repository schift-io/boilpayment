import type { LedgerEntry } from './types.js';

export const GRACE_EXPIRY_EXTENSION_REASON = 'SB-07 grace_expiry_extension';
export const GRACE_EXPIRY_RESTORE_REASON = 'SB-07 grace_expiry_restore';
export const PAID_PERIOD_PRESERVED_REASON = 'SB-07 paid_period_preserved';
export const GRACE_EXPIRY_END_REASON = 'SB-08 grace_expiry_end';

// SB-07/SB-08 — expiry changes are append-only ledger facts. A never-expiring grant stays that way.
// A dated grant extends to the latest grace marker, capped by the first recovery marker and never
// shortened below its original expiry.
export function effectiveGrantExpiry(grant: LedgerEntry, entries: readonly LedgerEntry[]): Date | null {
  if (grant.expiresAt === null) return null;
  let extendedExpiry = grant.expiresAt;
  let firstGraceEnd: Date | null = null;
  for (const entry of entries) {
    if (entry.kind !== 'adjust' || entry.amount !== 0 || entry.reference.grantId !== grant.id || entry.expiresAt === null) continue;
    if (entry.reason === GRACE_EXPIRY_EXTENSION_REASON && entry.expiresAt.getTime() > extendedExpiry.getTime()) {
      extendedExpiry = entry.expiresAt;
    }
    if (entry.reason === GRACE_EXPIRY_END_REASON &&
        (firstGraceEnd === null || entry.expiresAt.getTime() < firstGraceEnd.getTime())) firstGraceEnd = entry.expiresAt;
  }
  if (firstGraceEnd === null) return extendedExpiry;
  const cappedEnd = firstGraceEnd.getTime() < grant.expiresAt.getTime() ? grant.expiresAt : firstGraceEnd;
  return cappedEnd.getTime() < extendedExpiry.getTime() ? cappedEnd : extendedExpiry;
}
