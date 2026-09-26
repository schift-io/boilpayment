"""spec/cs.pseudo.md — EC:I3 I7 I8 I5"""

from __future__ import annotations

from collections.abc import Callable
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Any, Literal

from boilpayment_core import (
    Clock,
    CsCase,
    CsCaseKind,
    CsCaseStatus,
    IdGen,
    Notification,
    Notifier,
    Policy,
    Repo,
)

if TYPE_CHECKING:
    # Deferred to avoid a module-level circular import — metrics.py imports BILLABLE_STATUSES/
    # CsMetricEvent from this module. resolve()/reject() import CaseReportInput locally at call time.
    from .metrics import LicenseReporter

ACTIVE_STATUSES: tuple[CsCaseStatus, ...] = ("open", "needs_human")
BILLABLE_STATUSES: tuple[CsCaseStatus, ...] = (
    "resolved_auto",
    "resolved_human",
    "rejected",
)


@dataclass(kw_only=True, slots=True)
class CsMetricEvent:
    type: Literal["opened", "escalated", "resolved", "churn"]
    case: CsCase
    at: datetime
    churn_reason: str | None = None


OnCaseEvent = Callable[[CsMetricEvent], None]


@dataclass(kw_only=True, slots=True)
class OpenCaseInput:
    customer_id: str
    kind: CsCaseKind
    reference_id: str
    policy: Policy
    repo: Repo
    clock: Clock
    ids: IdGen
    on_case_event: OnCaseEvent | None = None


async def open_case(input: OpenCaseInput) -> CsCase:
    """EC:I7 I8 -- cs.open_case({customer_id, kind, reference_id, policy, repo, clock, ids}) -> CsCase"""
    existing = await input.repo.cs_cases.list(
        customer_id=input.customer_id, kind=input.kind, reference_id=input.reference_id
    )
    active = next((c for c in existing if c.status in ACTIVE_STATUSES), None)
    if active is not None:
        return active  # I7 dedupe

    now = input.clock.now()
    case = CsCase(
        id=input.ids.new_id(),
        customer_id=input.customer_id,
        kind=input.kind,
        status="open",
        reference_id=input.reference_id,
        policy_snapshot=deepcopy(input.policy),  # I8
        decision=None,
        churn_reason=None,
        churn_text=None,
        opened_at=now,
        resolved_at=None,
    )
    await input.repo.cs_cases.put(case)
    if input.on_case_event:
        input.on_case_event(CsMetricEvent(type="opened", case=case, at=now))
    return case


@dataclass(kw_only=True, slots=True)
class EscalateInput:
    case: CsCase
    repo: Repo
    clock: Clock
    reason: str
    notifier: Notifier | None = None
    on_case_event: OnCaseEvent | None = None


async def escalate(input: EscalateInput) -> CsCase:
    """EC:I3 -- cs.escalate(case, notifier, reason) -> needs_human + notifier 'cs.needs_human'"""
    case = input.case
    case.status = "needs_human"
    case.decision = {**(case.decision or {}), "escalateReason": input.reason}
    await input.repo.cs_cases.put(case)
    if input.notifier:
        await input.notifier.send(
            Notification(
                type="cs.needs_human",
                customer_id=case.customer_id,
                payload={"caseId": case.id, "kind": case.kind, "reason": input.reason},
            )
        )
    if input.on_case_event:
        input.on_case_event(
            CsMetricEvent(type="escalated", case=case, at=input.clock.now())
        )
    return case


@dataclass(kw_only=True, slots=True)
class ResolveInput:
    case: CsCase
    by: Literal["auto", "human"]
    decision: dict[str, Any]
    repo: Repo
    clock: Clock
    on_case_event: OnCaseEvent | None = None
    # EC:I5 -- reports this billable transition (resolved_auto/resolved_human) to the license server.
    reporter: LicenseReporter | None = None


async def resolve(input: ResolveInput) -> CsCase:
    """cs.resolve(case, by, decision) -- EC:I5"""
    case = input.case
    case.status = "resolved_auto" if input.by == "auto" else "resolved_human"
    case.decision = input.decision
    case.resolved_at = input.clock.now()
    await input.repo.cs_cases.put(case)
    if input.on_case_event:
        input.on_case_event(
            CsMetricEvent(type="resolved", case=case, at=case.resolved_at)
        )
    if input.reporter is not None:
        from .metrics import (
            CaseReportInput,
        )  # local import -- avoids module-level circular import

        await input.reporter.report_case(
            CaseReportInput(
                case_id=case.id,
                kind=case.kind,
                status=case.status,
                tenant_ref=case.customer_id,
                occurred_at=case.resolved_at,
            )
        )
    return case


@dataclass(kw_only=True, slots=True)
class RejectInput:
    case: CsCase
    reason: str
    repo: Repo
    clock: Clock
    on_case_event: OnCaseEvent | None = None
    # EC:I5 -- reports this billable transition (rejected) to the license server.
    reporter: LicenseReporter | None = None


async def reject(input: RejectInput) -> CsCase:
    """cs.reject -- local extension used by regrant/refund_assist for terminal denials. EC:I5"""
    case = input.case
    case.status = "rejected"
    case.decision = {"reason": input.reason}
    case.resolved_at = input.clock.now()
    await input.repo.cs_cases.put(case)
    if input.on_case_event:
        input.on_case_event(
            CsMetricEvent(type="resolved", case=case, at=case.resolved_at)
        )
    if input.reporter is not None:
        from .metrics import (
            CaseReportInput,
        )  # local import -- avoids module-level circular import

        await input.reporter.report_case(
            CaseReportInput(
                case_id=case.id,
                kind=case.kind,
                status=case.status,
                tenant_ref=case.customer_id,
                occurred_at=case.resolved_at,
            )
        )
    return case
