"""spec/cs.pseudo.md — EC:B18

Chargeback evidence workflow. `cs.dispute` (dispute.py, EC:B11 D9) already freezes/revokes/
restores credits and escalates the case to a human -- this module adds the missing piece the audit
flagged (2026-09-09 edge-case audit #4): collecting what the kit already knows about a
disputed payment into the checklist a card network expects, tracking the network's deadline, and
(when the provider supports it) submitting it programmatically.

Honesty over completeness: every item the kit cannot actually back with data comes back
`available=False` with a `reason`, never a fabricated value. Mirrors packages/cs/ts/src/evidence.ts
exactly.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Protocol, runtime_checkable

from boilpayment_core import (
    Clock,
    CsCase,
    LedgerStore,
    Notifier,
    Payment,
    Policy,
    Repo,
    Subscription,
)
from boilpayment_core.money import round_half_away_from_zero

from .cases import ACTIVE_STATUSES, EscalateInput, OnCaseEvent, escalate

# ── Public types ─────────────────────────────────────────────────────────────────────────


@dataclass(kw_only=True, slots=True)
class EvidenceItem:
    key: str
    label: str
    required: bool
    available: bool
    value: Any = None
    # Set whenever available is False -- the honest reason the kit does not have this item.
    reason: str | None = None


@dataclass(kw_only=True, slots=True)
class EvidenceRecord:
    items: list[EvidenceItem]
    due_at: str  # ISO -- dispute case opened_at + policy.dispute.evidence_due_days
    collected_at: str  # ISO
    submitted_at: str | None = None
    provider_ref: str | None = None


@dataclass(kw_only=True, slots=True)
class ChecklistInput:
    case: CsCase
    payment: Payment | None
    sub: Subscription | None = None
    repo: Repo
    ledger: LedgerStore
    policy: Policy
    clock: Clock


# ── Deadline ─────────────────────────────────────────────────────────────────────────────

_DAY = timedelta(days=1)


def evidence_due_at(case: CsCase) -> datetime:
    """EC:B18 -- due_at = the dispute case's own opened_at + its policy_snapshot's
    evidence_due_days, so a later policy change never moves a deadline a case was already given
    (EC:I8 pattern)."""
    days = case.policy_snapshot.dispute.evidence_due_days
    return case.opened_at + days * _DAY


# ── checklist ────────────────────────────────────────────────────────────────────────────


async def checklist(input: ChecklistInput) -> list[EvidenceItem]:
    """EC:B18 -- cs.evidence.checklist(case, payment, sub, repo, ledger, policy, clock) ->
    list[EvidenceItem]. Derives the checklist entirely from what the kit already knows; never
    invents data."""
    case = input.case
    payment = input.payment
    sub = input.sub
    repo = input.repo
    ledger = input.ledger
    items: list[EvidenceItem] = []

    # 1 -- the payment record and its provider refs.
    if payment is not None:
        items.append(
            EvidenceItem(
                key="payment_record",
                label="Payment record and provider reference",
                required=True,
                available=True,
                value={
                    "id": payment.id,
                    "provider": payment.provider,
                    "provider_ref": payment.provider_ref,
                    "amount": payment.amount,
                    "status": payment.status,
                    "kind": payment.kind,
                    "occurred_at": payment.occurred_at,
                    "subscription_id": payment.subscription_id,
                },
            )
        )
    else:
        items.append(
            EvidenceItem(
                key="payment_record",
                label="Payment record and provider reference",
                required=True,
                available=False,
                reason="no local payment record could be matched to this dispute",
            )
        )

    # 2/3 -- ledger grant/consume history: for a credits business this is the strongest evidence
    # there is -- grant = the goods were delivered, consume = the customer actually used them.
    grant_entries = []
    consume_entries = []
    if payment is not None:
        all_entries = await ledger.entries(case.customer_id, pool="paid")
        grant_entries = [
            e
            for e in all_entries
            if e.kind == "grant" and e.reference.payment_id == payment.id
        ]
        grant_ids = {g.id for g in grant_entries}
        consume_entries = [
            e
            for e in all_entries
            if e.kind == "consume" and e.reference.grant_id in grant_ids
        ]

    if grant_entries:
        items.append(
            EvidenceItem(
                key="proof_of_delivery",
                label="Proof of delivery -- credits granted for this payment",
                required=True,
                available=True,
                value=[
                    {
                        "id": e.id,
                        "amount": e.amount,
                        "created_at": e.created_at,
                        "expires_at": e.expires_at,
                    }
                    for e in grant_entries
                ],
            )
        )
    else:
        items.append(
            EvidenceItem(
                key="proof_of_delivery",
                label="Proof of delivery -- credits granted for this payment",
                required=True,
                available=False,
                reason=(
                    "no ledger grant entries reference this payment"
                    if payment is not None
                    else "no payment to look up grants for"
                ),
            )
        )

    if consume_entries:
        items.append(
            EvidenceItem(
                key="proof_of_usage",
                label="Proof of usage -- the customer consumed the granted credits",
                required=True,
                available=True,
                value=[
                    {"id": e.id, "amount": e.amount, "created_at": e.created_at}
                    for e in consume_entries
                ],
            )
        )
    else:
        items.append(
            EvidenceItem(
                key="proof_of_usage",
                label="Proof of usage -- the customer consumed the granted credits",
                required=True,
                available=False,
                reason=(
                    "credits were granted but no consume entries exist against them yet"
                    if grant_entries
                    else "no granted credits to have been consumed"
                ),
            )
        )

    # 4 -- usage events, when this is a usage-metered subscription.
    scoped_usage = []
    if sub is not None:
        usage_events = await repo.usage_events.list(customer_id=case.customer_id)
        scoped_usage = [
            e for e in usage_events if e.period_start >= sub.current_period.start
        ]
    if scoped_usage:
        items.append(
            EvidenceItem(
                key="usage_events",
                label="Metered usage events for the disputed period",
                required=False,
                available=True,
                value=[
                    {
                        "id": e.id,
                        "meter": e.meter,
                        "quantity": e.quantity,
                        "occurred_at": e.occurred_at,
                    }
                    for e in scoped_usage
                ],
            )
        )
    else:
        items.append(
            EvidenceItem(
                key="usage_events",
                label="Metered usage events for the disputed period",
                required=False,
                available=False,
                reason=(
                    "no usage events recorded for the current period"
                    if sub is not None
                    else "not a usage-metered subscription"
                ),
            )
        )

    # 5 -- customer's acceptance of terms. The kit has no such table -- this is always an honest gap.
    items.append(
        EvidenceItem(
            key="customer_acceptance",
            label="Customer acceptance of terms of service",
            required=True,
            available=False,
            reason="not recorded by the kit -- attach it from your own signup/terms-acceptance log if you have one",
        )
    )

    # 6 -- refund/communication history: attempts to resolve show good faith to the network.
    refunds = (
        await repo.refunds.list(payment_id=payment.id) if payment is not None else []
    )
    if refunds:
        items.append(
            EvidenceItem(
                key="refund_communication",
                label="Refund requests and outcomes for this payment",
                required=False,
                available=True,
                value=[
                    {
                        "id": r.id,
                        "status": r.status,
                        "amount": r.amount,
                        "reason": r.reason,
                        "created_at": r.created_at,
                    }
                    for r in refunds
                ],
            )
        )
    else:
        items.append(
            EvidenceItem(
                key="refund_communication",
                label="Refund requests and outcomes for this payment",
                required=False,
                available=False,
                reason="no refund requests found for this payment",
            )
        )

    # 7 -- the cs_events trail: duck-typed against a `cs_events` table (schema-postgres 0006, not
    # part of the core Repo contract -- same degrade pattern as reconcile.check_balances'
    # `credit_balances`). Falls back to the case's own lifecycle fields, which are ALWAYS available
    # since `case` is a required input -- this item is never a hard "no data" gap.
    trail: list[Any] | None = None
    cs_events = getattr(repo, "cs_events", None)
    if cs_events is not None and hasattr(cs_events, "list"):
        try:
            rows = await cs_events.list(case_id=case.id)
            if rows:
                trail = rows
        except Exception:  # noqa: BLE001 - Any optional adapter failure must fall back to case fields.
            trail = None
    items.append(
        EvidenceItem(
            key="case_trail",
            label="CS case handling trail (internal record)",
            required=False,
            available=True,
            value=trail
            if trail is not None
            else {
                "status": case.status,
                "opened_at": case.opened_at,
                "escalated_at": getattr(case, "escalated_at", None),
                "resolved_at": case.resolved_at,
                "decision": case.decision,
            },
        )
    )

    return items


# ── collect ──────────────────────────────────────────────────────────────────────────────


@dataclass(kw_only=True, slots=True)
class CollectInput:
    case: CsCase
    payment: Payment | None
    sub: Subscription | None = None
    repo: Repo
    ledger: LedgerStore
    policy: Policy
    clock: Clock
    on_case_event: OnCaseEvent | None = None


async def collect(input: CollectInput) -> CsCase:
    """EC:B18 -- cs.evidence.collect(case, payment, sub, repo, ledger, policy, clock) -> CsCase.
    Fills the checklist and stores it on `case.decision["evidence"]`. Idempotent: pure re-read + a
    single `repo.cs_cases.put`, safe to call repeatedly (each call refreshes the checklist against
    current data -- no duplicate ledger writes, no duplicate escalations)."""
    case = input.case
    items = await checklist(
        ChecklistInput(
            case=case,
            payment=input.payment,
            sub=input.sub,
            repo=input.repo,
            ledger=input.ledger,
            policy=input.policy,
            clock=input.clock,
        )
    )
    record = EvidenceRecord(
        items=items,
        due_at=evidence_due_at(case).isoformat(),
        collected_at=input.clock.now().isoformat(),
    )
    case.decision = {**(case.decision or {}), "evidence": record}
    await input.repo.cs_cases.put(case)
    return case


# ── due (cron) ───────────────────────────────────────────────────────────────────────────


@dataclass(kw_only=True, slots=True)
class DueInput:
    repo: Repo
    clock: Clock
    notifier: Notifier | None = None
    on_case_event: OnCaseEvent | None = None


@dataclass(kw_only=True, slots=True)
class DueCase:
    case: CsCase
    due_at: datetime
    hours_remaining: float
    incomplete: bool


def _is_incomplete(case: CsCase) -> bool:
    decision = case.decision or {}
    record: EvidenceRecord | None = decision.get("evidence")
    if record is None:
        return True
    return any(i.required and not i.available for i in record.items)


async def due(input: DueInput) -> list[DueCase]:
    """EC:B18 -- cs.evidence.due(repo, clock) -> list[DueCase]. Meant to run off a cron. Scans open
    dispute cases; when a case is inside 24h of its evidence deadline AND still missing a required
    item, it (re-)escalates the case (cs.needs_human) so a human sees it before the network's clock
    runs out, and returns it in the result."""
    cases = await input.repo.cs_cases.list(kind="dispute")
    now = input.clock.now()
    out: list[DueCase] = []
    for case in cases:
        if case.status not in ACTIVE_STATUSES:
            continue
        due_at = evidence_due_at(case)
        hours_remaining = (due_at - now).total_seconds() / 3600
        incomplete = _is_incomplete(case)
        if hours_remaining <= 24 and incomplete:
            out.append(
                DueCase(
                    case=case,
                    due_at=due_at,
                    hours_remaining=hours_remaining,
                    incomplete=incomplete,
                )
            )
            await escalate(
                EscalateInput(
                    case=case,
                    repo=input.repo,
                    clock=input.clock,
                    notifier=input.notifier,
                    reason=f"evidence due in {max(0, round_half_away_from_zero(hours_remaining))}h, checklist incomplete",
                    on_case_event=input.on_case_event,
                )
            )
    return out


# ── submit ───────────────────────────────────────────────────────────────────────────────


@runtime_checkable
class DisputeEvidenceSubmitter(Protocol):
    """EC:B18 -- duck-typed against provider adapters that can submit evidence programmatically
    (Stripe has one; Toss/PortOne do not) -- same pattern as refund.execute's cash-receipt
    canceler."""

    async def submit_dispute_evidence(
        self, *, payment_ref: str, case_id: str, evidence: list[EvidenceItem]
    ) -> dict[str, Any] | None: ...


@dataclass(kw_only=True, slots=True)
class SubmitInput:
    case: CsCase
    payment: Payment | None
    sub: Subscription | None = None
    provider: Any  # duck-typed for submit_dispute_evidence
    repo: Repo
    ledger: LedgerStore
    policy: Policy
    clock: Clock
    notifier: Notifier | None = None
    on_case_event: OnCaseEvent | None = None


@dataclass(kw_only=True, slots=True)
class SubmitResult:
    submitted: bool
    reason: str | None = None
    portal_url: str | None = None
    provider_ref: str | None = None
    case: CsCase


async def submit(input: SubmitInput) -> SubmitResult:
    """EC:B18 -- cs.evidence.submit(case, payment, sub, provider, repo, ledger, policy, clock) ->
    SubmitResult. Never pretends a submission happened: a provider without
    `submit_dispute_evidence` (or one that raises) always comes back `submitted=False`, and the
    case is escalated with the checklist attached so a human can paste it into the provider's
    dashboard."""
    case = input.case
    payment = input.payment
    provider = input.provider

    decision = case.decision or {}
    record: EvidenceRecord | None = decision.get("evidence")
    if record is None:
        await collect(
            CollectInput(
                case=case,
                payment=payment,
                sub=input.sub,
                repo=input.repo,
                ledger=input.ledger,
                policy=input.policy,
                clock=input.clock,
                on_case_event=input.on_case_event,
            )
        )
        record = (case.decision or {})["evidence"]

    portal_url = getattr(provider, "dispute_portal_url", None)
    portal_url = portal_url if isinstance(portal_url, str) else None

    submit_fn = getattr(provider, "submit_dispute_evidence", None)
    if not callable(submit_fn):
        updated = await escalate(
            EscalateInput(
                case=case,
                repo=input.repo,
                clock=input.clock,
                notifier=input.notifier,
                reason="evidence submission not supported by this provider -- attach the checklist to the dashboard manually",
                on_case_event=input.on_case_event,
            )
        )
        return SubmitResult(
            submitted=False,
            reason="provider_unsupported",
            portal_url=portal_url,
            case=updated,
        )

    if payment is None:
        updated = await escalate(
            EscalateInput(
                case=case,
                repo=input.repo,
                clock=input.clock,
                notifier=input.notifier,
                reason="no payment record to submit evidence against",
                on_case_event=input.on_case_event,
            )
        )
        return SubmitResult(submitted=False, reason="no_payment", case=updated)

    try:
        result = await submit_fn(
            payment_ref=payment.provider_ref, case_id=case.id, evidence=record.items
        )
        provider_ref = result.get("provider_ref") if isinstance(result, dict) else None
        case.decision = {
            **(case.decision or {}),
            "evidence": EvidenceRecord(
                items=record.items,
                due_at=record.due_at,
                collected_at=record.collected_at,
                submitted_at=input.clock.now().isoformat(),
                provider_ref=provider_ref,
            ),
        }
        await input.repo.cs_cases.put(case)
        return SubmitResult(submitted=True, provider_ref=provider_ref, case=case)
    except Exception as err:  # noqa: BLE001 -- never pretend a submission happened
        updated = await escalate(
            EscalateInput(
                case=case,
                repo=input.repo,
                clock=input.clock,
                notifier=input.notifier,
                reason=f"evidence submission failed: {err}",
                on_case_event=input.on_case_event,
            )
        )
        return SubmitResult(
            submitted=False, reason="submit_failed", portal_url=portal_url, case=updated
        )
