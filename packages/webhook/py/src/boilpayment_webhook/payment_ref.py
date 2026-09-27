"""EC:E24 -- resolve the local payment a refund/dispute event names (mirrors payment-ref.ts).

Stripe records a renewal under its invoice (``in_...``) while refund and dispute events name the
PaymentIntent (``pi_...``) or charge (``ch_...``). Order: exact provider_ref, recorded alias, then the
provider itself (re-fetch; EC:E3): its other refs, and for rows recorded before aliases existed, the
same customer's recent payments re-fetched once each. A match is recorded as an alias."""

from __future__ import annotations

import dataclasses
from typing import Any

from boilpayment_core import (
    Clock,
    NormalizedEvent,
    Notification,
    Notifier,
    Operation,
    Payment,
    PaymentKitError,
    Repo,
    find_local_payment,
    record_payment_ref_aliases,
)

from .process import HandlerCtx

_LEGACY_SCAN = 24


def _customer_ref_of(remote: Payment | None, event: NormalizedEvent) -> str | None:
    raw: Any = remote.raw if remote is not None else None
    c = raw.get("customer") if isinstance(raw, dict) else getattr(raw, "customer", None)
    if isinstance(c, str):
        return c
    cid = c.get("id") if isinstance(c, dict) else getattr(c, "id", None)
    return cid if isinstance(cid, str) else event.customer_ref


async def resolve_event_payment(ctx: HandlerCtx, event: NormalizedEvent, repo: Repo, clock: Clock) -> Payment | None:
    ref = event.payment_ref
    if not ref:
        return None
    name = ctx.provider.name
    local = await find_local_payment(repo, name, ref)
    if local is not None:
        return local
    try:
        remote: Payment | None = await ctx.provider.get_payment(ref)
    except Exception:  # noqa: BLE001 -- an unknown ref is a normal "no" here
        remote = None
    for alt in (remote.provider_ref_aliases or []) if remote is not None else []:
        hit = await find_local_payment(repo, name, alt)
        if hit is not None:
            await record_payment_ref_aliases(repo, hit, [ref], clock.now())
            return hit
    customer_ref = _customer_ref_of(remote, event)
    if not customer_ref:
        return None
    customer = next(
        (c for c in await repo.customers.list() if any(r.provider == name and r.ref == customer_ref for r in c.provider_refs)),
        None,
    )
    if customer is None:
        return None
    candidates = sorted(
        (p for p in await repo.payments.list(customer_id=customer.id, provider=name) if p.provider_ref != ref),
        key=lambda p: p.occurred_at,
        reverse=True,
    )[:_LEGACY_SCAN]
    for candidate in candidates:
        try:
            fetched: Payment | None = await ctx.provider.get_payment(candidate.provider_ref)
        except Exception:  # noqa: BLE001
            fetched = None
        aliases = (fetched.provider_ref_aliases or []) if fetched is not None else []
        if aliases:
            await record_payment_ref_aliases(repo, candidate, aliases, clock.now())
        if ref in aliases:
            return candidate
    return None


async def localize_payment_event(
    ctx: HandlerCtx, event: NormalizedEvent, kind: str, repo: Repo, clock: Clock, notifier: Notifier
) -> NormalizedEvent:
    """Name the local payment the way it was recorded. An event that matches nothing tells a person once
    and fails the record (retried: the payment may be recorded later) instead of opening a case for a
    customer that does not exist locally (the old 'unknown' customer hit the cs_cases FK)."""
    if not event.payment_ref:
        return event
    local = await resolve_event_payment(ctx, event, repo, clock)
    if local is not None:
        return dataclasses.replace(event, payment_ref=local.provider_ref)
    notice_key = f"notice:unmatched-{kind}:{ctx.provider.name}:{event.id}"
    if await repo.operations.get(notice_key) is None:
        now = clock.now()
        await repo.operations.put(Operation(id=notice_key, key=notice_key, kind="notice", payload_hash="", status="done",
                                            created_at=now, result=None, completed_at=now, attempts=1))
        await notifier.send(Notification(type="cs.needs_human", customer_id=None, payload={
            "kind": f"unmatched_{kind}", "provider": ctx.provider.name, "eventId": event.id,
            "paymentRef": event.payment_ref, "refundRef": event.refund_ref}))
    raise PaymentKitError(f"{kind} event names no local payment", f"unmatched_{kind}")
