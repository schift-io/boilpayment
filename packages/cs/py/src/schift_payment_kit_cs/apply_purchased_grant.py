"""Original grant fulfillment using immutable sale facts."""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING

from schift_payment_kit_core import FixedClock, PaymentKitError, Period

from .purchase_snapshot import get_purchase_snapshot

if TYPE_CHECKING:
    from .recover_missing_grant import RecoverMissingGrantInput, SupportGrantOutcome


async def apply_purchased_grant(input: RecoverMissingGrantInput) -> SupportGrantOutcome:
    payment = await input.repo.payments.get(input.payment_id)
    snapshot = await get_purchase_snapshot(payment_id=input.payment_id, repo=input.repo)
    if (
        not payment
        or not snapshot
        or snapshot.customer_id != input.customer_id
        or payment.customer_id != input.customer_id
        or snapshot.payment_ref != payment.provider_ref
        or snapshot.provider != payment.provider
        or snapshot.price.amount_minor != payment.amount.amount_minor
        or snapshot.price.currency != payment.amount.currency
        or payment.status != "succeeded"
    ):
        raise PaymentKitError(
            "immutable purchase entitlement missing or inconsistent",
            "purchase_evidence_missing",
        )
    clock = FixedClock(datetime.fromisoformat(snapshot.purchased_at))
    if snapshot.plan.interval is None:
        return await input.grants.topup(
            customer_id=input.customer_id,
            payment=payment,
            credits=snapshot.plan.credits_per_period,
            policy=snapshot.policy,
            ledger=input.ledger,
            repo=input.repo,
            clock=clock,
        )
    sub = (
        await input.repo.subscriptions.get(snapshot.subscription_id)
        if snapshot.subscription_id
        else None
    )
    if (
        not sub
        or sub.customer_id != input.customer_id
        or sub.provider != snapshot.provider
        or not snapshot.period
    ):
        raise PaymentKitError(
            "subscription purchase evidence missing", "purchase_evidence_missing"
        )
    return await input.grants.grant_for_period(
        sub=sub,
        plan=snapshot.plan,
        period=Period(
            start=datetime.fromisoformat(snapshot.period["start"]),
            end=datetime.fromisoformat(snapshot.period["end"]),
        ),
        payment=payment,
        policy=snapshot.policy,
        ledger=input.ledger,
        clock=clock,
    )
