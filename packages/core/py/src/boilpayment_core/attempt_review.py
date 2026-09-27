"""EC:A50 -- whether a provider's record of an order is the renewal charge the kit asked for, and the
review hold a person resolves when it is not. Mirrors attempt-review.ts: two paths settle an attempt
row, the lifecycle's lookup (scheduler, dunning) and the webhook's self-scheduled renewal branch (A45)."""

from __future__ import annotations

import dataclasses

from .types import Money, Notification, Notifier, Payment, Repo


def lookup_mismatch(found: Payment, *, amount: Money | None, customer_id: str, currency: str | None = None) -> str | None:
    """A looked-up order settles an attempt only when it is the charge the kit asked for."""
    if found.status in ("refunded", "partially_refunded", "disputed"):
        return f"order_{found.status}"
    want_currency = amount.currency if amount is not None else currency
    if want_currency and found.amount is not None and found.amount.currency and found.amount.currency != want_currency:
        return "currency_mismatch"
    if amount is not None and amount.amount_minor > 0 and found.amount is not None and found.amount.amount_minor != amount.amount_minor:
        return "amount_mismatch"
    if found.customer_id and found.customer_id != customer_id:
        return "customer_mismatch"
    return None


def is_under_review(row: Payment) -> bool:
    """An attempt a person has to look at: never charged, re-driven or granted by the kit."""
    raw = row.raw if isinstance(row.raw, dict) else {}
    return bool(raw.get("boilpaymentReview"))


def is_closed_by_person(row: Payment) -> bool:
    """EC:A58 -- an attempt a person voided or closed after review: nothing (a webhook included) grants it."""
    raw = row.raw if isinstance(row.raw, dict) else {}
    resolved = raw.get("boilpaymentReviewResolved")
    return isinstance(resolved, dict) and resolved.get("decision") in ("void", "close")


def is_legacy_attempt_row(row: Payment) -> bool:
    """A row for a charge an earlier release made (orderId = the attempt key itself, EC:A39)."""
    raw = row.raw if isinstance(row.raw, dict) else {}
    return isinstance(raw.get("boilpaymentLegacyOrderId"), str)


def expected_attempt_amount(row: Payment) -> Money | None:
    """EC:A50 (A6-3) -- the amount a looked-up order must match: the row's own amount (what was sent
    under its key), never today's plan price. A legacy row's sent amount is unknown: None."""
    if is_legacy_attempt_row(row):
        return None
    return row.amount if row.amount.amount_minor > 0 else None


async def hold_attempt_for_review(repo: Repo, notifier: Notifier, row: Payment, found: Payment, reason: str) -> Payment:
    """Hold `row` for a person (no grant, no charge, no re-drive) and tell them once."""
    raw = dict(row.raw) if isinstance(row.raw, dict) else {}
    raw["boilpaymentReview"] = {
        "reason": reason,
        "status": found.status,
        "amount": {"amountMinor": found.amount.amount_minor, "currency": found.amount.currency} if found.amount else None,
        "customerId": found.customer_id or None,
        "providerRef": found.provider_ref or None,
    }
    held = dataclasses.replace(row, raw=raw)
    await repo.payments.put(held)
    await notifier.send(Notification(type="cs.needs_human", customer_id=row.customer_id, payload={
        "kind": "attempt_lookup_mismatch", "subscription_id": row.subscription_id, "payment_id": row.id, "reason": reason}))
    return held
