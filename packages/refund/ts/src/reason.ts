// EC:D16 — refund reason rules. spec/refund.pseudo.md
import type { Policy, RefundReasonCategory } from 'boilpayment-core';

/** Why the customer wants the money back, as the app classified it. */
export interface RefundReasonInput {
  category: RefundReasonCategory;
  /** A reference the app can show a person later (job id, ticket, screenshot). Needed for `dissatisfied` under evidence_required. */
  evidenceRef?: string | null;
}

export interface ReasonRuling {
  /** Non-null: refuse with this explanation. */
  deny: string | null;
  /** Refund the whole remaining payment, as inside the no-questions window. */
  full: boolean;
  /** Non-null: decide as usual but send the case to a person. */
  human: string | null;
}

export function ruleForReason(policy: Policy, reason: RefundReasonInput | null | undefined): ReasonRuling {
  const r = policy.refund.reasons;
  const none: ReasonRuling = { deny: null, full: false, human: null };
  switch (reason?.category) {
    case 'technical_failure':
      return r.technicalFailure === 'full' ? { ...none, full: true } : none;
    case 'user_error':
      return r.userError === 'deny' ? { ...none, deny: 'D16: user_error -> deny' } : none;
    case 'dissatisfied':
      if (r.dissatisfied === 'needs_human') return { ...none, human: 'D16: dissatisfied -> needs human' };
      if (r.dissatisfied === 'evidence_required' && !reason.evidenceRef) return { ...none, human: 'D16: dissatisfied without evidenceRef -> needs human' };
      return none;
    default:
      return none;
  }
}
