import type { Clock, CsCase, Notifier, Repo } from 'boilpayment-core';
import { escalate, resolve } from './cases.js';
import type { LicenseReporter } from './metrics.js';
import type { OnCaseEvent } from './cases.js';

export interface FinishRefundCasesInput { readonly repo: Repo; readonly clock: Clock; readonly notifier?: Notifier | null; readonly onCaseEvent?: OnCaseEvent; readonly reporter?: LicenseReporter | null }
/** Close the original pending case only after the stored refund becomes confirmed succeeded. */
export async function finishRefundCases(input: FinishRefundCasesInput): Promise<CsCase[]> {
  const cases = await input.repo.csCases.list({ kind: 'refund', status: 'needs_human' });
  const updated: CsCase[] = [];
  for (const csCase of cases) {
    const prior = csCase.decision?.refund;
    if (typeof prior !== 'object' || prior === null || !('id' in prior) || typeof prior.id !== 'string') continue;
    const refund = await input.repo.refunds.get(prior.id);
    if (!refund || refund.customerId !== csCase.customerId || refund.paymentId !== csCase.referenceId) continue;
    if (refund.status === 'succeeded') updated.push(await resolve({ ...input, case: csCase, by: 'auto', decision: { ...csCase.decision, refund } }));
    else if (refund.status === 'failed') {
      csCase.decision = { ...csCase.decision, refund };
      updated.push(await escalate({ ...input, case: csCase, reason: refund.failure?.userMessage ?? 'refund failed; follow-up required' }));
    }
  }
  return updated;
}
