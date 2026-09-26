"""spec/refund.pseudo.md — EC:D8 D18"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
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
from boilpayment_core.money import round_half_away_from_zero

from .util import weighted_avg_unit_price


def credits_for_amount(amount_minor: int, unit_price: float) -> int:
    """EC:J9 -- credits an external refund of `amount_minor` stands for, rounded half away from zero
    (the same as the TS kit; built-in round() is half-to-even)."""
    return round_half_away_from_zero(amount_minor / unit_price) if unit_price > 0 else 0

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

    # EC:D18 -- the balance read, the revoke clamp and the refund write run under the customer's
    # ledger lock, the same one consume() takes, so a concurrent consume cannot spend the credits
    # between the balance read and the revoke (which drove the balance below zero under block).
    async def _settle() -> Refund:
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
            else credits_for_amount(amount_minor, unit_price)
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
            # EC:D18 -- revoke from grant buckets (reference.grant_id), this payment's grants first,
            # then the earliest-expiring others. A revoke tied to no grant lowered the balance but
            # left every bucket whole, so a later consume could still draw the revoked credits.
            parts = await _revoke_buckets(
                ledger, payment.customer_id, payment.id, credits_to_revoke, clock.now()
            )
            # Only an approved allow_negative pending refund can ask for more than the buckets hold;
            # that approved excess stays a grant-less revoke (the debt the policy allowed).
            excess = credits_to_revoke - sum(p for _, p in parts)
            if excess > 0:
                await ledger.append(
                    NewLedgerEntry(
                        customer_id=payment.customer_id,
                        pool="paid",
                        kind="revoke",
                        amount=-excess,
                        source="refund",
                        reference=LedgerReference(
                            payment_id=payment.id, refund_id=refund_id, correlation_id=correlation_id
                        ),
                        idempotency_key=f"revoke:refund:{refund_id}",
                        actor="system",
                        reason="D8 external refund reconcile",
                    )
                )
            for grant_id, part in parts:
                await ledger.append(
                    NewLedgerEntry(
                        customer_id=payment.customer_id,
                        pool="paid",
                        kind="revoke",
                        amount=-part,
                        source="refund",
                        reference=LedgerReference(
                            payment_id=payment.id,
                            refund_id=refund_id,
                            grant_id=grant_id,
                            correlation_id=correlation_id,
                        ),
                        idempotency_key=f"revoke:refund:{refund_id}:{grant_id}",
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

    return await ledger.transaction(payment.customer_id, _settle)


async def _revoke_buckets(
    ledger: LedgerStore, customer_id: str, payment_id: str, amount: int, now: datetime
) -> list[tuple[str, int]]:
    """EC:D18 -- split `amount` over live 'paid' grant buckets: grants bought by `payment_id` first,
    then the rest earliest-expiry first. Remaining per bucket = grant + every entry that names it.
    The caller clamps `amount` to the available balance, which never exceeds the buckets' total."""
    entries = await ledger.entries(customer_id, pool="paid")
    drawn: dict[str, int] = {}
    for e in entries:
        if e.kind != "grant" and e.reference.grant_id:
            drawn[e.reference.grant_id] = drawn.get(e.reference.grant_id, 0) + e.amount
    live = [
        (g, g.amount + drawn.get(g.id, 0))
        for g in entries
        if g.kind == "grant" and (g.expires_at is None or g.expires_at > now)
    ]
    live = [(g, rem) for g, rem in live if rem > 0]
    live.sort(key=lambda b: (
        b[0].reference.payment_id != payment_id,
        b[0].expires_at is None,
        b[0].expires_at or now,
        b[0].created_at,
    ))
    parts: list[tuple[str, int]] = []
    left = amount
    for g, rem in live:
        if left <= 0:
            break
        take = min(left, rem)
        parts.append((g.id, take))
        left -= take
    return parts
