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
import itertools
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Literal

from boilpayment_core import (
    Clock,
    Money,
    NoopNotifier,
    Notification,
    Notifier,
    Operation,
    Payment,
    PaymentFailure,
    PaymentProvider,
    Period,
    PlanPrice,
    ProviderError,
    Repo,
    Subscription,
    expected_attempt_amount,
    hold_attempt_for_review,
    is_legacy_attempt_row,
    is_under_review,
    key_matches_instant,
    lookup_mismatch,
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


_DUPLICATE_ORDER_CODES = frozenset({"DUPLICATED_ORDER_ID", "ALREADY_PROCESSED_PAYMENT", "ALREADY_PAID"})


def is_duplicate_order(err: BaseException) -> bool:
    """EC:A49 -- the orderId/paymentId was already used (Toss DUPLICATED_ORDER_ID and
    ALREADY_PROCESSED_PAYMENT after its 15-day key window, PortOne ALREADY_PAID): the order exists
    and may have moved money, so it is settled by lookup, never a decline."""
    if not isinstance(err, ProviderError):
        return False
    details = err.details if isinstance(err.details, dict) else {}
    codes = (details.get("code"), details.get("type"), getattr(err.failure, "provider_code", None))
    return any(isinstance(c, str) and c in _DUPLICATE_ORDER_CODES for c in codes)


async def _apply_lookup(repo: Repo, notifier: Notifier, row: Payment, found: Payment, price_hint: Money | None) -> Payment | None:
    """EC:A49 A50 -- apply a looked-up order to an attempt row (see applyLookup in charge-attempt.ts).
    A6-3 -- the order must match what was sent under this key (the row's amount), never today's price.
    A legacy row settles at the provider's amount when currency and customer match (a person is told
    when that differs from ``price_hint``)."""
    legacy = is_legacy_attempt_row(row)
    expected = None if legacy else (expected_attempt_amount(row) or price_hint)
    reason = lookup_mismatch(found, amount=expected, customer_id=row.customer_id, currency=row.amount.currency)
    if reason:
        await hold_attempt_for_review(repo, notifier, row, found, reason)
        return None
    if found.status not in ("succeeded", "failed"):
        return None
    raw = dict(row.raw) if isinstance(row.raw, dict) else {}
    raw["provider"] = found.raw
    settled = dataclasses.replace(row, provider_ref=found.provider_ref or row.provider_ref, amount=found.amount or row.amount,
                                  status=found.status, failure=found.failure, raw=raw)
    await repo.payments.put(settled)
    if (legacy and settled.status == "succeeded" and price_hint is not None and found.amount is not None
            and found.amount.amount_minor != price_hint.amount_minor):
        await notifier.send(Notification(type="cs.needs_human", customer_id=row.customer_id, payload={
            "kind": "legacy_settled_at_provider_amount", "subscription_id": row.subscription_id, "payment_id": row.id,
            "amount": {"amountMinor": found.amount.amount_minor, "currency": found.amount.currency},
            "plan_price": {"amountMinor": price_hint.amount_minor, "currency": price_hint.currency}}))
    return settled


def _not_found_failure() -> PaymentFailure:
    return PaymentFailure(code="order_not_found", provider_code=None, retryable=False, user_message="The provider has no order for this attempt.")


# EC:A49 -- without a lookup, a pending attempt is re-sent with its key only while the provider still
# replays that key (Toss: 15 days).
REDRIVE_WITHOUT_LOOKUP = timedelta(days=14)


def is_decline(err: BaseException) -> bool:
    """EC:A34 -- the provider refused the request (a decline) vs. an outcome nobody knows."""
    if not isinstance(err, ProviderError):
        return False
    if is_duplicate_order(err):
        return False  # EC:A49
    status = getattr(err, "http_status", None)
    if status is None:
        return err.failure.code != "provider_unavailable"
    return 400 <= status < 500 and status not in (408, 409, 429)


async def attempts_for(repo: Repo, sub: Subscription, period: Period) -> list[Payment]:
    """Every attempt row of one (subscription, period), oldest first. A row the previous release
    wrote used the attempt key itself as orderId/provider_ref (TS or Python date format)."""
    rows = await repo.payments.list(subscription_id=sub.id)
    prefix = f"charge:{sub.id}:"
    matched = [
        p
        for p in rows
        if p.kind == "subscription"
        and (
            (p.period is not None and p.period.start == period.start)
            or p.provider_ref == renewal_attempt_key(sub, period)
            # EC:J11 -- any date form the previous release wrote (TS 'Z', Python '+00:00'/'+09:00').
            or key_matches_instant(p.provider_ref, prefix, period.start)
        )
    ]
    return sorted(matched, key=lambda p: p.occurred_at)


def attempt_key_of(row: Payment) -> str | None:
    raw = row.raw if isinstance(row.raw, dict) else {}
    key = raw.get("boilpaymentAttemptKey")
    return key if isinstance(key, str) else None


# EC:A37 -- one caller at a time per attempt (see charge-attempt.ts withAttemptLease).
ATTEMPT_LEASE = timedelta(minutes=10)
_LEASE_HASH = "charge-attempt-lease"


def _lease_key(attempt_key: str) -> str:
    return f"charge-lease:{attempt_key}"


def _iso(dt: datetime) -> str:
    return iso_z(dt)


def _parse(value: str) -> datetime:
    return datetime.fromisoformat(value)


def _lease_is_stale(current: Operation, now: datetime) -> bool:
    info = current.result if isinstance(current.result, dict) else {}
    if info.get("leaseUntil"):
        return _parse(info["leaseUntil"]) <= now
    if info.get("unleasedSince"):
        return _parse(info["unleasedSince"]) + ATTEMPT_LEASE <= now
    return False


_lease_seq = itertools.count(1)


async def with_attempt_lease(repo: Repo, clock: Clock, attempt_key: str, fn):  # type: ignore[no-untyped-def]
    """Run fn() holding the attempt's lease. Returns (True, value) or (False, None) when another
    caller holds it. Mirrors withAttemptLease in charge-attempt.ts. EC:A48 -- every takeover and
    release is a compare and set against the row as read (when the table supports it)."""
    key = _lease_key(attempt_key)
    now = clock.now()
    ops = repo.operations
    cas = getattr(ops, "compare_and_set", None)

    async def write(expected: Operation, nxt: Operation) -> bool:
        if cas is not None:
            return bool(await cas(expected, nxt))
        await ops.put(nxt)
        return True

    # EC:A48 (I-1) -- the claim writes the lease and its owner token itself (see charge-attempt.ts).
    token = f"{int(now.timestamp() * 1000):x}.{next(_lease_seq):x}.{secrets.token_hex(4)}"
    lease = {"leaseUntil": _iso(now + ATTEMPT_LEASE), "token": token}
    row = Operation(id=key, key=key, kind="lifecycle.charge_attempt", payload_hash=_LEASE_HASH,
                    status="in_progress", created_at=now, result=lease, error=None, completed_at=None, attempts=0)
    claimed = await ops.claim(row)
    if claimed is None:
        current = await ops.get(key)
        info = current.result if current is not None and isinstance(current.result, dict) else {}
        if current is not None and current.status == "in_progress" and _lease_is_stale(current, now):
            if await write(current, dataclasses.replace(current, status="failed", error="lease_expired", result=None, completed_at=now)):
                claimed = await ops.claim(row)
        elif current is not None and current.status == "in_progress" and not info.get("leaseUntil") and not info.get("unleasedSince"):
            await write(current, dataclasses.replace(current, result={"unleasedSince": _iso(now)}))
    if claimed is None:
        return False, None
    held = claimed
    if not (isinstance(claimed.result, dict) and claimed.result.get("token") == token):
        # a Repo whose claim does not store the result gets the lease as a second write
        held = dataclasses.replace(claimed, result=lease)
        if not await write(claimed, held):
            return False, None
    try:
        return True, await fn()
    finally:
        released = dataclasses.replace(held, status="failed", error=None, result=None, completed_at=clock.now())
        if cas is not None:
            await cas(held, released)
        else:
            mine = await ops.get(key)
            if mine is not None and isinstance(mine.result, dict) and mine.result.get("token") == token:
                await ops.put(released)


@dataclass(kw_only=True, slots=True)
class ChargeAttemptOutcome:
    kind: Literal["succeeded", "declined", "unresolved", "in_flight"]
    payment: Payment | None
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
    notifier: Notifier | None = None


async def charge_attempt(input: ChargeAttemptInput) -> ChargeAttemptOutcome:
    """EC:A34 A37 -- run (or re-drive) one attempt under its lease. A succeeded or failed row is
    the final answer; a pending row, or none, calls the provider with the attempt's idempotency key
    and order id. Another caller holding the attempt -> kind='in_flight', nothing done."""
    held, value = await with_attempt_lease(input.repo, input.clock, input.attempt_key, lambda: _charge_attempt_held(input))
    return value if held else ChargeAttemptOutcome(kind="in_flight", payment=None)


async def _charge_attempt_held(input: ChargeAttemptInput) -> ChargeAttemptOutcome:
    repo, sub, price = input.repo, input.sub, input.price
    row_id = attempt_payment_id(input.attempt_key)
    order_id = provider_order_id(input.attempt_key)
    notifier = input.notifier or NoopNotifier()
    stored = await repo.payments.get(row_id)
    if stored is not None and stored.status == "succeeded":
        return ChargeAttemptOutcome(kind="succeeded", payment=stored)
    if stored is not None and stored.status == "failed":
        return ChargeAttemptOutcome(kind="declined", payment=stored, fresh=False)
    if stored is not None and is_under_review(stored):
        return ChargeAttemptOutcome(kind="unresolved", payment=stored, reason="attempt_needs_review", first=False)
    if stored is not None:
        # EC:A49 -- a re-drive asks the provider first (see charge-attempt.ts).
        asked = await _ask_provider(input, stored, notifier, Money(amount_minor=price.amount_minor, currency=price.currency))
        if asked is not None:
            return asked

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
            amount=pending.amount,  # A6-3 -- a re-drive re-sends what its key was first sent with
            order_id=order_id,
            customer_ref=sub.customer_id,
            idempotency_key=input.attempt_key,
        )
    except Exception as err:  # noqa: BLE001 -- classified below: decline vs unknown outcome
        if is_duplicate_order(err):
            asked = await _ask_provider(input, pending, notifier, pending.amount, must_exist=True)
            return asked or ChargeAttemptOutcome(kind="unresolved", payment=pending, reason="duplicate_order_unverified", first=stored is None)
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


async def _ask_provider(input: ChargeAttemptInput, row: Payment, notifier: Notifier, expected: Money,
                        must_exist: bool = False) -> ChargeAttemptOutcome | None:
    """EC:A49 -- settle a re-driven attempt from the provider's own record (see askProvider in TS)."""
    lookup = getattr(input.provider, "get_payment_by_order_id", None)
    if lookup is None:
        if must_exist:
            return ChargeAttemptOutcome(kind="unresolved", payment=row, reason="duplicate_order_no_lookup", first=False)
        if input.clock.now() - row.occurred_at > REDRIVE_WITHOUT_LOOKUP:
            return ChargeAttemptOutcome(kind="unresolved", payment=row, reason="beyond_replay_window_no_lookup", first=False)
        return None
    try:
        found = await lookup(order_id_of(row))
    except Exception as err:  # noqa: BLE001 -- no answer: stay unresolved, never re-send blind
        return ChargeAttemptOutcome(kind="unresolved", payment=row, reason=f"lookup failed: {err}", first=False)
    if found is None:
        return ChargeAttemptOutcome(kind="unresolved", payment=row, reason="duplicate_order_not_found", first=False) if must_exist else None
    settled = await _apply_lookup(input.repo, notifier, row, found, expected)
    if settled is None:
        current = await input.repo.payments.get(row.id) or row
        reason = "attempt_needs_review" if is_under_review(current) else f"provider status {found.status}"
        return ChargeAttemptOutcome(kind="unresolved", payment=current, reason=reason, first=False)
    if settled.status == "succeeded":
        return ChargeAttemptOutcome(kind="succeeded", payment=settled)
    return ChargeAttemptOutcome(kind="declined", payment=settled, fresh=True)


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


def is_legacy_attempt(row: Payment) -> bool:
    """EC:A39 -- a row for a charge an earlier release made: settled by lookup only, never re-driven
    (a provider replays an idempotency key for a limited time; re-sending later could charge again)."""
    return is_legacy_attempt_row(row)


def order_id_of(row: Payment) -> str:
    """The orderId an attempt row was sent with (rows of earlier releases used the key itself)."""
    raw = row.raw if isinstance(row.raw, dict) else {}
    legacy = raw.get("boilpaymentLegacyOrderId")
    if isinstance(legacy, str):
        return legacy
    key = attempt_key_of(row)
    return provider_order_id(key) if key else row.provider_ref


async def settle_attempt_by_lookup(*, provider: PaymentProvider, repo: Repo, clock: Clock, row: Payment,
                                   expected: Money | None = None, notifier: Notifier | None = None) -> Payment | None:
    """EC:A38 -- settle a pending attempt WITHOUT charging, by asking the provider for its orderId.
    EC:A50 -- a mismatching order is held for a person (None)."""
    key = attempt_key_of(row) or row.id
    notes = notifier or NoopNotifier()

    async def run() -> Payment | None:
        fresh = await repo.payments.get(row.id) or row
        if fresh.status in ("succeeded", "failed"):
            return fresh
        if is_under_review(fresh):
            return None
        lookup = getattr(provider, "get_payment_by_order_id", None)
        if lookup is None:
            return None
        try:
            found = await lookup(order_id_of(fresh))
        except Exception:  # noqa: BLE001 -- no answer yet; retried on a later tick
            return None
        if found is None:
            closed = dataclasses.replace(fresh, status="failed", failure=_not_found_failure())
            await repo.payments.put(closed)
            return closed
        return await _apply_lookup(repo, notes, fresh, found, expected)

    held, value = await with_attempt_lease(repo, clock, key, run)
    return value if held else None
