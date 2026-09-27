"""spec: packages/lifecycle/spec/lifecycle.pseudo.md — EC:A38 A39. Mirrors legacy-attempts.ts.

Attempts the scheduler and dunning no longer re-drive, settled by asking the provider (never by
charging again): EC:A38 attempts left pending when their subscription ended; EC:A39 dunning charges
an earlier release (before EC:A34) made without a payment row.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from boilpayment_core import (
    Clock,
    LedgerStore,
    Money,
    NoopNotifier,
    Notification,
    Notifier,
    Payment,
    PaymentProvider,
    Period,
    Policy,
    Repo,
    Subscription,
)

from .charge_attempt import (
    attempt_key_of,
    attempt_payment_id,
    dunning_attempt_key,
    is_under_review,
    settle_attempt_by_lookup,
)
from .internal import price_for_subscription
from .period import next_period
from .renewal import OnRenewalPaidInput, on_renewal_paid

_RETRY_ITEM_PREFIX = "dunning-retry-item:"


def legacy_dunning_key(sub_id: str, attempt: int) -> str:
    return f"dunning-retry:{sub_id}:{attempt}"


@dataclass(kw_only=True, slots=True)
class LegacyCheck:
    kind: Literal["none", "paid", "unverified"]
    payment: Payment | None = None
    order_ids: list[str] = field(default_factory=list)


async def check_legacy_dunning(*, provider: PaymentProvider, repo: Repo, clock: Clock, sub: Subscription, period: Period,
                               price: Money | None = None, notifier: Notifier | None = None) -> LegacyCheck:
    items = [
        i for i in await repo.outbox.list()
        if i.id.startswith(f"{_RETRY_ITEM_PREFIX}{sub.id}:") and i.status == "sent"
        and i.created_at >= sub.current_period.end
    ]
    if not items:
        return LegacyCheck(kind="none")
    unverified: list[str] = []
    paid: Payment | None = None
    # EC:A55 -- every key is looked up, not only the first that paid (see legacy-attempts.ts).
    for item in items:
        try:
            attempt = int(item.payload.get("attempt"))
        except (TypeError, ValueError):
            continue
        # A retry this release ran left its own attempt row (period in the key): not a legacy charge.
        if await repo.payments.get(attempt_payment_id(dunning_attempt_key(sub, period, attempt))) is not None:
            continue
        key = legacy_dunning_key(sub.id, attempt)
        row_id = attempt_payment_id(key)
        row = await repo.payments.get(row_id)
        if row is None:
            row = Payment(
                id=row_id, customer_id=sub.customer_id, provider=sub.provider, provider_ref=key, subscription_id=sub.id,
                amount=Money(amount_minor=price.amount_minor, currency=price.currency) if price is not None
                else Money(amount_minor=0, currency=sub.currency or "KRW"), status="pending", kind="subscription",
                period=period, occurred_at=item.created_at, failure=None, cash_receipt=None,
                raw={"boilpaymentAttemptKey": key, "boilpaymentLegacyOrderId": key},
            )
            await repo.payments.put(row)
        was_pending = row.status == "pending"
        settled = (
            await settle_attempt_by_lookup(provider=provider, repo=repo, clock=clock, row=row, expected=price, notifier=notifier)
            if was_pending else row
        )
        if settled is None:
            unverified.append(key)
            continue
        if settled.status != "succeeded":
            continue
        if paid is None:
            paid = settled
            continue
        if was_pending:
            await notify_double_charge(notifier, sub, settled.id, paid.id)
    if paid is not None:
        return LegacyCheck(kind="paid", payment=paid)
    return LegacyCheck(kind="unverified", order_ids=unverified) if unverified else LegacyCheck(kind="none")


async def notify_double_charge(notifier: Notifier | None, sub: Subscription, payment_id: str, first_payment_id: str | None) -> None:
    """EC:A55 -- a second payment that moved money for a period another payment already bought."""
    if notifier is None:
        return
    await notifier.send(Notification(type="cs.needs_human", customer_id=sub.customer_id, payload={
        "kind": "renewal_double_charge", "subscription_id": sub.id, "payment_id": payment_id,
        "first_payment_id": first_payment_id}))


@dataclass(kw_only=True, slots=True)
class LateSettlement:
    subscription_id: str
    payment_id: str
    status: str


async def settle_orphan_attempts(
    *, provider: PaymentProvider, repo: Repo, ledger: LedgerStore, policy: Policy, clock: Clock, notifier: Notifier | None = None,
) -> tuple[list[LateSettlement], list[LateSettlement]]:
    notifier = notifier or NoopNotifier()
    settled: list[LateSettlement] = []
    unresolved: list[LateSettlement] = []
    rows = [
        p for p in await repo.payments.list(status="pending")
        if p.provider == provider.name and p.kind == "subscription" and p.subscription_id and attempt_key_of(p) is not None
    ]
    for row in rows:
        sub = await repo.subscriptions.get(row.subscription_id or "")
        renewing = sub is not None and sub.status in ("active", "past_due")
        # EC:A38 (A5-8) -- see legacy-attempts.ts: a renewing subscription's attempt for a period it
        # already entered or passed is never re-driven, so it is settled here.
        behind = renewing and row.period is not None and sub is not None and row.period.start <= sub.current_period.start
        if renewing and not behind:
            continue
        done = await settle_attempt_by_lookup(provider=provider, repo=repo, clock=clock, row=row, notifier=notifier)
        if done is None:
            unresolved.append(LateSettlement(subscription_id=row.subscription_id or "", payment_id=row.id, status="pending"))
            continue
        settled.append(LateSettlement(subscription_id=row.subscription_id or "", payment_id=row.id, status=done.status))
        if done.status == "succeeded" and sub is not None:
            result = await on_renewal_paid(OnRenewalPaidInput(sub=sub, payment=done, policy=policy, ledger=ledger, repo=repo, clock=clock))
            # EC:A55 -- the period was already bought by another payment: this one is a second charge.
            entry = result.grant.entry if result.duplicated else None
            other = entry.reference.payment_id if entry is not None else None
            if other and other != done.id:
                await notify_double_charge(notifier, sub, done.id, other)
                continue
            if not renewing or not result.duplicated:
                await notifier.send(Notification(type="cs.needs_human", customer_id=sub.customer_id, payload={
                    "kind": "renewal_settled_after_end", "subscription_id": sub.id, "payment_id": done.id, "status": sub.status}))
    return settled, unresolved


async def settle_legacy_ended(
    *, provider: PaymentProvider, repo: Repo, ledger: LedgerStore, policy: Policy, clock: Clock, notifier: Notifier,
) -> list[LateSettlement]:
    """EC:A39 (A5-3) -- see settleLegacyEnded in legacy-attempts.ts."""
    out: list[LateSettlement] = []
    sub_ids: list[str] = []
    for item in await repo.outbox.list():
        if not item.id.startswith(_RETRY_ITEM_PREFIX) or item.status != "sent":
            continue
        payload = item.payload if isinstance(item.payload, dict) else {}
        sid = str(payload.get("subscriptionId") or payload.get("subscription_id") or "")
        if sid and sid not in sub_ids:
            sub_ids.append(sid)
    for sid in sub_ids:
        sub = await repo.subscriptions.get(sid)
        if sub is None or sub.provider != provider.name or sub.status not in ("expired", "canceled"):
            continue
        plan = await repo.plans.get(sub.scheduled_plan_id or sub.plan_id)
        if plan is None:
            continue
        period = next_period(sub.current_period, plan.interval or "month", sub.anchor_day, policy.period.timezone,
                             policy.period.month_end_anchor)
        price = price_for_subscription(plan, sub)
        expected = Money(amount_minor=price.amount_minor, currency=price.currency) if price is not None else None
        if not await _has_unsettled_legacy(repo, sub):
            continue
        legacy = await check_legacy_dunning(provider=provider, repo=repo, clock=clock, sub=sub, period=period, price=expected, notifier=notifier)
        if legacy.kind == "paid" and legacy.payment is not None:
            result = await on_renewal_paid(OnRenewalPaidInput(sub=sub, payment=legacy.payment, policy=policy, ledger=ledger, repo=repo, clock=clock))
            if result.duplicated:
                continue  # A6-5 -- settled on an earlier tick: already granted, the person already told
            await notifier.send(Notification(type="cs.needs_human", customer_id=sub.customer_id, payload={
                "kind": "renewal_settled_after_end", "subscription_id": sub.id, "payment_id": legacy.payment.id, "status": sub.status}))
            out.append(LateSettlement(subscription_id=sub.id, payment_id=legacy.payment.id, status="succeeded"))
    return out


async def _has_unsettled_legacy(repo: Repo, sub: Subscription) -> bool:
    """Only keys whose row is absent or still pending: a settled legacy row is final."""
    for item in await repo.outbox.list():
        if not item.id.startswith(f"{_RETRY_ITEM_PREFIX}{sub.id}:") or item.status != "sent":
            continue
        try:
            attempt = int(item.payload.get("attempt"))
        except (TypeError, ValueError, AttributeError):
            continue
        row = await repo.payments.get(attempt_payment_id(legacy_dunning_key(sub.id, attempt)))
        if row is None or (row.status == "pending" and not is_under_review(row)):
            return True
    return False
