"""Recover missing credit grants from verified payments and persisted entitlements."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Protocol, assert_never

from boilpayment_core import (
    Clock,
    CsCase,
    LedgerEntry,
    LedgerStore,
    Payment,
    Period,
    Plan,
    Policy,
    Repo,
    Subscription,
    deserialize_cs_case,
    key_matches_instant,
    run_idempotent,
    serialize_cs_case,
)

from .apply_purchased_grant import apply_purchased_grant
from .cases import EscalateInput, RejectInput, ResolveInput, escalate, reject, resolve
from .purchase_snapshot import get_purchase_snapshot
from .support import (
    SupportDeps,
    SupportPaymentInput,
    UnverifiedPayment,
    VerifiedPayment,
    verify_support_payment,
)


class SupportGrantOutcome(Protocol):
    entry: LedgerEntry | None
    duplicated: bool
    deferred: bool


class SupportGrants(Protocol):
    async def topup(
        self,
        *,
        customer_id: str,
        payment: Payment,
        credits: int,
        policy: Policy,
        ledger: LedgerStore,
        repo: Repo,
        clock: Clock,
    ) -> SupportGrantOutcome: ...
    async def grant_for_period(
        self,
        *,
        sub: Subscription,
        plan: Plan,
        period: Period,
        payment: Payment,
        policy: Policy,
        ledger: LedgerStore,
        clock: Clock,
    ) -> SupportGrantOutcome: ...


@dataclass(frozen=True, slots=True, kw_only=True)
class RecoverMissingGrantInput(SupportPaymentInput):
    grants: SupportGrants


@dataclass(frozen=True, slots=True, kw_only=True)
class RecoverMissingGrantsInput(SupportDeps):
    grants: SupportGrants
    customer_id: str | None = None
    since: datetime | None = None


async def recover_missing_grant(input: RecoverMissingGrantInput) -> CsCase:
    """Replay original credit primitives; the customer cannot provide grant amounts or approval."""
    recorded = await input.repo.operations.get(
        f"support-case:regrant:{input.customer_id}:{input.payment_id}:"
    )
    if recorded and recorded.status == "done":
        stored = await input.repo.cs_cases.get(deserialize_cs_case(recorded.result).id)
        if stored and stored.status in ("resolved_auto", "resolved_human", "rejected"):
            return stored
    verification = await verify_support_payment(input, kind="regrant")
    match verification:
        case UnverifiedPayment(case=case):
            return case
        case VerifiedPayment(case=case, payment=payment):
            pass
        case unreachable:
            assert_never(unreachable)
    policy = case.policy_snapshot

    async def hold(reason: str) -> CsCase:
        return await escalate(
            EscalateInput(
                case=case,
                reason=reason,
                repo=input.repo,
                clock=input.clock,
                on_case_event=input.on_case_event,
                notifier=input.notifier,
            )
        )

    if payment.status != "succeeded":
        return await hold("only an unrefunded successful payment can recover credits")
    if policy.cs.regrant.mode == "off":
        return await reject(
            RejectInput(
                reporter=input.reporter,
                case=case,
                reason="cs.regrant.mode=off",
                repo=input.repo,
                clock=input.clock,
                on_case_event=input.on_case_event,
            )
        )
    snapshot = await get_purchase_snapshot(payment_id=payment.id, repo=input.repo)
    if (
        not snapshot
        or snapshot.customer_id != input.customer_id
        or snapshot.payment_ref != payment.provider_ref
        or snapshot.provider != payment.provider
        or snapshot.price.currency != payment.amount.currency
        or snapshot.price.amount_minor != payment.amount.amount_minor
        or snapshot.plan.credits_per_period <= 0
    ):
        return await hold("immutable purchase entitlement is missing or inconsistent")
    credits = snapshot.plan.credits_per_period
    grant_key = (
        f"topup:{payment.id}"
        if snapshot.plan.interval is None
        else f"grant:{snapshot.subscription_id}:{snapshot.period['start']}"
        if snapshot.subscription_id and snapshot.period
        else None
    )
    if not grant_key:
        return await hold("subscription purchase evidence missing")
    if policy.cs.regrant.mode == "manual_approve":
        return await hold("cs.regrant.mode=manual_approve, awaiting approval")

    async def complete() -> CsCase:
        entries = await input.ledger.entries(input.customer_id, kind="grant")
        existing = next(
            (
                entry
                for entry in entries
                if entry.idempotency_key == grant_key
                or (
                    snapshot.plan.interval is not None
                    and snapshot.subscription_id
                    and snapshot.period
                    and key_matches_instant(
                        entry.idempotency_key,
                        f"grant:{snapshot.subscription_id}:",
                        datetime.fromisoformat(str(snapshot.period["start"])),
                    )
                )
            ),
            None,
        )  # EC:J11
        if existing:
            return await resolve(
                ResolveInput(
                    reporter=input.reporter,
                    case=case,
                    by="auto",
                    decision={
                        "granted": False,
                        "entryId": existing.id,
                        "paymentId": payment.id,
                        "idempotencyKey": grant_key,
                    },
                    repo=input.repo,
                    clock=input.clock,
                    on_case_event=input.on_case_event,
                )
            )
        outcome = await apply_purchased_grant(input)
        if outcome.entry is None or outcome.deferred:
            return await hold("credit grant was deferred")
        return await resolve(
            ResolveInput(
                reporter=input.reporter,
                case=case,
                by="auto",
                decision={
                    "granted": not outcome.duplicated,
                    "entryId": outcome.entry.id,
                    "paymentId": payment.id,
                    "credits": credits,
                    "idempotencyKey": grant_key,
                },
                repo=input.repo,
                clock=input.clock,
                on_case_event=input.on_case_event,
            )
        )

    completed = await run_idempotent(
        repo=input.repo,
        clock=input.clock,
        key=f"support-recover-complete:{case.id}",
        kind="cs.recoverMissingGrant",
        payload={"grant_key": grant_key},
        serialize=serialize_cs_case,
        deserialize=deserialize_cs_case,
        fn=complete,
    )
    return await input.repo.cs_cases.get(completed.result.id) or completed.result


async def recover_missing_grants(input: RecoverMissingGrantsInput) -> list[CsCase]:
    """Only locally recorded payments are recoverable; provider-only orphans need reconciliation."""
    payments = (
        await input.repo.payments.list(customer_id=input.customer_id)
        if input.customer_id
        else await input.repo.payments.list()
    )
    results: list[CsCase] = []
    for payment in payments:
        if (
            input.since and payment.occurred_at < input.since
        ) or payment.kind == "overage":
            continue
        # EC:A46 -- a declined charge bought nothing; a pending self-scheduled attempt belongs to the scheduler.
        if payment.status == "failed":
            continue
        raw = payment.raw if isinstance(payment.raw, dict) else {}
        if payment.status == "pending" and raw.get("boilpaymentAttemptKey"):
            continue
        entries = await input.ledger.entries(payment.customer_id, kind="grant")
        if any(entry.reference.payment_id == payment.id for entry in entries):
            continue
        # EC:A46 -- already handed to a person: report the open case again, do not re-notify.
        recorded = await input.repo.operations.get(f"support-case:regrant:{payment.customer_id}:{payment.id}:")
        if recorded and recorded.status == "done":
            open_case = await input.repo.cs_cases.get(deserialize_cs_case(recorded.result).id)
            if open_case is not None and open_case.status == "needs_human":
                results.append(open_case)
                continue
        results.append(
            await recover_missing_grant(
                RecoverMissingGrantInput(
                    customer_id=payment.customer_id,
                    payment_id=payment.id,
                    policy=input.policy,
                    providers=input.providers,
                    ledger=input.ledger,
                    repo=input.repo,
                    clock=input.clock,
                    ids=input.ids,
                    grants=input.grants,
                    notifier=input.notifier,
                    on_case_event=input.on_case_event,
                )
            )
        )
    return results


ApplyPurchasedGrantInput = RecoverMissingGrantInput
