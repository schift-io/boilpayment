"""spec/refund.pseudo.md — EC:D8"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from boilpayment_core import (
    Clock,
    IdGen,
    LedgerReference,
    LedgerStore,
    Money,
    NewLedgerEntry,
    NormalizedEvent,
    PaymentKitError,
    Refund,
    Repo,
)

from .util import weighted_avg_unit_price


class ReconcileMismatchCaseOpener(Protocol):
    """Injected instead of importing `boilpayment_cs` directly (EC:D8)."""

    async def open_reconcile_mismatch_case(
        self, *, customer_id: str, reference_id: str, reason: str
    ) -> None: ...


@dataclass(kw_only=True, slots=True)
class OnExternalRefundInput:
    event: NormalizedEvent
    ledger: LedgerStore
    repo: Repo
    cs: ReconcileMismatchCaseOpener
    clock: Clock
    ids: IdGen
    refund_ref: str | None = None
    # EC:L5 -- optional delivery-scoped correlation id for callers that did NOT come through
    # webhook.process's own ledger wrapping. Merged into reference.correlation_id on the revoke
    # entry this call writes.
    correlation_id: str | None = None


async def on_external_refund(input: OnExternalRefundInput) -> Refund:
    """EC:onExternalRefund -- refund.on_external_refund({event, ledger, repo, cs, clock, ids})"""
    event, ledger, repo, cs, clock, ids = (
        input.event,
        input.ledger,
        input.repo,
        input.cs,
        input.clock,
        input.ids,
    )
    correlation_id = input.correlation_id
    now = clock.now()
    refund_ref = input.refund_ref or event.refund_ref

    payments = (
        await repo.payments.list(
            provider_ref=event.payment_ref, provider=event.provider
        )
        if event.payment_ref
        else []
    )
    payment = payments[0] if payments else None
    if payment is None and refund_ref and not event.payment_ref:
        candidates = await repo.refunds.list(provider_ref=refund_ref)
        for candidate in candidates:
            linked = await repo.payments.get(candidate.payment_id)
            if linked is not None and linked.provider == event.provider:
                if payment is not None and payment.id != linked.id:
                    raise PaymentKitError(
                        "ambiguous provider refund reference",
                        "refund_reconciliation_required",
                    )
                payment = linked

    refunds = await repo.refunds.list(payment_id=payment.id) if payment else []
    existing = next(
        (
            refund
            for refund in refunds
            if refund_ref and refund.provider_ref == refund_ref
        ),
        None,
    )
    if existing is not None and existing.status != "pending":
        return existing
    pending = (
        existing
        if refund_ref and existing is not None and existing.status == "pending"
        else None
    )
    unresolved = [refund for refund in refunds if refund.status == "pending"]
    if pending is None and unresolved:
        await cs.open_reconcile_mismatch_case(
            customer_id=payment.customer_id if payment else "unknown",
            reference_id=event.id,
            reason="pending refund requires a matching provider refund reference",
        )
        if len(unresolved) == 1:
            return unresolved[0]
        raise PaymentKitError(
            "multiple pending refunds cannot be correlated",
            "refund_reconciliation_required",
        )

    if pending and event.type == "refund.pending":
        return pending
    settlement_amount = event.amount or (pending.amount if pending else None)
    if not refund_ref or settlement_amount is None:
        await cs.open_reconcile_mismatch_case(
            customer_id=payment.customer_id if payment else "unknown",
            reference_id=event.id,
            reason="external refund requires an actual refund reference and amount",
        )
        raise PaymentKitError(
            "external refund evidence is incomplete", "refund_reconciliation_required"
        )

    refund_id = pending.id if pending else ids.new_id()
    status = (
        "failed"
        if event.type == "refund.failed"
        else "pending"
        if event.type == "refund.pending"
        else "succeeded"
    )

    if payment is None:
        await cs.open_reconcile_mismatch_case(
            customer_id=event.customer_ref or "unknown",
            reference_id=event.payment_ref or event.id,
            reason="no matching payment for external refund event",
        )
        raise PaymentKitError(
            "external refund payment was not found", "refund_reconciliation_required"
        )

    pending_credits = 0
    if pending is not None:
        if event.amount is not None and event.amount != pending.amount:
            await cs.open_reconcile_mismatch_case(
                customer_id=payment.customer_id,
                reference_id=pending.id,
                reason="pending refund amount differs from settlement event",
            )
            return pending
        held = -sum(
            entry.amount
            for entry in await ledger.entries(payment.customer_id, kind="hold")
            if entry.reference.refund_id == pending.id
        )
        pending_credits = held
        if held > 0:
            await ledger.append(
                NewLedgerEntry(
                    customer_id=payment.customer_id,
                    pool="paid",
                    kind="release",
                    amount=held,
                    source="refund",
                    reference=LedgerReference(
                        payment_id=payment.id, refund_id=refund_id
                    ),
                    idempotency_key=f"release:refund:{refund_id}",
                    actor="system",
                    reason="pending refund settled",
                )
            )

    already_refunded_minor = sum(
        r.amount.amount_minor
        for r in await repo.refunds.list(payment_id=payment.id)
        if r.status == "succeeded"
    )
    amount_minor = settlement_amount.amount_minor
    currency = settlement_amount.currency

    grants = [
        e
        for e in await ledger.entries(payment.customer_id, kind="grant")
        if e.reference.payment_id == payment.id
        and e.source in ("subscription", "topup")
    ]
    total_granted = sum(g.amount for g in grants)
    already_revoked = sum(
        -e.amount
        for e in await ledger.entries(payment.customer_id, kind="revoke")
        if e.reference.payment_id == payment.id and e.source == "refund"
    )
    unit_price = weighted_avg_unit_price(grants)
    raw_credits = (
        pending_credits
        if pending
        else round(amount_minor / unit_price)
        if unit_price > 0
        else 0
    )
    balance = await ledger.balance(
        payment.customer_id, "paid", now=clock.now()
    )  # FINDINGS#1 class
    credits_to_revoke = (
        pending_credits
        if pending
        else max(
            0, min(raw_credits, total_granted - already_revoked, balance.available)
        )
    )

    if credits_to_revoke > 0 and event.type == "refund.created":
        await ledger.append(
            NewLedgerEntry(
                customer_id=payment.customer_id,
                pool="paid",
                kind="revoke",
                amount=-credits_to_revoke,
                source="refund",
                reference=LedgerReference(
                    payment_id=payment.id,
                    refund_id=refund_id,
                    correlation_id=correlation_id,
                ),
                idempotency_key=f"revoke:refund:{refund_id}",
                actor="system",
                reason="D8 external refund reconcile",
            )
        )

    refund = Refund(
        id=refund_id,
        payment_id=payment.id,
        customer_id=payment.customer_id,
        amount=Money(amount_minor=amount_minor, currency=currency),
        status=status,
        provider_ref=refund_ref,
        credits_revoked=credits_to_revoke if status == "succeeded" else 0,
        rule_id=pending.rule_id if pending else "D8",
        reason=pending.reason if pending else "external refund reconcile",
        failure=None,
        created_at=pending.created_at if pending else now,
    )
    await repo.refunds.put(refund)

    if status == "succeeded":
        total_refunded = already_refunded_minor + amount_minor
        payment.status = (
            "refunded"
            if total_refunded >= payment.amount.amount_minor
            else "partially_refunded"
        )
        await repo.payments.put(payment)

    mismatch = event.amount is None or raw_credits != credits_to_revoke
    if mismatch:
        reason = (
            "external refund event carried no amount"
            if event.amount is None
            else f"computed credits {raw_credits} clamped to {credits_to_revoke}"
        )
        await cs.open_reconcile_mismatch_case(
            customer_id=payment.customer_id, reference_id=refund.id, reason=reason
        )
    return refund
