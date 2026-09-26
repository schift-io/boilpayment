# EC:E13 — see spec/webhook.pseudo.md
from __future__ import annotations

from dataclasses import dataclass

from schift_payment_kit_core import LedgerEntry, LedgerStore, Repo


@dataclass(kw_only=True, slots=True)
class GetGrantsForCheckoutResult:
    ready: bool
    customer_id: str | None = None
    entries: list[LedgerEntry] | None = None


async def get_grants_for_checkout(
    *,
    checkout_id_or_payment_ref: str,
    repo: Repo,
    ledger: LedgerStore,
) -> GetGrantsForCheckoutResult:
    payments = await repo.payments.list(provider_ref=checkout_id_or_payment_ref)
    if not payments:
        return GetGrantsForCheckoutResult(ready=False)
    payment = payments[0]
    if payment.status != "succeeded":
        return GetGrantsForCheckoutResult(ready=False)

    all_entries = await ledger.entries(payment.customer_id, since=payment.occurred_at)
    grant_entries = [e for e in all_entries if e.reference.payment_id == payment.id]
    return GetGrantsForCheckoutResult(
        ready=True, customer_id=payment.customer_id, entries=grant_entries
    )
