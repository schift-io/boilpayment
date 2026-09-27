"""spec: packages/lifecycle/spec/lifecycle.pseudo.md -- EC:A53 A54. Mirrors held.ts.

What a person does after the kit stopped and told them:
  EC:A53 -- an attempt held for review (EC:A50: the provider's order did not match the charge);
  EC:A54 -- a subscription parked by missed_periods = 'needs_human_only' (EC:A47).
"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass
from typing import Any, Literal

from boilpayment_core import (
    Clock,
    LedgerStore,
    Money,
    NoopNotifier,
    Notification,
    Notifier,
    Payment,
    PaymentFailure,
    PaymentKitError,
    Policy,
    Repo,
    Subscription,
    is_under_review,
)

from .charge_attempt import iso_z
from .dunning import OnPaymentFailedInput, on_payment_failed
from .internal import renewal_plan_id
from .missed_periods import catch_up_periods
from .renewal import OnRenewalPaidInput, on_renewal_paid

HeldDecision = Literal["settle", "void"]


@dataclass(kw_only=True, slots=True)
class ResolveHeldAttemptResult:
    payment: Payment
    sub: Subscription | None


def _money(value: Any) -> Money | None:
    if isinstance(value, dict) and isinstance(value.get("amountMinor"), int):
        return Money(amount_minor=value["amountMinor"], currency=value["currency"])
    return None


async def resolve_held_attempt(
    *,
    payment_id: str,
    decision: HeldDecision,
    actor: str,
    policy: Policy,
    ledger: LedgerStore,
    repo: Repo,
    clock: Clock,
    notifier: Notifier | None = None,
    note: str | None = None,
) -> ResolveHeldAttemptResult:
    """EC:A53 -- resolve an attempt held for review. ``settle``: the provider's order IS this renewal
    (the row takes its amount and reference, becomes succeeded and buys its period). ``void``: no money
    moved for it (or it was refunded at the provider): the row is closed as failed and dunning takes
    over, as for a decline. Raises ``attempt_not_held`` for any other row."""
    notes = notifier or NoopNotifier()
    row = await repo.payments.get(payment_id)
    if row is None or row.status != "pending" or not is_under_review(row):
        raise PaymentKitError(
            "payment is not an attempt held for review",
            "attempt_not_held",
            {"paymentId": payment_id},
        )
    raw = dict(row.raw) if isinstance(row.raw, dict) else {}
    review = raw.pop("boilpaymentReview") or {}
    raw["boilpaymentReviewResolved"] = {
        **review,
        "decision": decision,
        "actor": actor,
        "note": note,
        "at": iso_z(clock.now()),
    }
    sub = (
        await repo.subscriptions.get(row.subscription_id)
        if row.subscription_id
        else None
    )

    if decision == "settle":
        if review.get("status") != "succeeded":
            raise PaymentKitError(
                f"the held order is {review.get('status') or 'unknown'}, not paid: void it instead",
                "held_order_not_paid",
                {"paymentId": payment_id},
            )
        settled = dataclasses.replace(
            row,
            status="succeeded",
            amount=_money(review.get("amount")) or row.amount,
            provider_ref=review.get("providerRef") or row.provider_ref,
            failure=None,
            raw=raw,
        )
        await repo.payments.put(settled)
        if sub is None:
            return ResolveHeldAttemptResult(payment=settled, sub=None)
        result = await on_renewal_paid(
            OnRenewalPaidInput(
                sub=sub,
                payment=settled,
                policy=policy,
                ledger=ledger,
                repo=repo,
                clock=clock,
            )
        )
        return ResolveHeldAttemptResult(payment=settled, sub=result.sub)

    voided = dataclasses.replace(
        row,
        status="failed",
        raw=raw,
        failure=PaymentFailure(
            code="review_voided",
            provider_code=None,
            retryable=False,
            user_message="A person closed this charge after review.",
        ),
    )
    await repo.payments.put(voided)
    if sub is not None and sub.status in ("active", "past_due"):
        failed = await on_payment_failed(
            OnPaymentFailedInput(
                sub=sub, policy=policy, repo=repo, notifier=notes, clock=clock
            )
        )
        return ResolveHeldAttemptResult(payment=voided, sub=failed.sub)
    return ResolveHeldAttemptResult(payment=voided, sub=sub)


async def resume_parked(
    *,
    subscription_id: str,
    actor: str,
    policy: Policy,
    repo: Repo,
    clock: Clock,
    notifier: Notifier | None = None,
) -> Subscription:
    """EC:A54 -- a subscription parked by ``missed_periods: 'needs_human_only'`` resumes from the period
    containing now: the missed periods stay unbilled and ungranted, the subscription becomes active one
    period behind, and the next scheduler tick charges the current period once. Raises ``not_parked``."""
    notes = notifier or NoopNotifier()
    sub = await repo.subscriptions.get(subscription_id)
    plan = await repo.plans.get(renewal_plan_id(sub)) if sub is not None else None
    cu = (
        catch_up_periods(sub, plan, policy, clock.now())
        if sub is not None and plan is not None
        else None
    )
    if (
        sub is None
        or plan is None
        or sub.status != "past_due"
        or sub.grace_until is not None
        or cu is None
    ):
        raise PaymentKitError(
            "subscription is not parked for missed periods",
            "not_parked",
            {"subscriptionId": subscription_id},
        )
    resumed = dataclasses.replace(
        sub, status="active", grace_until=None, current_period=cu.previous
    )
    saved = await repo.subscriptions.put(resumed) or resumed
    await notes.send(
        Notification(
            type="cs.needs_human",
            customer_id=sub.customer_id,
            payload={
                "kind": "missed_periods_resumed",
                "subscription_id": sub.id,
                "actor": actor,
                "skipped": [iso_z(p.start) for p in cu.skipped],
                "charging": iso_z(cu.target.start),
            },
        )
    )
    return saved
