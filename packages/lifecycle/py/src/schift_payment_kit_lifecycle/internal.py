"""Shared helpers, not part of the public spec surface."""

from __future__ import annotations

import dataclasses

from schift_payment_kit_core import (
    Clock,
    LedgerEntry,
    LedgerReference,
    LedgerStore,
    NewLedgerEntry,
    Plan,
    Pool,
    Subscription,
)


def replace_sub(sub: Subscription, **changes: object) -> Subscription:
    return dataclasses.replace(sub, **changes)


def scope_provider(provider: object, correlation_id: str | None):
    """EC:L5 — scope a provider call to a correlation_id via the duck-typed with_correlation_id
    (not part of the PaymentProvider Protocol — mirrors
    packages/webhook/py/src/schift_payment_kit_webhook/process.py's identical pattern for
    webhook-driven provider calls). Falls back to the bare provider when correlation_id is None or
    the provider doesn't implement with_correlation_id."""
    if not correlation_id:
        return provider
    scope = getattr(provider, "with_correlation_id", None)
    return scope(correlation_id) if callable(scope) else provider


def resolve_price_ref(plan: Plan, provider: str) -> str:
    for p in plan.prices:
        if p.provider_price_refs and p.provider_price_refs.get(provider):
            return p.provider_price_refs[provider]
    if plan.prices and plan.prices[0].provider_price_refs:
        ref = plan.prices[0].provider_price_refs.get(provider)
        if ref:
            return ref
    return plan.id


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
