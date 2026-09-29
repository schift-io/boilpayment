import type { Clock, CsCase, Notifier, Payment, Policy, Repo } from './types.js';
import { runIdempotent } from './idempotent.js';

/** DC-07 — operation that marks a paid-zero sale as handled: recorded, nothing granted, one case opened. */
export const zeroSaleKey = (paymentId: string): string => `zero-sale:${paymentId}`;

/** True once the paid-zero sale for this payment has been recorded and handed to a person. */
export async function isZeroSaleHandled(repo: Repo, paymentId: string): Promise<boolean> {
  const operation = await repo.operations.get(zeroSaleKey(paymentId));
  return operation?.kind === 'payment.zeroSale' && operation.status === 'done';
}

/**
 * DC-07 — a 100% discount is not supported. The sale is recorded by the caller; this opens exactly one
 * needs_human case for it (idempotent per payment) and never grants or accrues anything.
 */
export async function openZeroSaleCase(input: {
  readonly repo: Repo; readonly clock: Clock; readonly policy: Policy; readonly payment: Payment; readonly notifier?: Notifier | null;
}): Promise<CsCase> {
  const { repo, clock, policy, payment, notifier } = input;
  await runIdempotent({
    repo, key: zeroSaleKey(payment.id), kind: 'payment.zeroSale', payload: { paymentId: payment.id }, clock,
    fn: async () => {
      const id = zeroSaleKey(payment.id);
      if (!(await repo.csCases.get(id))) {
        const now = clock.now();
        await repo.csCases.put({
          id, customerId: payment.customerId, kind: 'reconcile_mismatch', status: 'needs_human', referenceId: payment.id,
          policySnapshot: structuredClone(policy), decision: { reason: 'zero_amount_sale', paymentId: payment.id },
          churnReason: null, churnText: null, openedAt: now, resolvedAt: null, escalatedAt: now,
        });
        if (notifier) {
          await notifier.send({ type: 'cs.needs_human', customerId: payment.customerId || null, payload: { caseId: id, paymentId: payment.id, reason: 'zero_amount_sale' } });
        }
      }
      return { paymentId: payment.id };
    },
  });
  const opened = await repo.csCases.get(zeroSaleKey(payment.id));
  if (!opened) throw new Error('zero-sale case missing after it was opened');
  return opened;
}
