import { roundHalfAwayFromZero } from 'boilpayment-core';
// spec/refund.pseudo.md — EC:D8 D18
import { Clock, IdGen, LedgerStore, NormalizedEvent, PaymentKitError, Refund, Repo } from 'boilpayment-core';
import { weightedAvgUnitPrice } from './util.js';

/** Injected instead of importing `boilpayment-cs` directly (EC:D8). */
export interface ReconcileMismatchCaseOpener {
  openReconcileMismatchCase(input: { customerId: string; referenceId: string; reason: string }): Promise<void>;
}

export interface OnExternalRefundInput {
  event: NormalizedEvent;
  /** Trusted host supplied provider refund id; event.id identifies the delivery, not the refund. */
  refundRef?: string;
  ledger: LedgerStore;
  repo: Repo;
  cs: ReconcileMismatchCaseOpener;
  clock: Clock;
  ids: IdGen;
  /** EC:L5 — optional delivery-scoped correlation id for callers that did NOT come through
   *  webhook.process's own ledger wrapping. Merged into `reference.correlationId` on the revoke
   *  entry this call writes. */
  correlationId?: string;
}

/** EC:J9 — credits an external refund of `amountMinor` stands for, rounded half away from zero (same as Python). */
export function creditsForAmount(amountMinor: number, unitPrice: number): number {
  return unitPrice > 0 ? roundHalfAwayFromZero(amountMinor / unitPrice) : 0;
}

/** EC:onExternalRefund — refund.onExternalRefund({event, ledger, repo, cs, clock, ids}) */
export async function onExternalRefund(input: OnExternalRefundInput): Promise<Refund> {
  const { event, ledger, repo, cs, clock, ids, correlationId } = input;
  const now = clock.now();
  const refundRef = input.refundRef ?? event.refundRef;

  const payments = event.paymentRef ? await repo.payments.list({ providerRef: event.paymentRef, provider: event.provider }) : [];
  let payment = payments[0] ?? null;
  if (!payment && refundRef && !event.paymentRef) {
    const candidates = await repo.refunds.list({ providerRef: refundRef });
    for (const candidate of candidates) {
      const linked = await repo.payments.get(candidate.paymentId);
      if (linked?.provider === event.provider) {
        if (payment && payment.id !== linked.id) throw new PaymentKitError('ambiguous provider refund reference', 'refund_reconciliation_required');
        payment = linked;
      }
    }
  }

  const refunds = payment ? await repo.refunds.list({ paymentId: payment.id }) : [];
  const existing = refunds.find((refund) => Boolean(refundRef) && refund.providerRef === refundRef);
  if (existing && existing.status !== 'pending') return existing;
  const pending = refundRef && existing?.status === 'pending' ? existing : null;
  const unresolved = refunds.filter((refund) => refund.status === 'pending');
  if (!pending && unresolved.length > 0) {
    await cs.openReconcileMismatchCase({ customerId: payment?.customerId ?? 'unknown', referenceId: event.id,
      reason: 'pending refund requires a matching provider refund reference' });
    const single = unresolved[0];
    if (unresolved.length === 1 && single) return single;
    throw new PaymentKitError('multiple pending refunds cannot be correlated', 'refund_reconciliation_required');
  }

  if (pending && event.type === 'refund.pending') return pending;
  const settlementAmount = event.amount ?? pending?.amount;
  if (!refundRef || !settlementAmount) {
    await cs.openReconcileMismatchCase({ customerId: payment?.customerId ?? 'unknown', referenceId: event.id,
      reason: 'external refund requires an actual refund reference and amount' });
    throw new PaymentKitError('external refund evidence is incomplete', 'refund_reconciliation_required');
  }

  const refundId = pending?.id ?? ids.newId();
  const status: Refund['status'] = event.type === 'refund.failed' ? 'failed' : event.type === 'refund.pending' ? 'pending' : 'succeeded';

  if (!payment) {
    await cs.openReconcileMismatchCase({ customerId: event.customerRef ?? 'unknown', referenceId: event.paymentRef ?? event.id, reason: 'no matching payment for external refund event' });
    throw new PaymentKitError('external refund payment was not found', 'refund_reconciliation_required');
  }

  // EC:D18 — the balance read, the revoke clamp and the refund write run under the customer's ledger
  // lock, the same one consume() takes, so a concurrent consume cannot spend the credits between the
  // balance read and the revoke (which drove the balance below zero under negativeBalance=block).
  const customerId = payment.customerId;
  return ledger.transaction(customerId, async () => {
    let pendingCredits = 0;
    if (pending) {
      if (event.amount && (event.amount.amountMinor !== pending.amount.amountMinor || event.amount.currency !== pending.amount.currency)) {
        await cs.openReconcileMismatchCase({ customerId: payment.customerId, referenceId: pending.id, reason: 'pending refund amount differs from settlement event' });
        return pending;
      }
      const held = -(await ledger.entries(payment.customerId, { kind: 'hold' }))
        .filter((entry) => entry.reference.refundId === pending.id).reduce((sum, entry) => sum + entry.amount, 0);
      pendingCredits = held;
      if (held > 0) await ledger.append({ customerId: payment.customerId, pool: 'paid', kind: 'release', amount: held,
        source: 'refund', reference: { paymentId: payment.id, refundId }, idempotencyKey: `release:refund:${refundId}`,
        actor: 'system', reason: 'pending refund settled', unitPriceMinor: null, currency: null, expiresAt: null });
    }

    const alreadyRefundedMinor = (await repo.refunds.list({ paymentId: payment.id }))
      .filter((r) => r.status === 'succeeded')
      .reduce((sum, r) => sum + r.amount.amountMinor, 0);
    const amountMinor = settlementAmount.amountMinor;
    const currency = settlementAmount.currency;

    const grants = (await ledger.entries(payment.customerId, { kind: 'grant' }))
      .filter((e) => e.reference.paymentId === payment.id && (e.source === 'subscription' || e.source === 'topup'));
    const totalGranted = grants.reduce((sum, g) => sum + g.amount, 0);
    const alreadyRevoked = (await ledger.entries(payment.customerId, { kind: 'revoke' }))
      .filter((e) => e.reference.paymentId === payment.id && e.source === 'refund')
      .reduce((sum, e) => sum + -e.amount, 0);
    const unitPrice = weightedAvgUnitPrice(grants);
    const rawCredits = pending ? pendingCredits : creditsForAmount(amountMinor, unitPrice);
    const balance = await ledger.balance(payment.customerId, 'paid', clock.now()); // FINDINGS#1 class: always thread the injected clock
    const creditsToRevoke = pending ? pendingCredits : Math.max(0, Math.min(rawCredits, totalGranted - alreadyRevoked, balance.available));

    if (creditsToRevoke > 0 && event.type === 'refund.created') {
      // EC:D18 — revoke from grant buckets (reference.grantId), this payment's grants first, then the
      // earliest-expiring others. A revoke tied to no grant lowered the balance but left every bucket
      // whole, so a later consume could still draw the revoked credits (balance -100 under block).
      const parts = await revokeBuckets(ledger, payment.customerId, payment.id, creditsToRevoke, clock.now());
      // Only an approved allow_negative pending refund can ask for more than the buckets hold; that
      // approved excess stays a grant-less revoke (the debt the policy allowed).
      const excess = creditsToRevoke - parts.reduce((sum, p) => sum + p.amount, 0);
      if (excess > 0) {
        await ledger.append({
          customerId: payment.customerId, pool: 'paid', kind: 'revoke', amount: -excess, source: 'refund',
          reference: { paymentId: payment.id, refundId, ...(correlationId ? { correlationId } : {}) },
          idempotencyKey: `revoke:refund:${refundId}`, actor: 'system',
          reason: 'D8 external refund reconcile', unitPriceMinor: null, currency: null, expiresAt: null,
        });
      }
      for (const part of parts) {
        await ledger.append({
          customerId: payment.customerId, pool: 'paid', kind: 'revoke', amount: -part.amount, source: 'refund',
          reference: { paymentId: payment.id, refundId, grantId: part.grantId, ...(correlationId ? { correlationId } : {}) },
          idempotencyKey: `revoke:refund:${refundId}:${part.grantId}`, actor: 'system',
          reason: 'D8 external refund reconcile', unitPriceMinor: null, currency: null, expiresAt: null,
        });
      }
    }

    const refund: Refund = {
      id: refundId, paymentId: payment.id, customerId: payment.customerId, amount: { amountMinor, currency },
      status, providerRef: refundRef, creditsRevoked: status === 'succeeded' ? creditsToRevoke : 0, ruleId: pending?.ruleId ?? 'D8',
      reason: pending?.reason ?? 'external refund reconcile', failure: null, createdAt: pending?.createdAt ?? now,
    };
    await repo.refunds.put(refund);

    if (status === 'succeeded') {
      const totalRefunded = alreadyRefundedMinor + amountMinor;
      payment.status = totalRefunded >= payment.amount.amountMinor ? 'refunded' : 'partially_refunded';
      await repo.payments.put(payment);
    }

    const mismatch = event.amount == null || rawCredits !== creditsToRevoke;
    if (mismatch) {
      await cs.openReconcileMismatchCase({
        customerId: payment.customerId, referenceId: refund.id,
        reason: event.amount == null ? 'external refund event carried no amount' : `computed credits ${rawCredits} clamped to ${creditsToRevoke}`,
      });
    }
    return refund;
  });
}

/**
 * EC:D18 — split `amount` over live 'paid' grant buckets: grants bought by `paymentId` first, then the
 * rest earliest-expiry first. Remaining per bucket = grant + every entry that names it. The caller
 * clamps `amount` to the available balance, which never exceeds the buckets' total.
 */
async function revokeBuckets(ledger: LedgerStore, customerId: string, paymentId: string, amount: number, now: Date) {
  const all = await ledger.entries(customerId, { pool: 'paid' });
  const drawn = new Map<string, number>();
  for (const e of all) if (e.kind !== 'grant' && e.reference.grantId) drawn.set(e.reference.grantId, (drawn.get(e.reference.grantId) ?? 0) + e.amount);
  const live = all.filter((g) => g.kind === 'grant' && (g.expiresAt === null || g.expiresAt > now))
    .map((g) => ({ g, remaining: g.amount + (drawn.get(g.id) ?? 0) }))
    .filter((b) => b.remaining > 0)
    .sort((a, b) => Number(b.g.reference.paymentId === paymentId) - Number(a.g.reference.paymentId === paymentId)
      || (a.g.expiresAt?.getTime() ?? Infinity) - (b.g.expiresAt?.getTime() ?? Infinity)
      || a.g.createdAt.getTime() - b.g.createdAt.getTime());
  const parts: Array<{ grantId: string; amount: number }> = [];
  let left = amount;
  for (const b of live) {
    if (left <= 0) break;
    const take = Math.min(left, b.remaining);
    parts.push({ grantId: b.g.id, amount: take });
    left -= take;
  }
  return parts;
}
