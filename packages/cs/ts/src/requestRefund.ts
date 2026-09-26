import { deserializeCsCase, runIdempotent, serializeCsCase } from 'boilpayment-core';
import type { CsCase, Money } from 'boilpayment-core';
import { evaluate, execute } from 'boilpayment-refund';
import { escalate } from './cases.js';
import { refundAssist } from './refundAssist.js';
import type { RefundReasonInput } from './refundAssist.js';
import { verifySupportPayment } from './support.js';
import type { SupportPaymentInput } from './support.js';

export interface RequestRefundInput extends SupportPaymentInput {
  readonly requestId?: string;
  readonly requestedAmount?: Money | null;
  /** EC:D16 — why the customer asks (technical_failure / dissatisfied / user_error / other). */
  readonly reason?: RefundReasonInput | null;
}

/** Customer-facing refund entry point: callers supply identifiers, never execution decisions. */
export async function requestRefund(input: RequestRefundInput): Promise<CsCase> {
  const { result } = await runIdempotent({ repo: input.repo, clock: input.clock,
    key: `support-refund:${input.customerId}:${input.requestId ?? input.paymentId}`,
    kind: 'cs.requestRefund', payload: { customerId: input.customerId, paymentId: input.paymentId, amount: input.requestedAmount ?? null, reason: input.reason ?? null },
    serialize: serializeCsCase, deserialize: deserializeCsCase,
    fn: async () => {
      const verified = await verifySupportPayment({ ...input, kind: 'refund', caseKey: input.requestId ?? input.paymentId });
      if (!verified.ok) return verified.case;
      const sub = verified.payment.subscriptionId ? await input.repo.subscriptions.get(verified.payment.subscriptionId) : null;
      if (verified.payment.subscriptionId && (!sub || sub.customerId !== input.customerId || sub.provider !== verified.payment.provider)) {
        return escalate({ case: verified.case, repo: input.repo, clock: input.clock, reason: 'subscription ownership evidence is unavailable', notifier: input.notifier, onCaseEvent: input.onCaseEvent });
      }
      return refundAssist({ ...input, case: verified.case, payment: verified.payment, sub, provider: verified.provider,
        policy: verified.case.policySnapshot, refundEvaluate: evaluate,
        refundExecute: (args) => execute({ ...args, policy: verified.case.policySnapshot }),
        idempotencyKey: `support-refund-assist:${verified.case.id}:${input.requestId ?? input.paymentId}` });
    },
  });
  return await input.repo.csCases.get(result.id) ?? result;
}
