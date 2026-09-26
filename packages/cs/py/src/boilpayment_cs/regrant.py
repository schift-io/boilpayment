"""spec/cs.pseudo.md — EC:A18 E1 E2 E14 I5 J1-J5"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING

from boilpayment_core import (
    Clock,
    CsCase,
    IdGen,
    LedgerReference,
    LedgerStore,
    NewLedgerEntry,
    Policy,
    Pool,
    Repo,
    deserialize_cs_case,
    run_idempotent,
    serialize_cs_case,
)

from .cases import (
    EscalateInput,
    OnCaseEvent,
    RejectInput,
    ResolveInput,
    escalate,
    reject,
    resolve,
)

if TYPE_CHECKING:
    from .metrics import LicenseReporter


@dataclass(kw_only=True, slots=True)
class RegrantPlan:
    customer_id: str | None = None
    pool: Pool
    amount: int
    unit_price_minor: int | None = None
    currency: str | None = None
    expires_at: datetime | None = None
    idempotency_key: str | None = None
    reason: str | None = None


@dataclass(kw_only=True, slots=True)
class RegrantInput:
    case: CsCase
    ledger: LedgerStore
    repo: Repo
    policy: Policy
    clock: Clock
    ids: IdGen
    plan: RegrantPlan
    approved_by: str | None = None
    on_case_event: OnCaseEvent | None = None
    # EC:I5 -- reports the resulting resolved_auto/rejected transition to the license server.
    reporter: LicenseReporter | None = None
    # EC:L5 -- optional delivery-scoped id, merged into reference.correlation_id on the grant
    # entry this call writes when it resolves in 'auto' mode.
    correlation_id: str | None = None


async def regrant(input: RegrantInput) -> CsCase:
    """EC:A18 E1 E2 E14 -- cs.regrant({case, ledger, repo, policy, clock, plan}) -> CsCase

    EC:J1-J5 -- wrapped in run_idempotent so a retried regrant call replays the first CsCase
    instead of re-resolving the case a second time. Default key reuses E1/E14's existing
    convention (plan.idempotency_key or case.reference_id) -- regrant was already
    ledger-append-safe; this adds Operation-level J2 (key reused with a different plan) / J3
    (in-flight duplicate) protection.
    """
    if (
        input.case.kind != "regrant"
        or (input.plan.customer_id and input.plan.customer_id != input.case.customer_id)
        or type(input.plan.amount) is not int
        or input.plan.amount <= 0
        or input.plan.amount > 9007199254740991
    ):
        return await reject(
            RejectInput(
                case=input.case,
                reason="invalid regrant case, customer or amount",
                repo=input.repo,
                clock=input.clock,
                on_case_event=input.on_case_event,
                reporter=input.reporter,
            )
        )
    idem_key = (
        input.plan.idempotency_key or input.case.reference_id
    )  # E1/E14 -- original key; late webhook = no-op
    previous = await input.repo.operations.get(idem_key)
    if (
        (previous is None or previous.status != "done")
        and input.case.policy_snapshot.cs.regrant.mode == "manual_approve"
        and not (input.approved_by or "").strip()
    ):
        return await escalate(
            EscalateInput(
                case=input.case,
                repo=input.repo,
                clock=input.clock,
                reason="cs.regrant.mode=manual_approve, awaiting approval",
                on_case_event=input.on_case_event,
            )
        )

    result = await run_idempotent(
        repo=input.repo,
        clock=input.clock,
        key=idem_key,
        kind="cs.regrant",
        # EC:J2 payload deliberately covers only {customer_id, pool, amount} -- the fields that
        # actually change what lands in the ledger -- not incidental fields like `reason` or
        # unit_price_minor/currency presentation: EC:E14's "a late-arriving duplicate must always
        # no-op" contract must hold even if the retry doesn't reproduce every optional field.
        payload={
            "case_id": input.case.id,
            "customer_id": input.plan.customer_id or input.case.customer_id,
            "pool": input.plan.pool,
            "amount": input.plan.amount,
        },
        serialize=serialize_cs_case,
        deserialize=deserialize_cs_case,
        fn=lambda: _do_regrant(input, idem_key),
    )
    return result.result


async def _do_regrant(input: RegrantInput, idem_key: str) -> CsCase:
    mode = input.case.policy_snapshot.cs.regrant.mode

    if mode == "off":
        return await reject(
            RejectInput(
                case=input.case,
                reason="cs.regrant.mode=off",
                repo=input.repo,
                clock=input.clock,
                on_case_event=input.on_case_event,
                reporter=input.reporter,
            )
        )
    # mode == "auto", or manual_approve with approved_by set
    plan = input.plan
    result = await input.ledger.append(
        NewLedgerEntry(
            customer_id=plan.customer_id or input.case.customer_id,
            pool=plan.pool,
            kind="grant",
            amount=plan.amount,
            unit_price_minor=plan.unit_price_minor,
            currency=plan.currency,
            expires_at=plan.expires_at,
            source="regrant",
            reference=LedgerReference(
                case_id=input.case.id, correlation_id=input.correlation_id
            ),
            idempotency_key=idem_key,
            actor="cs",
            reason=plan.reason or f"regrant: case {input.case.id}",
        )
    )
    decision = {
        "granted": not result.duplicated,
        "entryId": result.entry.id,
        "idempotencyKey": idem_key,
        "approvedBy": input.approved_by,
    }
    return await resolve(
        ResolveInput(
            case=input.case,
            by="auto",
            decision=decision,
            repo=input.repo,
            clock=input.clock,
            on_case_event=input.on_case_event,
            reporter=input.reporter,
        )
    )  # E2
