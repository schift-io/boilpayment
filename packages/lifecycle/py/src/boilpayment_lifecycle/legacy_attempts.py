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

from .charge_attempt import attempt_key_of, attempt_payment_id, settle_attempt_by_lookup
from .renewal import OnRenewalPaidInput, on_renewal_paid

_RETRY_ITEM_PREFIX = "dunning-retry-item:"


def legacy_dunning_key(sub_id: str, attempt: int) -> str:
    return f"dunning-retry:{sub_id}:{attempt}"


@dataclass(kw_only=True, slots=True)
class LegacyCheck:
    kind: Literal["none", "paid", "unverified"]
    payment: Payment | None = None
    order_ids: list[str] = field(default_factory=list)


async def check_legacy_dunning(*, provider: PaymentProvider, repo: Repo, clock: Clock, sub: Subscription, period: Period) -> LegacyCheck:
    items = [
        i for i in await repo.outbox.list()
        if i.id.startswith(f"{_RETRY_ITEM_PREFIX}{sub.id}:") and i.status == "sent"
        and i.created_at >= sub.current_period.end
    ]
    if not items:
        return LegacyCheck(kind="none")
    unverified: list[str] = []
    for item in items:
        try:
            attempt = int(item.payload.get("attempt"))
        except (TypeError, ValueError):
            continue
        key = legacy_dunning_key(sub.id, attempt)
        row_id = attempt_payment_id(key)
        row = await repo.payments.get(row_id)
        if row is None:
            row = Payment(
                id=row_id, customer_id=sub.customer_id, provider=sub.provider, provider_ref=key, subscription_id=sub.id,
                amount=Money(amount_minor=0, currency=sub.currency or "KRW"), status="pending", kind="subscription",
                period=period, occurred_at=item.created_at, failure=None, cash_receipt=None,
                raw={"boilpaymentAttemptKey": key, "boilpaymentLegacyOrderId": key},
            )
            await repo.payments.put(row)
        settled = await settle_attempt_by_lookup(provider=provider, repo=repo, clock=clock, row=row) if row.status == "pending" else row
        if settled is None:
            unverified.append(key)
            continue
        if settled.status == "succeeded":
            return LegacyCheck(kind="paid", payment=settled)
    return LegacyCheck(kind="unverified", order_ids=unverified) if unverified else LegacyCheck(kind="none")


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
        if sub is not None and sub.status in ("active", "past_due"):
            continue
        done = await settle_attempt_by_lookup(provider=provider, repo=repo, clock=clock, row=row)
        if done is None:
            unresolved.append(LateSettlement(subscription_id=row.subscription_id or "", payment_id=row.id, status="pending"))
            continue
        settled.append(LateSettlement(subscription_id=row.subscription_id or "", payment_id=row.id, status=done.status))
        if done.status == "succeeded" and sub is not None:
            await on_renewal_paid(OnRenewalPaidInput(sub=sub, payment=done, policy=policy, ledger=ledger, repo=repo, clock=clock))
            await notifier.send(Notification(type="cs.needs_human", customer_id=sub.customer_id, payload={
                "kind": "renewal_settled_after_end", "subscription_id": sub.id, "payment_id": done.id, "status": sub.status}))
    return settled, unresolved
