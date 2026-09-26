// spec: packages/credits/spec/credits.pseudo.md — EC:B1 B2
import { Clock, LedgerEntry, LedgerStore, Period, Policy, Subscription } from 'boilpayment-core';

export interface RolloverInput {
  sub: Subscription;
  policy: Policy;
  ledger: LedgerStore;
  clock: Clock;
  newPeriod: Period;
}

export interface RolloverResult {
  entries: LedgerEntry[];
  banked: number;
  expired: number;
}

const NO_OP: RolloverResult = { entries: [], banked: 0, expired: 0 };

// EC:B1 B2 — carries unexpired balance of the previous period's subscription grant into the
// new period when policy.credits.rollover === 'banked', capped by bank_cap.
export async function rolloverOnRenewal(input: RolloverInput): Promise<RolloverResult> {
  const { sub, policy, ledger, clock, newPeriod } = input;

  if (policy.credits.rollover === 'none') {
    // previous grant already carries expiresAt = old period.end and lapses on its own
    return NO_OP;
  }
  if (policy.credits.rollover === 'full') {
    // previous grant has expiresAt = null; nothing to move
    return NO_OP;
  }

  // 'banked'
  const now = clock.now();
  const all = await ledger.entries(sub.customerId);

  const previousGrants = all.filter(
    (e) =>
      e.kind === 'grant' &&
      e.pool === 'paid' &&
      e.source === 'subscription' &&
      e.reference.subscriptionId === sub.id &&
      e.expiresAt !== null &&
      e.expiresAt <= newPeriod.start,
  );

  let remaining = 0;
  for (const g of previousGrants) {
    const used = all
      .filter((e) => (e.kind === 'consume' || e.kind === 'revoke') && e.reference.grantId === g.id)
      .reduce((sum, e) => sum + e.amount, 0); // consume/revoke amounts are negative
    remaining += Math.max(0, g.amount + used);
  }

  if (remaining <= 0) return NO_OP;

  const bankCap = policy.credits.bankCap; // required non-null when rollover='banked' (validated in policy.ts)
  // EC:B2 bankReset='on_renewal' (default) is satisfied by recomputing the *currently active*
  // banked total every renewal, as below. 'never'/'on_cancel' would force banked credits back to
  // zero at a different trigger (e.g. lifecycle.cancel) — out of scope here, see spec note.
  const alreadyBanked = all
    .filter(
      (e) =>
        e.kind === 'grant' &&
        e.pool === 'paid' &&
        e.source === 'rollover' &&
        (e.expiresAt === null || e.expiresAt > now),
    )
    .reduce((sum, e) => sum + e.amount, 0);

  const capRemaining = bankCap === null ? remaining : Math.max(0, bankCap - alreadyBanked);
  const banked = Math.min(remaining, capRemaining);
  const expired = remaining - banked;

  const entries: LedgerEntry[] = [];

  // EC:B1 — the excess over bankCap is NOT written as an entry: the source grants lapse on their own
  // expiresAt, and an unattributed 'expire' row would be double-counted by the ledger (found by e2e).

  if (banked > 0) {
    const { entry } = await ledger.append({
      customerId: sub.customerId,
      pool: 'paid',
      kind: 'grant',
      amount: banked,
      unitPriceMinor: null,
      currency: null,
      expiresAt: newPeriod.end,
      source: 'rollover',
      reference: { subscriptionId: sub.id, periodStart: newPeriod.start },
      idempotencyKey: `rollover:${sub.id}:${newPeriod.start.toISOString()}`,
      actor: 'system',
      reason: null,
    });
    entries.push(entry);
  }

  return { entries, banked, expired };
}
