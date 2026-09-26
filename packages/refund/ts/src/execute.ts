// spec/refund.pseudo.md — EC:D15 D12 B8 J1-J5 K5 K6
import {
  Clock, IdGen, LedgerStore, PaymentKitError, PaymentProvider, Policy, Refund, RefundDecision, Repo,
  deserializeRefund, runIdempotent, serializeRefund,
} from '@schift/payment-kit-core';
import { requestRefund } from './execute-request.js';
import { settleRefund } from './execute-settle.js';

/** Injected instead of importing `@schift/payment-kit-cs` directly — keeps refund decoupled from cs (EC:D12). */
export interface RefundFailedCaseOpener {
  /** `needs` flags a structured follow-up the case needs before a human can act, e.g. EC:D13
   *  'refund_receive_account' for Toss virtual-account refunds missing `extra.refundReceiveAccount`,
   *  or EC:K6 'cash_receipt_cancel_failed' when the post-refund cash-receipt cancel (EC:K5) fails. */
  openRefundFailedCase(input: { customerId: string; referenceId: string; reason: string; needs?: string }): Promise<void>;
}

export interface ExecuteInput {
  decision: RefundDecision;
  /** Identity supplied by the trusted application after explicit exception approval. */
  approvedBy?: string | null;
  provider: PaymentProvider;
  ledger: LedgerStore;
  repo: Repo;
  clock: Clock;
  ids: IdGen;
  /**
   * `extra.cashReceiptKey` (EC:K5) — fallback only. `payment.cashReceipt.receiptKey` is preferred
   * and is written by the webhook auto-issue path; pass this when the receipt was issued outside
   * the kit, or when the payment row predates the auto-issue wiring. The caller passes this when the payment has an issued cash
   * receipt (Toss: the real `receiptKey`; PortOne: any truthy value, since PortOne's cancel
   * endpoint is payment-scoped and needs no receipt id — see toss.pseudo.md/portone.pseudo.md).
   * refund itself has no record of issuance (no core `Payment.cashReceipt` field — 계약 변경 제안);
   * the caller (whoever issued the receipt, e.g. webhook.default_handlers) must supply it.
   */
  extra?: Record<string, unknown>;
  cs?: RefundFailedCaseOpener | null;
  /** EC:K5 — only `cashReceipt.cancelOnRefund` is read; pass the resolved Policy or just this slice. */
  policy?: Pick<Policy, 'cashReceipt'>;
  /** EC:J5 — default: `refund:{decision.paymentId}:{decision.amount.amountMinor}:{decision.ruleId}` if omitted. */
  idempotencyKey?: string;
  /**
   * EC:L5 — optional delivery-scoped correlation id for callers that did NOT come through
   * webhook.process's own ledger/provider wrapping (see packages/webhook/ts/src/correlation.ts).
   * When present: threaded to `provider.refund()` via the provider's duck-typed
   * `withCorrelationId(id)` (falls back to the bare provider when absent), and merged into
   * `reference.correlationId` on every ledger entry this call writes (hold/revoke/release).
   * Never overwrites a correlationId already present on the ledger (e.g. from a caller-scoped
   * ledger wrapper) — that layer wins.
   */
  correlationId?: string;
}

/** Execute once at the provider; retry only durable local settlement after provider success. */
export async function execute(input: ExecuteInput): Promise<Refund> {
  const { decision, repo, clock } = input;
  if (!decision.eligible) throw new PaymentKitError('cannot execute an ineligible refund decision', 'refund_ineligible', decision);
  if (decision.needsHuman && !input.approvedBy?.trim()) {
    throw new PaymentKitError('refund decision requires explicit approval', 'refund_approval_required', decision);
  }
  const key = input.idempotencyKey ?? `refund:${decision.paymentId}:${decision.amount.amountMinor}:${decision.ruleId}`;
  const { result } = await runIdempotent<Refund>({
    repo, clock, key, kind: 'refund.execute', payload: { decision, extra: input.extra ?? null },
    serialize: serializeRefund, deserialize: deserializeRefund,
    fn: async () => {
      const providerResult = await requestRefund(input, key);
      const settled = await repo.refunds.get(providerResult.id);
      if (settled && settled.status !== 'pending') return settled;
      if (providerResult.status === 'pending') {
        await repo.refunds.put(providerResult);
        return providerResult;
      }
      if (providerResult.status === 'failed') {
        if (decision.creditsToRevoke > 0) {
          await input.ledger.append({
            customerId: decision.customerId, pool: 'paid', kind: 'release', amount: decision.creditsToRevoke,
            source: 'refund', reference: { paymentId: decision.paymentId, refundId: providerResult.id,
              ...(input.correlationId ? { correlationId: input.correlationId } : {}) },
            idempotencyKey: `release:refund:${providerResult.id}`, actor: 'system', reason: decision.reason,
            unitPriceMinor: null, currency: null, expiresAt: null,
          });
        }
        await repo.refunds.put(providerResult);
        await input.cs?.openRefundFailedCase({ customerId: decision.customerId, referenceId: providerResult.id,
          reason: providerResult.failure?.userMessage ?? 'provider refund failed',
          needs: providerResult.failure?.code === 'refund_receive_account_required' ? 'refund_receive_account' : undefined });
        return providerResult;
      }
      const payment = await repo.payments.get(decision.paymentId);
      if (!payment) throw new PaymentKitError('payment not found', 'not_found');
      return settleRefund(input, providerResult, payment);
    },
  });
  return (await repo.refunds.get(result.id)) ?? result;
}
