"""Shared helpers, not part of the public spec surface."""

from __future__ import annotations

import dataclasses

from boilpayment_core import (
    Clock,
    LedgerEntry,
    LedgerReference,
    LedgerStore,
    NewLedgerEntry,
    PaymentKitError,
    Plan,
    PlanPrice,
    Pool,
    Subscription,
)


def replace_sub(sub: Subscription, **changes: object) -> Subscription:
    return dataclasses.replace(sub, **changes)


def scope_provider(provider: object, correlation_id: str | None):
    """EC:L5 — scope a provider call to a correlation_id via the duck-typed with_correlation_id
    (not part of the PaymentProvider Protocol — mirrors
    packages/webhook/py/src/boilpayment_webhook/process.py's identical pattern for
    webhook-driven provider calls). Falls back to the bare provider when correlation_id is None or
    the provider doesn't implement with_correlation_id."""
    if not correlation_id:
        return provider
    scope = getattr(provider, "with_correlation_id", None)
    return scope(correlation_id) if callable(scope) else provider


def resolve_price_ref(plan: Plan, provider: str, currency: str | None = None) -> str:
    # EC:A28 -- the price in the subscription's currency first.
    if currency:
        for p in plan.prices:
            if p.currency == currency and p.provider_price_refs and p.provider_price_refs.get(provider):
                return p.provider_price_refs[provider]
    for p in plan.prices:
        if p.provider_price_refs and p.provider_price_refs.get(provider):
            return p.provider_price_refs[provider]
    if plan.prices and plan.prices[0].provider_price_refs:
        ref = plan.prices[0].provider_price_refs.get(provider)
        if ref:
            return ref
    return plan.id


def renewal_plan_id(sub: Subscription) -> str:
    """EC:A29 -- the plan a renewal moves the subscription into: a scheduled change applies now."""
    return sub.scheduled_plan_id or sub.plan_id


def price_for_subscription(plan: Plan, sub: Subscription) -> PlanPrice | None:
    """EC:A28 -- the plan price a subscription is charged: the one in its currency. A subscription
    written before `currency` existed falls back to the first price (previous behaviour). None when
    the plan has no usable price, so the caller refuses the charge instead of switching currency."""
    if sub.currency:
        return next((p for p in plan.prices if p.currency == sub.currency), None)
    return plan.prices[0] if plan.prices else None


def require_price_for_subscription(plan: Plan, sub: Subscription) -> PlanPrice:
    """EC:A28 -- price_for_subscription, raising `plan_price_missing` when there is none."""
    price = price_for_subscription(plan, sub)
    if price is None:
        raise PaymentKitError(
            f"plan {plan.id} has no price in {sub.currency or 'any currency'}",
            "plan_price_missing",
            {"planId": plan.id, "currency": sub.currency},
        )
    return price


async def revoke_pool_balance(
    pool: Pool,
    ledger: LedgerStore,
    clock: Clock,
    customer_id: str,
    reference: LedgerReference,
    idempotency_key: str,
    reason: str,
) -> LedgerEntry | None:
    """Revoke the full available balance of a single pool (trial-cancel / trial-convert-discard)."""
    balance = await ledger.balance(customer_id, pool, clock.now())
    if balance.available <= 0:
        return None
    result = await ledger.append(
        NewLedgerEntry(
            customer_id=customer_id,
            pool=pool,
            kind="revoke",
            amount=-balance.available,
            unit_price_minor=None,
            currency=None,
            expires_at=None,
            source="trial",
            reference=reference,
            idempotency_key=idempotency_key,
            actor="system",
            reason=reason,
        )
    )
    return result.entry
