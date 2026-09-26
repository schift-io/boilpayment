import { PaymentKitError, deserializeRefund, hashPayload, serializeRefund } from 'boilpayment-core';
import type { Refund } from 'boilpayment-core';
import type { ExecuteInput } from './execute.js';

/** The submitted checkpoint is never retried, even when the provider ignores idempotency keys. */
export async function requestRefund(input: ExecuteInput, executionKey: string): Promise<Refund> {
  const { decision, repo, ledger, clock, correlationId } = input;
  const key = `refund.provider:${executionKey}`;
  const existing = await repo.operations.get(key);
  if (existing && existing.result === null) {
    throw new PaymentKitError('refund request preparation needs reconciliation', 'idempotency_in_progress');
  }
  if (existing && (existing.status === 'done' || existing.error === 'refund_submitted')) {
    return deserializeRefund(existing.result);
  }
  const payment = await repo.payments.get(decision.paymentId);
  if (!payment) throw new PaymentKitError('payment not found', 'not_found');
  const pending: Refund = existing ? deserializeRefund(existing.result) : {
    id: input.ids.newId(), paymentId: payment.id, customerId: decision.customerId,
    amount: decision.amount, status: 'pending', providerRef: null, creditsRevoked: 0,
    ruleId: decision.ruleId, reason: decision.reason, createdAt: clock.now(),
    failure: { code: 'refund_outcome_unknown', providerCode: null, retryable: false,
      userMessage: 'Refund outcome requires provider confirmation; do not resubmit' },
  };
  // EC:D17 — the remaining-refundable check and the pending refund write are one critical section
  // per customer (in-memory mutex, Postgres advisory lock): two requests with different keys for the
  // same payment cannot both pass the cap. The provider call below stays outside the lock.
  const operation = await ledger.transaction(decision.customerId, async () => {
    const committed = (await repo.refunds.list({ paymentId: payment.id }))
      .filter((refund) => refund.id !== pending.id && (refund.status === 'succeeded' || refund.status === 'pending'))
      .reduce((sum, refund) => sum + refund.amount.amountMinor, 0);
    if (payment.customerId !== decision.customerId || payment.amount.currency !== decision.amount.currency
      || !Number.isSafeInteger(decision.amount.amountMinor) || decision.amount.amountMinor <= 0
      || !Number.isSafeInteger(decision.creditsToRevoke) || decision.creditsToRevoke < 0
      || decision.amount.amountMinor > payment.amount.amountMinor - committed
      || (payment.status !== 'succeeded' && payment.status !== 'partially_refunded')) {
      throw new PaymentKitError('refund decision does not match current payment', 'refund_invalid_decision', decision);
    }
    const claimed = await repo.operations.claim({
      id: key, key, kind: 'refund.provider', payloadHash: hashPayload({ decision, extra: input.extra ?? null }),
      status: 'in_progress', result: serializeRefund(pending), error: 'refund_prepared',
      createdAt: clock.now(), completedAt: null, attempts: 1,
    });
    if (!claimed) throw new PaymentKitError('refund request already in progress', 'idempotency_in_progress');
    const operation = { ...claimed, result: serializeRefund(pending), error: 'refund_prepared' };
    await repo.operations.put(operation);
    // Preparation can retry with the same refund id; no provider call has happened yet.
    try {
      if (decision.creditsToRevoke > 0) {
        await ledger.append({ customerId: decision.customerId, pool: 'paid', kind: 'hold', amount: -decision.creditsToRevoke,
          source: 'refund', reference: { paymentId: payment.id, refundId: pending.id,
            ...(correlationId ? { correlationId } : {}) }, idempotencyKey: `hold:refund:${pending.id}`,
          actor: 'system', reason: decision.reason, unitPriceMinor: null, currency: null, expiresAt: null });
      }
      await repo.refunds.put(pending);
    } catch (error) {
      await repo.operations.put({ ...operation, status: 'failed' });
      throw error;
    }
    return operation;
  });
  // Write BEFORE the network await. If saving the response fails, this pending checkpoint
  // survives and prevents another refund request. Reconciliation must resolve the uncertainty.
  await repo.operations.put({ ...operation, error: 'refund_submitted' });
  const provider = correlationId && 'withCorrelationId' in input.provider && typeof input.provider.withCorrelationId === 'function'
    ? input.provider.withCorrelationId(correlationId) : input.provider;
  let result: Refund;
  try {
    const response = await provider.refund({ paymentRef: payment.providerRef, amount: decision.amount,
      reason: decision.reason, idempotencyKey: `refund:${payment.id}:${pending.id}`, extra: input.extra });
    result = { ...pending, amount: response.amount, status: response.status,
      providerRef: response.providerRef ?? response.id, failure: response.failure ?? null };
  } catch (error) {
    // This specific adapter preflight rejects before making a network request. All other
    // exceptions are uncertain, including transport errors and provider 5xx responses.
    result = error instanceof PaymentKitError && error.code === 'refund_receive_account_required'
      ? { ...pending, status: 'failed', failure: { code: error.code, providerCode: null,
          retryable: true, userMessage: error.message } }
      : pending;
  }
  await repo.operations.put({ ...operation, status: 'done', result: serializeRefund(result),
    error: null, completedAt: clock.now() });
  return result;
}
