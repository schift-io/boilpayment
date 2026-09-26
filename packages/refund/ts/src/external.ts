// spec/refund.pseudo.md — EC:D8
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
  const rawCredits = pending ? pendingCredits : unitPrice > 0 ? Math.round(amountMinor / unitPrice) : 0;
  const balance = await ledger.balance(payment.customerId, 'paid', clock.now()); // FINDINGS#1 class: always thread the injected clock
  const creditsToRevoke = pending ? pendingCredits : Math.max(0, Math.min(rawCredits, totalGranted - alreadyRevoked, balance.available));

  if (creditsToRevoke > 0 && event.type === 'refund.created') {
    await ledger.append({
      customerId: payment.customerId, pool: 'paid', kind: 'revoke', amount: -creditsToRevoke, source: 'refund',
      reference: { paymentId: payment.id, refundId, ...(correlationId ? { correlationId } : {}) },
      idempotencyKey: `revoke:refund:${refundId}`, actor: 'system',
      reason: 'D8 external refund reconcile', unitPriceMinor: null, currency: null, expiresAt: null,
    });
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
}
