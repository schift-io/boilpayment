// spec: packages/credits/spec/credits.pseudo.md — EC:A4 B13
import {
  Clock,
  ClawbackShortfall,
  InsufficientBalanceError,
  LedgerEntry,
  LedgerReference,
  LedgerSource,
  LedgerStore,
  Policy,
} from 'boilpayment-core';

export interface ClawbackInput {
  customerId: string;
  amount: number; // positive, requested revoke amount
  policy: Policy;
  ledger: LedgerStore;
  clock: Clock;
  reason: string;
  reference: LedgerReference;
  actor: string;
  idempotencyKey: string;
  // EC:A4 — caller supplies the resolved rule: downgrade passes policy.downgrade.clawbackShortfall.
  // EC:B13 — refund passes 'clamp_to_zero' or 'allow_negative' after it has already applied
  // policy.refund.revokeShortfall ('clamp_and_reduce_refund' reduces the *refund amount*, which is
  // the refund module's own responsibility; only the resulting revoke amount reaches this function).
  shortfall: ClawbackShortfall;
  /** EC:L5 — optional delivery-scoped id, merged into `reference.correlationId` on the revoke
   *  entry this call writes (never overwrites one already set on `reference`). */
  correlationId?: string;
}

export interface ClawbackResult {
  revoked: number;
  shortfall: number;
  entry: LedgerEntry | null;
  duplicated: boolean;
}

function inferSource(idempotencyKey: string): LedgerSource {
  if (idempotencyKey.startsWith('revoke:downgrade:')) return 'downgrade';
  if (idempotencyKey.startsWith('revoke:refund:')) return 'refund';
  return 'manual';
}

// EC:A4 B13 — revoke credits, applying the shortfall rule when balance < requested amount.
export async function clawback(input: ClawbackInput): Promise<ClawbackResult> {
  const { customerId, amount, ledger, clock, reason, reference, actor, idempotencyKey, shortfall, correlationId } = input;

  const balance = await ledger.balance(customerId, 'paid', clock.now());
  const available = balance.available;

  let revokeAmount = amount;
  let shortfallAmount = 0;

  if (available < amount) {
    if (shortfall === 'clamp_to_zero') {
      revokeAmount = Math.max(0, available);
      shortfallAmount = amount - revokeAmount;
    } else if (shortfall === 'allow_negative') {
      revokeAmount = amount; // balance may go negative; offset at next grant
      shortfallAmount = 0;
    } else {
      // deny_downgrade
      throw new InsufficientBalanceError(amount - available, { rule: shortfall });
    }
  }

  if (revokeAmount <= 0) {
    return { revoked: 0, shortfall: shortfallAmount, entry: null, duplicated: false };
  }

  const { entry, duplicated } = await ledger.append({
    customerId,
    pool: 'paid',
    kind: 'revoke',
    amount: -revokeAmount,
    unitPriceMinor: null,
    currency: null,
    expiresAt: null,
    source: inferSource(idempotencyKey),
    reference: correlationId ? { ...reference, correlationId: reference.correlationId ?? correlationId } : reference,
    idempotencyKey,
    actor,
    reason,
  });

  return { revoked: revokeAmount, shortfall: shortfallAmount, entry, duplicated };
}
