"""Confirm the original support case after stored pending refunds settle."""

from __future__ import annotations

from dataclasses import dataclass

from boilpayment_core import Clock, CsCase, Notifier, Refund, Repo

from .cases import EscalateInput, OnCaseEvent, ResolveInput, escalate, resolve
from .metrics import LicenseReporter


@dataclass(frozen=True, slots=True, kw_only=True)
class FinishRefundCasesInput:
    repo: Repo
    clock: Clock
    notifier: Notifier | None = None
    on_case_event: OnCaseEvent | None = None
    reporter: LicenseReporter | None = None


async def finish_refund_cases(input: FinishRefundCasesInput) -> list[CsCase]:
    cases = await input.repo.cs_cases.list(kind="refund", status="needs_human")
    updated: list[CsCase] = []
    for case in cases:
        prior = (case.decision or {}).get("refund")
        match prior:
            case Refund(id=refund_id):
                pass
            case {"id": str() as refund_id}:
                pass
            case _:
                continue
        refund = await input.repo.refunds.get(refund_id)
        if (
            refund is None
            or refund.customer_id != case.customer_id
            or refund.payment_id != case.reference_id
        ):
            continue
        if refund.status == "succeeded":
            updated.append(
                await resolve(
                    ResolveInput(
                        reporter=input.reporter,
                        case=case,
                        by="auto",
                        decision={**(case.decision or {}), "refund": refund},
                        repo=input.repo,
                        clock=input.clock,
                        on_case_event=input.on_case_event,
                    )
                )
            )
        elif refund.status == "failed":
            case.decision = {**(case.decision or {}), "refund": refund}
            updated.append(
                await escalate(
                    EscalateInput(
                        case=case,
                        reason=refund.failure.user_message
                        if refund.failure
                        else "refund failed; follow-up required",
                        repo=input.repo,
                        clock=input.clock,
                        notifier=input.notifier,
                        on_case_event=input.on_case_event,
                    )
                )
            )
    return updated
