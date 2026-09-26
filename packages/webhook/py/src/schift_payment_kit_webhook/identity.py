"""EC:E3 EC:I9 -- resolves the LOCAL customer/payment/subscription a webhook event is about, by
looking up the local row via (provider, provider_ref) -- never trusts the provider-adapter's own
ref fields as local identity directly (see handlers.py EC:E3 note: those are best-effort, restored
from checkout metadata). Best-effort in the other direction too: any id that can't be resolved
stays None (e.g. the event predates any local row, or references an entity created outside this
app). Used by both receive() (first sighting) and process() (re-verified, may resolve better once
more local rows exist) so a customer-scoped CS timeline can query webhook_events directly instead
of a full table scan.

Mirrors packages/webhook/ts/src/identity.ts exactly.
"""

from __future__ import annotations

from dataclasses import dataclass

from schift_payment_kit_core import NormalizedEvent, PaymentProvider, Repo


@dataclass(kw_only=True, slots=True)
class WebhookIdentity:
    customer_id: str | None
    payment_id: str | None
    subscription_id: str | None


async def resolve_webhook_identity(
    repo: Repo, provider: PaymentProvider, event: NormalizedEvent
) -> WebhookIdentity:
    customer_id: str | None = None
    payment_id: str | None = None
    subscription_id: str | None = None

    if event.payment_ref:
        payments = await repo.payments.list(
            provider=provider.name, provider_ref=event.payment_ref
        )
        if payments:
            payment_id = payments[0].id
            customer_id = payments[0].customer_id
    if event.subscription_ref:
        subs = await repo.subscriptions.list(
            provider=provider.name, provider_ref=event.subscription_ref
        )
        if subs:
            subscription_id = subs[0].id
            customer_id = customer_id or subs[0].customer_id
    # Last resort -- Customer has no (provider, provider_ref) column to filter on
    # (provider_refs is a list), so this is a full scan. Only reached when payment/subscription
    # lookups didn't already give us a customer_id.
    if not customer_id and event.customer_ref:
        customers = await repo.customers.list()
        match = next(
            (
                c
                for c in customers
                if any(
                    r.provider == provider.name and r.ref == event.customer_ref
                    for r in c.provider_refs
                )
            ),
            None,
        )
        if match:
            customer_id = match.id

    return WebhookIdentity(
        customer_id=customer_id, payment_id=payment_id, subscription_id=subscription_id
    )
