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
    Repo,
    Subscription,
)


async def billing_customer_ref(repo: Repo, sub: Subscription) -> str:
    """EC:A60 -- the customer key a billing-key charge sends: the one the key was issued under (stored on
    the subscription), else the customer's provider reference (backfilled and create_customer customers),
    else the local id (rows written before either existed, as before). Toss refuses a billing-key charge
    whose customerKey differs from the key's."""
    if sub.billing_customer_ref:
        return sub.billing_customer_ref
    customer = await repo.customers.get(sub.customer_id)
    if customer is not None:
        for ref in customer.provider_refs:
            if ref.provider == sub.provider:
                return ref.ref
    return sub.customer_id


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
    # EC:A28 A33 -- a subscription with a currency only ever gets a price ref in that currency; a
    # plan without a price in it is refused (never a silent switch to another currency's price).
    if currency:
        price = next((p for p in plan.prices if p.currency == currency), None)
        if price is None:
            raise PaymentKitError(
                f"plan {plan.id} has no price in {currency}", "plan_price_missing",
                {"plan_id": plan.id, "currency": currency},
            )
        return (price.provider_price_refs or {}).get(provider) or plan.id
    for p in plan.prices:
        if p.provider_price_refs and p.provider_price_refs.get(provider):
            return p.provider_price_refs[provider]
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
