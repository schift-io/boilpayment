"""EC:A45 A50 (A6-6) -- the webhook's side of a self-scheduled renewal attempt row (PortOne sends
Transaction.Paid for the charge the kit's scheduler made). Mirrors the A45 branch of handlers.ts."""

from __future__ import annotations

import dataclasses

from boilpayment_core import (
    Notifier,
    Payment,
    Repo,
    expected_attempt_amount,
    hold_attempt_for_review,
    is_closed_by_person,
    is_under_review,
    lookup_mismatch,
)


async def complete_attempt_row(repo: Repo, notifier: Notifier, stored: Payment | None, payment: Payment) -> bool:
    """False when the attempt waits for a person or a person closed it: it is held for review already
    (or voided/closed after review, EC:A58), or the provider's
    payment is not the charge sent under its key (then it is held now, one notice). A pending row that
    matches is recorded succeeded."""
    # EC:A58 -- a person voided or closed this attempt: a late or redelivered webhook never grants it.
    if stored is not None and (is_under_review(stored) or is_closed_by_person(stored)):
        return False
    if stored is not None and stored.status == "pending":
        reason = lookup_mismatch(payment, amount=expected_attempt_amount(stored), customer_id=stored.customer_id,
                                 currency=stored.amount.currency)
        if reason:
            await hold_attempt_for_review(repo, notifier, stored, payment, reason)
            return False
        await repo.payments.put(dataclasses.replace(
            stored, status="succeeded", provider_ref=payment.provider_ref, amount=payment.amount, failure=None,
        ))
    return True
