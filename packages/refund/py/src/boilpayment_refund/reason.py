"""EC:D16 -- refund reason rules. spec/refund.pseudo.md. Mirrors ts/src/reason.ts."""

from __future__ import annotations

from dataclasses import dataclass

from boilpayment_core import Policy, RefundReasonCategory


@dataclass(kw_only=True, slots=True)
class RefundReasonInput:
    """Why the customer wants the money back, as the app classified it."""

    category: RefundReasonCategory
    # A reference the app can show a person later (job id, ticket, screenshot).
    evidence_ref: str | None = None


@dataclass(kw_only=True, slots=True)
class ReasonRuling:
    deny: str | None = None  # non-None: refuse with this explanation
    full: bool = False  # refund the whole remaining payment
    human: str | None = None  # non-None: decide as usual but send the case to a person


def rule_for_reason(policy: Policy, reason: RefundReasonInput | None) -> ReasonRuling:
    r = policy.refund.reasons
    category = reason.category if reason is not None else None
    if category == "technical_failure":
        return ReasonRuling(full=r.technical_failure == "full")
    if category == "user_error":
        return ReasonRuling(deny="D16: user_error -> deny" if r.user_error == "deny" else None)
    if category == "dissatisfied":
        if r.dissatisfied == "needs_human":
            return ReasonRuling(human="D16: dissatisfied -> needs human")
        if r.dissatisfied == "evidence_required" and not (reason and reason.evidence_ref):
            return ReasonRuling(human="D16: dissatisfied without evidenceRef -> needs human")
    return ReasonRuling()
