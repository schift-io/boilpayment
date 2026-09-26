"""Resolve incomplete or unsigned refund notifications through the actual provider."""

from dataclasses import replace
from typing import assert_never

from boilpayment_core import (
    NormalizedEvent,
    Notification,
    Notifier,
    PaymentKitError,
    RefundLookupProvider,
)

from .process import HandlerCtx


async def _store_refund_event(ctx: HandlerCtx, notifier: Notifier) -> NormalizedEvent:
    """EC:N6 -- store refunds (Google voided purchases) carry no amount, and one-time voids no
    productId (`p|?|<token>`). Resolve both from the local payment; quantity-based partial voids
    need a person."""
    event = ctx.event

    async def fail(reason: str) -> NormalizedEvent:
        await notifier.send(
            Notification(
                type="reconcile.mismatch",
                customer_id=None,
                payload={"provider": ctx.provider.name, "eventId": event.id, "reason": reason},
            )
        )
        raise PaymentKitError(reason, "refund_reconciliation_required")

    payment_ref = event.payment_ref
    if payment_ref and payment_ref.startswith("p|?|"):
        token = payment_ref[4:]
        matches = [
            p
            for p in await ctx.repo.payments.list(provider=ctx.provider.name)
            if p.provider_ref.endswith(f"|{token}")
        ]
        if len(matches) != 1:
            return await fail("store refund could not be matched to one local payment")
        payment_ref = matches[0].provider_ref
    if event.amount is not None:
        return replace(event, payment_ref=payment_ref)
    raw = event.raw if isinstance(event.raw, dict) else {}
    voided = raw.get("voidedPurchaseNotification") or {}
    if voided.get("refundType") == 2:
        return await fail("quantity-based partial store refund needs review")
    payments = (
        await ctx.repo.payments.list(provider=ctx.provider.name, provider_ref=payment_ref)
        if payment_ref
        else []
    )
    if not payments:
        return await fail("store refund payment was not found")
    return replace(event, payment_ref=payment_ref, amount=payments[0].amount)


async def authoritative_refund_event(
    ctx: HandlerCtx, notifier: Notifier
) -> NormalizedEvent:
    if getattr(ctx.provider.capabilities(), "checkout", "hosted") == "on_device":
        return await _store_refund_event(ctx, notifier)
    if ctx.provider.name not in ("toss", "portone"):
        return ctx.event
    refund_ref = ctx.event.refund_ref
    payment_ref = ctx.event.payment_ref
    if not payment_ref and refund_ref:
        refunds = await ctx.repo.refunds.list(provider_ref=refund_ref)
        for refund in refunds:
            payment = await ctx.repo.payments.get(refund.payment_id)
            if payment is not None and payment.provider == ctx.provider.name:
                if payment_ref and payment_ref != payment.provider_ref:
                    raise PaymentKitError(
                        "ambiguous refund reference", "refund_reconciliation_required"
                    )
                payment_ref = payment.provider_ref
    if refund_ref and payment_ref and isinstance(ctx.provider, RefundLookupProvider):
        refund = await ctx.provider.get_refund(
            payment_ref=payment_ref, refund_ref=refund_ref
        )
        if refund is not None and refund.provider_ref == refund_ref:
            match refund.status:
                case "succeeded":
                    event_type = "refund.created"
                case "failed":
                    event_type = "refund.failed"
                case "pending":
                    event_type = "refund.pending"
                case unreachable:
                    assert_never(unreachable)
            return replace(
                ctx.event,
                type=event_type,
                payment_ref=payment_ref,
                refund_ref=refund_ref,
                amount=refund.amount,
            )
    await notifier.send(
        Notification(
            type="reconcile.mismatch",
            customer_id=None,
            payload={
                "provider": ctx.provider.name,
                "eventId": ctx.event.id,
                "reason": "authoritative refund could not be identified",
            },
        )
    )
    raise PaymentKitError(
        "authoritative refund could not be identified", "refund_reconciliation_required"
    )
