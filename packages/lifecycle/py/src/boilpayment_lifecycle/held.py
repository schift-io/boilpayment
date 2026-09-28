"""spec: packages/lifecycle/spec/lifecycle.pseudo.md -- EC:A53 A54. Mirrors held.ts.

What a person does after the kit stopped and told them:
  EC:A53 A58 -- an attempt held for review (EC:A50: the provider's order did not match the charge);
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
    PaymentProvider,
    Policy,
    Repo,
    Subscription,
    is_under_review,
)

from .charge_attempt import attempt_key_of, iso_z, order_id_of, with_attempt_lease
from .dunning import OnPaymentFailedInput, on_payment_failed
from .internal import renewal_plan_id
from .missed_periods import catch_up_periods
from .renewal import OnRenewalPaidInput, on_renewal_paid

HeldDecision = Literal["settle", "void", "close"]

# Order states in which money is (or may still be) with the merchant: void would charge the period again.
_MOVED_MONEY = {"succeeded", "partially_refunded", "disputed", "pending", "requires_action"}


@dataclass(kw_only=True, slots=True)
class ResolveHeldAttemptResult:
    payment: Payment
    sub: Subscription | None


def _money(value: Any) -> Money | None:
    if isinstance(value, dict) and isinstance(value.get("amountMinor"), int):
        return Money(amount_minor=value["amountMinor"], currency=value["currency"])
    return None


def _not_held(payment_id: str) -> PaymentKitError:
    return PaymentKitError("payment is not an attempt held for review", "attempt_not_held", {"paymentId": payment_id})


async def resolve_held_attempt(
    *,
    payment_id: str,
    decision: HeldDecision,
    actor: str,
    provider: PaymentProvider | None = None,
    policy: Policy,
    ledger: LedgerStore,
    repo: Repo,
    clock: Clock,
    notifier: Notifier | None = None,
    note: str | None = None,
) -> ResolveHeldAttemptResult:
    """EC:A53 A58 -- resolve an attempt held for review (see held.ts for the three decisions).
    ``settle``: the provider's order IS this renewal; it becomes succeeded and buys its period.
    ``void``: no money moved (or it was fully refunded): closed as failed and dunning takes over;
    refused when the provider shows the order paid, partly refunded, disputed or pending.
    ``close``: money moved but the kit neither grants nor charges again; the subscription moves past
    the period and a person handles any refund. Raises ``attempt_not_held`` for any other row and
    ``attempt_in_flight`` while another worker holds the attempt's lease (EC:A37)."""
    # I-2 -- the provider is asked about the order before ``void``; a missing one is a clear error.
    if provider is None:
        raise PaymentKitError("resolve_held_attempt needs the provider of this attempt", "provider_required", {"payment_id": payment_id})
    first = await repo.payments.get(payment_id)
    if first is None or first.status != "pending" or not is_under_review(first):
        raise _not_held(payment_id)

    async def run() -> ResolveHeldAttemptResult:
        return await _resolve_held(payment_id=payment_id, decision=decision, actor=actor, provider=provider,
                                   policy=policy, ledger=ledger, repo=repo, clock=clock,
                                   notifier=notifier or NoopNotifier(), note=note)

    held, value = await with_attempt_lease(repo, clock, attempt_key_of(first) or first.id, run)
    if not held:
        raise PaymentKitError("another worker is handling this attempt; try again", "attempt_in_flight", {"paymentId": payment_id})
    return value


async def _resolve_held(
    *, payment_id: str, decision: HeldDecision, actor: str, provider: PaymentProvider, policy: Policy,
    ledger: LedgerStore, repo: Repo, clock: Clock, notifier: Notifier, note: str | None,
) -> ResolveHeldAttemptResult:
    row = await repo.payments.get(payment_id)  # re-read under the lease: another decision may have won
    if row is None or row.status != "pending" or not is_under_review(row):
        raise _not_held(payment_id)
    raw = dict(row.raw) if isinstance(row.raw, dict) else {}
    review = raw.pop("boilpaymentReview") or {}
    raw["boilpaymentReviewResolved"] = {**review, "decision": decision, "actor": actor, "note": note, "at": iso_z(clock.now())}
    sub = await repo.subscriptions.get(row.subscription_id) if row.subscription_id else None

    if decision == "settle":
        if review.get("status") != "succeeded":
            raise PaymentKitError(
                f"the held order is {review.get('status') or 'unknown'}, not paid: void or close it instead",
                "held_order_not_paid",
                {"paymentId": payment_id},
            )
        settled = dataclasses.replace(
            row, status="succeeded", amount=_money(review.get("amount")) or row.amount,
            provider_ref=review.get("providerRef") or row.provider_ref, failure=None, raw=raw,
        )
        await repo.payments.put(settled)
        if sub is None:
            return ResolveHeldAttemptResult(payment=settled, sub=None)
        result = await on_renewal_paid(OnRenewalPaidInput(sub=sub, payment=settled, policy=policy, ledger=ledger, repo=repo, clock=clock))
        return ResolveHeldAttemptResult(payment=settled, sub=result.sub)

    if decision == "close":
        closed = dataclasses.replace(row, status="failed", raw=raw, failure=PaymentFailure(
            code="review_closed", provider_code=None, retryable=False,
            user_message="A person closed this charge after review; any refund is handled by them."))
        await repo.payments.put(closed)
        # EC:A58 -- the period is over as far as the kit is concerned: no grant and no further charge for it.
        if (sub is not None and row.period is not None and sub.status in ("active", "past_due")
                and row.period.end > sub.current_period.end):
            moved = dataclasses.replace(sub, plan_id=sub.scheduled_plan_id or sub.plan_id, scheduled_plan_id=None,
                                        current_period=row.period, status="active", grace_until=None)
            saved = await repo.subscriptions.put(moved) or moved
            return ResolveHeldAttemptResult(payment=closed, sub=saved)
        return ResolveHeldAttemptResult(payment=closed, sub=sub)

    # EC:A58 -- void starts dunning, which charges the period again: first make sure no money sits with this order.
    now = await _current_order_status(provider, row, review)
    if now in _MOVED_MONEY:
        raise PaymentKitError(f"the provider shows the held order {now}: settle or close it instead",
                              "held_order_moved_money", {"paymentId": payment_id, "status": now})
    voided = dataclasses.replace(row, status="failed", raw=raw, failure=PaymentFailure(
        code="review_voided", provider_code=None, retryable=False, user_message="A person closed this charge after review."))
    await repo.payments.put(voided)
    if sub is not None and sub.status in ("active", "past_due"):
        failed = await on_payment_failed(OnPaymentFailedInput(
            sub=sub, policy=policy, ledger=ledger, repo=repo, notifier=notifier, clock=clock,  # SB-07
        ))
        return ResolveHeldAttemptResult(payment=voided, sub=failed.sub)
    return ResolveHeldAttemptResult(payment=voided, sub=sub)


async def _current_order_status(provider: PaymentProvider, row: Payment, review: dict[str, Any]) -> str:
    """The order's status now: asked from the provider when it can answer, else the status seen at hold time."""
    lookup = getattr(provider, "get_payment_by_order_id", None)
    if lookup is None:
        return str(review.get("status") or "unknown")
    try:
        found = await lookup(order_id_of(row))
    except Exception as err:
        raise PaymentKitError("the provider did not answer for the held order; try again", "held_order_unverified",
                              {"paymentId": row.id, "reason": str(err)}) from err
    return found.status if found is not None else "not_found"


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
