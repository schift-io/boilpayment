"""Original grant fulfillment using immutable sale facts."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING

from boilpayment_core import (
    FixedClock,
    LedgerEntry,
    PaymentKitError,
    Period,
    run_idempotent,
)

from .cases import EscalateInput, OpenCaseInput, escalate, open_case
from .purchase_snapshot import get_purchase_snapshot

if TYPE_CHECKING:
    from .recover_missing_grant import RecoverMissingGrantInput, SupportGrantOutcome


@dataclass(frozen=True, slots=True)
class _WithheldGrantOutcome:
    entry: LedgerEntry | None = None
    duplicated: bool = False
    deferred: bool = True


_WITHHELD_GRANT = _WithheldGrantOutcome()


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
    if snapshot.plan.interval is None:
        # EC:A85 -- keep the payment evidence but never create unusable credits for a banned
        # customer. The normal top-up key makes register/webhook replays share one case and notice.
        customer = await input.repo.customers.get(input.customer_id)
        if customer is not None and customer.status == "banned":

            async def open_refund_review() -> _WithheldGrantOutcome:
                reviews = await input.repo.cs_cases.list(
                    customer_id=input.customer_id,
                    kind="refund",
                    reference_id=payment.id,
                )
                if not reviews:
                    review = await open_case(
                        OpenCaseInput(
                            customer_id=input.customer_id,
                            kind="refund",
                            reference_id=payment.id,
                            policy=input.policy,
                            repo=input.repo,
                            clock=input.clock,
                            ids=input.ids,
                            on_case_event=input.on_case_event,
                        )
                    )
                    await escalate(
                        EscalateInput(
                            case=review,
                            reason="paid top-up belongs to a banned customer; refund review required",
                            repo=input.repo,
                            clock=input.clock,
                            notifier=input.notifier,
                            on_case_event=input.on_case_event,
                        )
                    )
                return _WITHHELD_GRANT

            withheld = await run_idempotent(
                repo=input.repo,
                clock=input.clock,
                key=f"topup:{payment.id}",
                kind="credits.topup",
                payload={
                    "customer_id": input.customer_id,
                    "payment_id": payment.id,
                    "credits": snapshot.plan.credits_per_period,
                    "amount_minor": payment.amount.amount_minor,
                    "currency": payment.amount.currency,
                },
                serialize=lambda _result: {
                    "entry": None,
                    "duplicated": False,
                    "deferred": True,
                    "offset": 0,
                    "offset_entries": [],
                },
                deserialize=lambda _stored: _WITHHELD_GRANT,
                fn=open_refund_review,
            )
            return withheld.result
        clock = FixedClock(datetime.fromisoformat(snapshot.purchased_at))
        return await input.grants.topup(
            customer_id=input.customer_id,
            payment=payment,
            credits=snapshot.plan.credits_per_period,
            policy=snapshot.policy,
            ledger=input.ledger,
            repo=input.repo,
            clock=clock,
        )
    clock = FixedClock(datetime.fromisoformat(snapshot.purchased_at))
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
