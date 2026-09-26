import type { Payment, Refund } from 'boilpayment-core';
import type { ExecuteInput } from './execute.js';

export async function settleRefund(input: ExecuteInput, providerResult: Refund, payment: Payment): Promise<Refund> {
  const { decision, provider, ledger, repo, clock, extra, cs, policy, correlationId } = input;
  const scopedProvider = correlationId && 'withCorrelationId' in provider && typeof provider.withCorrelationId === 'function'
    ? provider.withCorrelationId(correlationId) : provider;
  const refundId = providerResult.id;
  const ref = <T extends object>(r: T): T & { correlationId?: string } => (correlationId ? { ...r, correlationId } : r);
  if (decision.creditsToRevoke > 0) {
    // EC:B8/B13 — attribute the revoke to the payment's grant buckets (reference.grantId) so the ledger,
    // dunning (A16) and expiry (B14) all see those grants as consumed; an unattributed revoke would be
    // double-counted later (found by examples/e2e). Any remainder beyond the buckets stays unattributed.
    const all = await ledger.entries(decision.customerId, { pool: 'paid' });
    const grants = all.filter((e) => e.kind === 'grant' && e.reference.paymentId === decision.paymentId);
    // Retry-safe: subtract what this refundId already revoked (a retried execute must not revoke twice).
    const alreadyRevoked = all
      .filter((e) => e.kind === 'revoke' && e.reference.refundId === refundId)
      .reduce((s, e) => s + -e.amount, 0);
    let left = Math.max(0, decision.creditsToRevoke - alreadyRevoked);
    for (const g of grants) {
      if (left <= 0) break;
      const used = all.filter((e) => e.kind !== 'grant' && e.reference.grantId === g.id).reduce((s, e) => s + e.amount, 0);
      const take = Math.min(Math.max(0, g.amount + used), left);
      if (take <= 0) continue;
      await ledger.append({
        customerId: decision.customerId, pool: 'paid', kind: 'revoke', amount: -take,
        source: 'refund', reference: ref({ paymentId: decision.paymentId, refundId, grantId: g.id }), idempotencyKey: `revoke:refund:${refundId}:${g.id}`,
        actor: 'system', reason: decision.reason, unitPriceMinor: null, currency: null, expiresAt: null,
      });
      left -= take;
    }
    if (left > 0) {
      await ledger.append({
        customerId: decision.customerId, pool: 'paid', kind: 'revoke', amount: -left,
        source: 'refund', reference: ref({ paymentId: decision.paymentId, refundId }), idempotencyKey: `revoke:refund:${refundId}`,
        actor: 'system', reason: decision.reason, unitPriceMinor: null, currency: null, expiresAt: null,
      });
    }
    // D15: release the hold now that the permanent revoke landed (net effect = revoke only).
    await ledger.append({
      customerId: decision.customerId, pool: 'paid', kind: 'release', amount: decision.creditsToRevoke,
      source: 'refund', reference: ref({ paymentId: decision.paymentId, refundId }), idempotencyKey: `release:refund:${refundId}`,
      actor: 'system', reason: decision.reason, unitPriceMinor: null, currency: null, expiresAt: null,
    });
  }

  // provider.refund() carries no our own ids (customerId/ruleId come back empty, `id` is the
  // provider's own cancellation id) — take only providerRef/status/amount/failure from it and
  // overwrite everything we already know from `decision`.
  const priorRefunded = (await repo.refunds.list({ paymentId: payment.id }))
    .filter((r) => r.status === 'succeeded' && r.id !== refundId)
    .reduce((sum, r) => sum + r.amount.amountMinor, 0);
  const totalRefunded = priorRefunded + providerResult.amount.amountMinor;
  await repo.payments.put({ ...payment, status: totalRefunded >= payment.amount.amountMinor ? 'refunded' : 'partially_refunded' });

  const refund: Refund = {
    id: refundId, paymentId: payment.id, customerId: decision.customerId, amount: providerResult.amount,
    status: providerResult.status, providerRef: providerResult.providerRef ?? providerResult.id ?? null,
    creditsRevoked: decision.creditsToRevoke, ruleId: decision.ruleId, reason: decision.reason,
    failure: providerResult.failure ?? null, createdAt: clock.now(),
  };
  await repo.refunds.put(refund);

  // EC:K5 K6 — cancel the cash receipt AFTER the refund has already landed successfully. A
  // cash-receipt-cancel failure must NEVER roll back or downgrade the refund's own success —
  // it is recorded/escalated (K6) and the already-`succeeded` refund is still returned as-is.
  // EC:K5 — prefer the receipt recorded on the payment (webhook auto-issue writes it there); fall
  // back to the caller-supplied extra for receipts issued outside the kit.
  const receiptKey = payment.cashReceipt?.receiptKey
    ?? (typeof extra?.cashReceiptKey === 'string' ? extra.cashReceiptKey : undefined);
  if (policy?.cashReceipt.cancelOnRefund && receiptKey && refund.status === 'succeeded') {
    const canceler = scopedProvider as unknown as Partial<{ cancelCashReceipt: (i: { paymentRef: string; receiptKey?: string; amountMinor?: number }) => Promise<unknown> }>;
    if (typeof canceler.cancelCashReceipt === 'function') {
      try {
        await canceler.cancelCashReceipt({ paymentRef: payment.providerRef, receiptKey, amountMinor: providerResult.amount.amountMinor });
      } catch (receiptErr) {
        if (cs) {
          await cs.openRefundFailedCase({
            customerId: decision.customerId,
            referenceId: refund.id,
            reason: `cash receipt cancel failed: ${(receiptErr as Error).message ?? String(receiptErr)}`,
            needs: 'cash_receipt_cancel_failed',
          });
        }
      }
    }
  }

  return refund;
}
