"""spec/cs.pseudo.md — EC:D* I1 I2 I4 I5 J1-J5
Deliberately does NOT import `schift_payment_kit_refund` -- refund_evaluate/refund_execute are injected
(same shapes as refund.evaluate/refund.execute) so `cs` stays decoupled from `refund`'s package tree.
"""

from __future__ import annotations

from collections.abc import Awaitable
from dataclasses import dataclass
from datetime import timedelta
from typing import TYPE_CHECKING, Any, Protocol

from schift_payment_kit_core import (
    Clock,
    CsCase,
    IdGen,
    LedgerStore,
    Notifier,
    Payment,
    PaymentProvider,
    Policy,
    Refund,
    RefundDecision,
    Repo,
    Subscription,
    deserialize_cs_case,
    run_idempotent,
    serialize_cs_case,
)

from .cases import (
    EscalateInput,
    OnCaseEvent,
    OpenCaseInput,
    RejectInput,
    ResolveInput,
    escalate,
    open_case,
    reject,
    resolve,
)
from .churn import ChurnReason, ChurnRecordInput
from .churn import record as record_churn

if TYPE_CHECKING:
    from .metrics import LicenseReporter


class RefundEvaluateFn(Protocol):
    def __call__(
        self,
        *,
        payment: Payment,
        sub: Subscription | None,
        policy: Policy,
        ledger: LedgerStore,
        repo: Repo,
        clock: Clock,
        requested_amount: dict | None = None,
        provider_fee_minor: int | None = None,
    ) -> Awaitable[RefundDecision]: ...


class RefundExecuteCsOpener(Protocol):
    async def open_refund_failed_case(
        self,
        *,
        customer_id: str,
        reference_id: str,
        reason: str,
        needs: str | None = None,
    ) -> None: ...


class RefundExecuteFn(Protocol):
    def __call__(
        self,
        *,
        decision: RefundDecision,
        provider: PaymentProvider,
        ledger: LedgerStore,
        repo: Repo,
        clock: Clock,
        ids: IdGen,
        extra: dict[str, Any] | None = None,
        cs: RefundExecuteCsOpener | None = None,
        # EC:L5 -- see refund.execute's ExecuteInput.correlation_id; threaded straight through
        # by cs.refund_assist.
        correlation_id: str | None = None,
    ) -> Awaitable[Refund]: ...


@dataclass(kw_only=True, slots=True)
class RefundAssistInput:
    case: CsCase
    payment: Payment
    sub: Subscription | None = None
    policy: Policy
    ledger: LedgerStore
    repo: Repo
    clock: Clock
    ids: IdGen
    provider: PaymentProvider
    refund_evaluate: RefundEvaluateFn
    refund_execute: RefundExecuteFn
    requested_amount: dict | None = None
    provider_fee_minor: int | None = None
    notifier: Notifier | None = None
    churn_reason: ChurnReason | None = None
    churn_text: str | None = None
    on_case_event: OnCaseEvent | None = None
    # EC:I5 -- reports the resulting resolved_auto/rejected transition to the license server.
    reporter: LicenseReporter | None = None
    # EC:J5 -- default: "refund-assist:{case.id}:{payment.id}" if omitted.
    idempotency_key: str | None = None
    # EC:L5 -- optional delivery-scoped id, threaded to refund_execute (which stamps it on the
    # provider call and every ledger entry it writes -- see refund.execute).
    correlation_id: str | None = None


class _CsOpenerAdapter:
    """Wires refund.execute's D12 `cs` callback back into cs.open_case, without cs importing refund."""

    def __init__(
        self,
        policy: Policy,
        repo: Repo,
        clock: Clock,
        ids: IdGen,
        notifier: Notifier | None,
        on_case_event: OnCaseEvent | None,
    ) -> None:
        self._policy, self._repo, self._clock, self._ids = policy, repo, clock, ids
        self._notifier, self._on_case_event = notifier, on_case_event

    async def open_refund_failed_case(
        self,
        *,
        customer_id: str,
        reference_id: str,
        reason: str,
        needs: str | None = None,
    ) -> None:
        # EC:D12 -- a failed refund always needs a human (manual payout / retry / missing bank
        # info), so the opened case is escalated straight to needs_human. `needs` (e.g. EC:D13
        # 'refund_receive_account') is stamped onto its decision for the ops UI to act on.
        opened = await open_case(
            OpenCaseInput(
                customer_id=customer_id,
                kind="refund_failed",
                reference_id=reference_id,
                policy=self._policy,
                repo=self._repo,
                clock=self._clock,
                ids=self._ids,
                on_case_event=self._on_case_event,
            )
        )
        escalated = await escalate(
            EscalateInput(
                case=opened,
                repo=self._repo,
                clock=self._clock,
                notifier=self._notifier,
                reason=reason,
                on_case_event=self._on_case_event,
            )
        )
        if needs:
            escalated.decision = {**(escalated.decision or {}), "needs": needs}
            await self._repo.cs_cases.put(escalated)


async def refund_assist(input: RefundAssistInput) -> CsCase:
    """EC:D* I1 I2 -- cs.refund_assist({case, ...refund deps}) -> CsCase

    EC:J1-J5 -- wrapped in run_idempotent so a retried refund_assist call replays the first
    CsCase instead of re-evaluating/re-executing the refund and re-escalating/re-resolving the
    case.
    """
    key = input.idempotency_key or f"refund-assist:{input.case.id}:{input.payment.id}"

    result = await run_idempotent(
        repo=input.repo,
        clock=input.clock,
        key=key,
        kind="cs.refundAssist",
        payload={
            "case_id": input.case.id,
            "payment_id": input.payment.id,
            "requested_amount": input.requested_amount,
            "provider_fee_minor": input.provider_fee_minor,
            "churn_reason": input.churn_reason,
        },
        serialize=serialize_cs_case,
        deserialize=deserialize_cs_case,
        fn=lambda: _do_refund_assist(input),
    )
    return result.result


async def _do_refund_assist(input: RefundAssistInput) -> CsCase:
    policy = input.case.policy_snapshot
    if input.payment.customer_id != input.case.customer_id:
        return await reject(
            RejectInput(
                case=input.case,
                reason="payment does not belong to case customer",
                repo=input.repo,
                clock=input.clock,
                on_case_event=input.on_case_event,
                reporter=input.reporter,
            )
        )
    decision = await input.refund_evaluate(
        payment=input.payment,
        sub=input.sub,
        policy=policy,
        ledger=input.ledger,
        repo=input.repo,
        clock=input.clock,
        requested_amount=input.requested_amount,
        provider_fee_minor=input.provider_fee_minor,
    )
    if not decision.eligible:
        return await reject(
            RejectInput(
                case=input.case,
                reason=decision.reason,
                repo=input.repo,
                clock=input.clock,
                on_case_event=input.on_case_event,
                reporter=input.reporter,
            )
        )

    # EC:I2 -- fraud/velocity: force human review regardless of decision.needs_human
    window_start = input.clock.now() - timedelta(days=policy.cs.fraud.window_days)
    recent = len(
        [
            r
            for r in await input.repo.refunds.list(customer_id=input.case.customer_id)
            if r.status == "succeeded" and r.created_at >= window_start
        ]
    )
    if recent >= policy.cs.fraud.refund_velocity:
        return await escalate(
            EscalateInput(
                case=input.case,
                repo=input.repo,
                clock=input.clock,
                notifier=input.notifier,
                reason=f"I2 fraud: {recent} refunds in {policy.cs.fraud.window_days}d >= velocity {policy.cs.fraud.refund_velocity}",
                on_case_event=input.on_case_event,
            )
        )

    # EC:I1 -- auto-approve limits (already folded into decision.needs_human by refund.evaluate)
    if decision.needs_human:
        return await escalate(
            EscalateInput(
                case=input.case,
                repo=input.repo,
                clock=input.clock,
                notifier=input.notifier,
                reason=decision.reason,
                on_case_event=input.on_case_event,
            )
        )

    cs_opener = _CsOpenerAdapter(
        policy,
        input.repo,
        input.clock,
        input.ids,
        input.notifier,
        input.on_case_event,
    )
    refund = await input.refund_execute(
        decision=decision,
        provider=input.provider,
        ledger=input.ledger,
        repo=input.repo,
        clock=input.clock,
        ids=input.ids,
        cs=cs_opener,
        correlation_id=input.correlation_id,
    )

    if refund.status != "succeeded":
        input.case.decision = {"decision": decision, "refund": refund}
        return await escalate(
            EscalateInput(
                case=input.case,
                repo=input.repo,
                clock=input.clock,
                notifier=input.notifier,
                reason=refund.failure.user_message
                if refund.failure
                else f"refund {refund.status}",
                on_case_event=input.on_case_event,
            )
        )

    resolved = await resolve(
        ResolveInput(
            case=input.case,
            by="auto",
            decision={"decision": decision, "refund": refund},
            repo=input.repo,
            clock=input.clock,
            on_case_event=input.on_case_event,
            reporter=input.reporter,
        )
    )
    if input.churn_reason is not None:
        await record_churn(
            ChurnRecordInput(
                customer_id=input.case.customer_id,
                reason=input.churn_reason,
                text=input.churn_text,
                case=resolved,
                repo=input.repo,
                clock=input.clock,
                on_case_event=input.on_case_event,
            )
        )  # I4
    return resolved
