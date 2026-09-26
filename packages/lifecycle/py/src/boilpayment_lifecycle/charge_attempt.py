"""spec: packages/lifecycle/spec/lifecycle.pseudo.md — EC:A26 A34 A35 A36

EC:A26 -- Toss sends no webhook for billing payments, so the renewal's payment row is stored here.

One self-scheduled renewal charge (the scheduler's first try or a dunning retry) for one
(subscription, period). The payment row is written BEFORE the provider is called, keyed by the
attempt, so every charge that may have moved money has a local row, and a retry of the same attempt
re-drives the same provider idempotency key instead of charging again. Mirrors charge-attempt.ts.
"""

from __future__ import annotations

import dataclasses
import hashlib
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Literal

from boilpayment_core import (
    Clock,
    Money,
    Notification,
    Notifier,
    Payment,
    PaymentProvider,
    Period,
    PlanPrice,
    ProviderError,
    Repo,
    Subscription,
)

from .internal import scope_provider


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def iso_z(dt: datetime) -> str:
    """The TS Date.toISOString() form (milliseconds, 'Z'): keys are identical in both kits."""
    utc = dt.astimezone(UTC)
    return utc.strftime("%Y-%m-%dT%H:%M:%S.") + f"{utc.microsecond // 1000:03d}Z"


def renewal_attempt_key(sub: Subscription, period: Period) -> str:
    """EC:A35 -- the key of the scheduler's charge for a period."""
    return f"charge:{sub.id}:{iso_z(period.start)}"


def dunning_attempt_key(sub: Subscription, period: Period, attempt: int) -> str:
    """EC:A35 -- dunning retry n for a period (next month's retry 1 is a new charge)."""
    return f"dunning-retry:{sub.id}:{iso_z(period.start)}:{attempt}"


def provider_order_id(attempt_key: str) -> str:
    """EC:A35 -- Toss requires 6-64 of [A-Za-z0-9_-]; PortOne uses it as the paymentId path segment."""
    return "ord_" + _sha256(attempt_key)[:40]


def attempt_payment_id(attempt_key: str) -> str:
    """EC:A34 -- the local payment row id for an attempt: found again without a scan."""
    return "pay_rn_" + _sha256(attempt_key)[:32]


def is_decline(err: BaseException) -> bool:
    """EC:A34 -- the provider refused the request (a decline) vs. an outcome nobody knows."""
    if not isinstance(err, ProviderError):
        return False
    status = getattr(err, "http_status", None)
    if status is None:
        return err.failure.code != "provider_unavailable"
    return 400 <= status < 500 and status not in (408, 409, 429)


async def attempts_for(repo: Repo, sub: Subscription, period: Period) -> list[Payment]:
    """Every attempt row of one (subscription, period), oldest first. A row the previous release
    wrote used the attempt key itself as orderId/provider_ref (TS or Python date format)."""
    legacy = {
        renewal_attempt_key(sub, period),
        f"charge:{sub.id}:{period.start.isoformat()}",
    }
    rows = await repo.payments.list(subscription_id=sub.id)
    matched = [
        p
        for p in rows
        if p.kind == "subscription"
        and (
            (p.period is not None and p.period.start == period.start)
            or p.provider_ref in legacy
        )
    ]
    return sorted(matched, key=lambda p: p.occurred_at)


def attempt_key_of(row: Payment) -> str | None:
    raw = row.raw if isinstance(row.raw, dict) else {}
    key = raw.get("boilpaymentAttemptKey")
    return key if isinstance(key, str) else None


@dataclass(kw_only=True, slots=True)
class ChargeAttemptOutcome:
    kind: Literal["succeeded", "declined", "unresolved"]
    payment: Payment
    fresh: bool = (
        True  # declined: False when this is the stored answer of an earlier call
    )
    reason: str = ""  # unresolved
    first: bool = False  # unresolved: the first time this attempt had no answer


@dataclass(kw_only=True, slots=True)
class ChargeAttemptInput:
    provider: PaymentProvider
    repo: Repo
    clock: Clock
    sub: Subscription
    price: PlanPrice
    period: Period
    attempt_key: str
    correlation_id: str | None = None


async def charge_attempt(input: ChargeAttemptInput) -> ChargeAttemptOutcome:
    """EC:A34 -- run (or re-drive) one attempt. A succeeded or failed row is the final answer; a
    pending row, or none, calls the provider with the attempt's idempotency key and order id."""
    repo, sub, price = input.repo, input.sub, input.price
    row_id = attempt_payment_id(input.attempt_key)
    order_id = provider_order_id(input.attempt_key)
    stored = await repo.payments.get(row_id)
    if stored is not None and stored.status == "succeeded":
        return ChargeAttemptOutcome(kind="succeeded", payment=stored)
    if stored is not None and stored.status == "failed":
        return ChargeAttemptOutcome(kind="declined", payment=stored, fresh=False)

    pending = stored or Payment(
        id=row_id,
        customer_id=sub.customer_id,
        provider=sub.provider,
        provider_ref=order_id,
        subscription_id=sub.id,
        amount=Money(amount_minor=price.amount_minor, currency=price.currency),
        status="pending",
        kind="subscription",
        period=input.period,
        occurred_at=input.clock.now(),
        failure=None,
        cash_receipt=None,
        raw={"boilpaymentAttemptKey": input.attempt_key},
    )
    if stored is None:
        await repo.payments.put(pending)  # durable before the provider is asked

    try:
        answer = await scope_provider(
            input.provider, input.correlation_id
        ).charge_billing_key(
            billing_key=sub.billing_key or "",
            amount=Money(amount_minor=price.amount_minor, currency=price.currency),
            order_id=order_id,
            customer_ref=sub.customer_id,
            idempotency_key=input.attempt_key,
        )
    except Exception as err:  # noqa: BLE001 -- classified below: decline vs unknown outcome
        if is_decline(err):
            failed = dataclasses.replace(pending, status="failed", failure=err.failure)  # type: ignore[attr-defined]
            await repo.payments.put(failed)
            return ChargeAttemptOutcome(kind="declined", payment=failed, fresh=True)
        return ChargeAttemptOutcome(
            kind="unresolved", payment=pending, reason=str(err), first=stored is None
        )

    row = dataclasses.replace(
        pending,
        provider_ref=answer.provider_ref or pending.provider_ref,
        amount=answer.amount or pending.amount,
        status=answer.status,
        occurred_at=answer.occurred_at or pending.occurred_at,
        failure=answer.failure,
        raw={"boilpaymentAttemptKey": input.attempt_key, "provider": answer.raw},
    )
    await repo.payments.put(row)
    if row.status == "succeeded":
        return ChargeAttemptOutcome(kind="succeeded", payment=row)
    if row.status == "failed":
        return ChargeAttemptOutcome(kind="declined", payment=row, fresh=True)
    return ChargeAttemptOutcome(
        kind="unresolved",
        payment=row,
        reason=f"provider status {row.status}",
        first=stored is None,
    )


async def mark_unresolved(
    *,
    sub: Subscription,
    repo: Repo,
    notifier: Notifier,
    clock: Clock,
    grace_days: int,
    payment: Payment,
    reason: str,
) -> Subscription:
    """EC:A36 -- an unknown renewal outcome past the period end: grace (past_due) once, one notice."""
    if sub.status != "active":
        return sub
    now = clock.now()
    updated = dataclasses.replace(
        sub, status="past_due", grace_until=now + timedelta(days=max(0, grace_days))
    )
    await repo.subscriptions.put(updated)
    await notifier.send(
        Notification(
            type="cs.needs_human",
            customer_id=sub.customer_id,
            payload={
                "kind": "renewal_charge_unresolved",
                "subscription_id": sub.id,
                "payment_id": payment.id,
                "provider_ref": payment.provider_ref,
                "reason": reason,
            },
        )
    )
    return updated
