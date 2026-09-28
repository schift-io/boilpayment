"""Internal append-only grace-expiry closure after a successful recovery payment."""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass

from boilpayment_core import (
    GRACE_EXPIRY_END_REASON,
    Clock,
    LedgerEntry,
    LedgerStore,
    NewLedgerEntry,
    Subscription,
)


@dataclass(frozen=True, slots=True, kw_only=True)
class EndGraceExpiryInput:
    sub: Subscription
    current_grant: LedgerEntry
    ledger: LedgerStore
    clock: Clock


async def end_grace_expiry(input: EndGraceExpiryInput) -> None:
    """Preemptively cap dated prior-period grants once the paid-period grant exists."""
    paid_period_start = input.current_grant.reference.period_start
    if paid_period_start is None:
        return
    entries = await input.ledger.entries(input.sub.customer_id)
    prior_grants = [
        entry
        for entry in entries
        if entry.kind == "grant"
        and entry.source == "subscription"
        and entry.reference.subscription_id == input.sub.id
        and entry.reference.period_start is not None
        and entry.expires_at is not None
        and entry.reference.period_start < paid_period_start
    ]
    ended_at = input.clock.now()
    for grant in prior_grants:
        await input.ledger.append(
            NewLedgerEntry(
                customer_id=input.sub.customer_id,
                pool=grant.pool,
                kind="adjust",
                amount=0,
                unit_price_minor=None,
                currency=grant.currency,
                expires_at=ended_at,
                source="subscription",
                reference=dataclasses.replace(grant.reference, grant_id=grant.id),
                idempotency_key=(
                    f"adjust:grace-expiry-end:{input.sub.id}:{grant.id}"
                ),
                actor="system",
                reason=GRACE_EXPIRY_END_REASON,
            )
        )
