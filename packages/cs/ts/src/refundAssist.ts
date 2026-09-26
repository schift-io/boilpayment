// spec/cs.pseudo.md — EC:D* I1 I2 I4 J1-J5
// Deliberately does NOT import `boilpayment-refund` — refundEvaluate/refundExecute are injected
// (same shapes as refund.evaluate/refund.execute) so `cs` stays decoupled from `refund`'s package tree.
import {
  Clock, CsCase, IdGen, LedgerStore, Notifier, Payment, PaymentProvider, Policy, Refund, RefundDecision,
  RefundReasonCategory, Repo, Subscription, deserializeCsCase, runIdempotent, serializeCsCase,
} from 'boilpayment-core';
import { escalate, OnCaseEvent, openCase, reject, resolve } from './cases.js';
import { ChurnReason, record as recordChurn } from './churn.js';
import { LicenseReporter } from './metrics.js';

export type RefundEvaluateFn = (input: {
  payment: Payment; sub?: Subscription | null; policy: Policy; ledger: LedgerStore; repo: Repo; clock: Clock;
  requestedAmount?: { amountMinor: number; currency: string } | null; providerFeeMinor?: number | null;
  /** EC:D16 — refund reason category (+ evidence reference); policy.refund.reasons decides the effect. */
  reason?: RefundReasonInput | null;
}) => Promise<RefundDecision>;

/** EC:D16 — same shape as refund's RefundReasonInput (cs does not import refund). */
export interface RefundReasonInput {
  category: RefundReasonCategory;
  evidenceRef?: string | null;
}

export type RefundExecuteFn = (input: {
  decision: RefundDecision; provider: PaymentProvider; ledger: LedgerStore; repo: Repo; clock: Clock; ids: IdGen;
  extra?: Record<string, unknown>;
  cs?: { openRefundFailedCase(input: { customerId: string; referenceId: string; reason: string; needs?: string }): Promise<void> } | null;
  /** EC:L5 — see refund.execute's ExecuteInput.correlationId; threaded straight through by cs.refundAssist. */
  correlationId?: string;
}) => Promise<Refund>;

export interface RefundAssistInput {
  case: CsCase;
  payment: Payment;
  sub?: Subscription | null;
  policy: Policy;
  ledger: LedgerStore;
  repo: Repo;
  clock: Clock;
  ids: IdGen;
  provider: PaymentProvider;
  refundEvaluate: RefundEvaluateFn;
  refundExecute: RefundExecuteFn;
  requestedAmount?: { amountMinor: number; currency: string } | null;
  providerFeeMinor?: number | null;
  /** EC:D16 */
  reason?: RefundReasonInput | null;
  notifier?: Notifier | null;
  churnReason?: ChurnReason | null;
  churnText?: string | null;
  onCaseEvent?: OnCaseEvent;
  /** EC:I5 — reports the resulting resolved_auto/rejected transition to the license server. */
  reporter?: LicenseReporter | null;
  /** EC:J5 — default: `refund-assist:{case.id}:{payment.id}` if omitted. */
  idempotencyKey?: string;
  /** EC:L5 — optional delivery-scoped id, threaded to `refundExecute` (which stamps it on the
   *  provider call and every ledger entry it writes — see refund.execute). */
  correlationId?: string;
}

/**
 * EC:D* I1 I2 — cs.refundAssist({case, ...refund deps}) -> CsCase
 * EC:J1-J5 — wrapped in runIdempotent so a retried refundAssist call replays the first CsCase
 * instead of re-evaluating/re-executing the refund and re-escalating/re-resolving the case.
 */
export async function refundAssist(input: RefundAssistInput): Promise<CsCase> {
  const { case: csCase, payment, repo, clock } = input;
  const key = input.idempotencyKey ?? `refund-assist:${csCase.id}:${payment.id}`;

  const { result } = await runIdempotent<CsCase>({
    repo,
    clock,
    key,
    kind: 'cs.refundAssist',
    payload: {
      caseId: csCase.id,
      paymentId: payment.id,
      requestedAmount: input.requestedAmount ?? null,
      providerFeeMinor: input.providerFeeMinor ?? null,
      churnReason: input.churnReason ?? null,
      reason: input.reason ?? null,
    },
    serialize: serializeCsCase,
    deserialize: deserializeCsCase,
    fn: () => doRefundAssist(input),
  });
  return result;
}

async function doRefundAssist(input: RefundAssistInput): Promise<CsCase> {
  const {
    case: csCase, payment, sub, ledger, repo, clock, ids, provider, refundEvaluate, refundExecute,
    requestedAmount, providerFeeMinor, notifier, churnReason, churnText, onCaseEvent, reporter, correlationId, reason,
  } = input;

  const policy = csCase.policySnapshot;
  if (payment.customerId !== csCase.customerId) {
    return reject({ case: csCase, reason: "payment does not belong to case customer", repo, clock, onCaseEvent, reporter });
  }
  const decision = await refundEvaluate({ payment, sub, policy, ledger, repo, clock, requestedAmount, providerFeeMinor, reason });
  if (!decision.eligible) {
    return reject({ case: csCase, reason: decision.reason, repo, clock, onCaseEvent, reporter });
  }

  // EC:I2 — fraud/velocity: force human review regardless of decision.needsHuman
  const windowStart = new Date(clock.now().getTime() - policy.cs.fraud.windowDays * 24 * 60 * 60 * 1000);
  const recentRefunds = (await repo.refunds.list({ customerId: csCase.customerId }))
    .filter((r) => r.status === 'succeeded' && r.createdAt >= windowStart).length;
  if (recentRefunds >= policy.cs.fraud.refundVelocity) {
    return escalate({
      case: csCase, repo, clock, notifier,
      reason: `I2 fraud: ${recentRefunds} refunds in ${policy.cs.fraud.windowDays}d >= velocity ${policy.cs.fraud.refundVelocity}`,
      onCaseEvent,
    });
  }

  // EC:I1 — auto-approve limits (already folded into decision.needsHuman by refund.evaluate)
  if (decision.needsHuman) {
    return escalate({ case: csCase, repo, clock, notifier, reason: decision.reason, onCaseEvent });
  }

  const refund = await refundExecute({
    decision, provider, ledger, repo, clock, ids, correlationId,
    // EC:D12 — a failed refund always needs a human (manual payout / retry / missing bank info),
    // so the opened case is escalated straight to needs_human. `needs` (e.g. EC:D13
    // 'refund_receive_account') is stamped onto its decision for the ops UI to act on.
    cs: { openRefundFailedCase: async ({ customerId, referenceId, reason, needs }) => {
      const opened = await openCase({ customerId, kind: 'refund_failed', referenceId, policy, repo, clock, ids, onCaseEvent });
      const escalated = await escalate({ case: opened, repo, clock, notifier, reason, onCaseEvent });
      if (needs) {
        escalated.decision = { ...(escalated.decision ?? {}), needs };
        await repo.csCases.put(escalated);
      }
    } },
  });

  if (refund.status !== 'succeeded') {
    csCase.decision = { decision, refund };
    return escalate({ case: csCase, repo, clock, notifier, reason: refund.failure?.userMessage ?? `refund ${refund.status}`, onCaseEvent });
  }
  const resolved = await resolve({ case: csCase, by: 'auto', decision: { decision, refund }, repo, clock, onCaseEvent, reporter });
  if (churnReason) {
    await recordChurn({ customerId: csCase.customerId, reason: churnReason, text: churnText, case: resolved, repo, clock, onCaseEvent }); // I4
  }
  return resolved;
}
