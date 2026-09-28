"""spec: packages/lifecycle/spec/lifecycle.pseudo.md — EC:A57 A62. Mirrors upgrade-charge.ts.

The prorated money of an immediate upgrade on a self-scheduled provider (Toss/PortOne).
"""

from __future__ import annotations

import dataclasses
import hashlib
from typing import Any

from boilpayment_core import (
    Clock,
    Money,
    Payment,
    PaymentKitError,
    PaymentProvider,
    Repo,
    Subscription,
)

from .charge_attempt import is_decline, provider_order_id
from .internal import billing_customer_ref


def upgrade_payment_id(charge_key: str) -> str:
    """EC:A62 -- the local payment row of an upgrade charge: found again without a scan, on every retry."""
    return "pay_up_" + hashlib.sha256(charge_key.encode()).hexdigest()[:32]


def is_upgrade_payment(row: Payment) -> bool:
    """EC:A62 -- true for the row of an upgrade charge (kind 'subscription', no period: it buys no renewal)."""
    return isinstance(row.raw, dict) and isinstance(row.raw.get("boilpaymentUpgrade"), dict)


async def charge_upgrade_delta(
    *, provider: PaymentProvider, repo: Repo, clock: Clock, sub: Subscription, plan_id: str, charge_key: str,
    legacy_order_ids: list[str], amount: Money, revert: dict[str, Any] | None = None,
) -> Payment:
    """EC:A57 A62 -- charge the delta once, with a local payment row written before the provider is called.
    orderId and idempotency key are ``ord_`` + 40 hex of the charge key (EC:A35). The provider is asked
    first, every time, for this orderId and for the raw keys an earlier release sent: a paid order ends the
    charge, a pending or unknown answer stops the upgrade, and only an order absent or failed everywhere is
    charged. The row makes the charge refundable through the kit and lets a provider refund webhook find it."""
    row_id = upgrade_payment_id(charge_key)
    order_id = provider_order_id(charge_key)
    stored = await repo.payments.get(row_id)
    if stored is not None and stored.status == "succeeded":
        return stored
    base = stored or Payment(
        id=row_id, customer_id=sub.customer_id, provider=sub.provider, provider_ref=order_id,
        subscription_id=sub.id, amount=Money(amount_minor=amount.amount_minor, currency=amount.currency),
        status="pending", kind="subscription", period=None, occurred_at=clock.now(), failure=None,
        cash_receipt=None, raw={"boilpaymentUpgrade": {"chargeKey": charge_key, "planId": plan_id, **(revert or {})}},  # EC:A76
    )
    prior = await _prior_charge(provider, sub, order_id, legacy_order_ids)
    if prior is not None:
        return await _record(repo, base, prior)
    if stored is None:
        await repo.payments.put(base)  # durable before the provider is asked
    try:
        answer = await provider.charge_billing_key(
            billing_key=sub.billing_key or "", amount=base.amount, order_id=order_id,
            customer_ref=await billing_customer_ref(repo, sub),  # EC:A60
            idempotency_key=order_id,
        )
    except Exception as err:
        if is_decline(err):
            await repo.payments.put(dataclasses.replace(base, status="failed", failure=err.failure))  # type: ignore[attr-defined]
        raise
    return await _record(repo, base, answer)


async def _record(repo: Repo, base: Payment, answer: Payment) -> Payment:
    raw = dict(base.raw) if isinstance(base.raw, dict) else {}
    raw["provider"] = answer.raw
    row = dataclasses.replace(
        base, provider_ref=answer.provider_ref or base.provider_ref, amount=answer.amount or base.amount,
        status=answer.status, occurred_at=answer.occurred_at or base.occurred_at, failure=answer.failure,
        cash_receipt=answer.cash_receipt, raw=raw,
    )
    await repo.payments.put(row)
    return row


async def _prior_charge(provider: PaymentProvider, sub: Subscription, order_id: str, legacy: list[str]) -> Payment | None:
    lookup = getattr(provider, "get_payment_by_order_id", None)
    if lookup is None:
        return None  # the charge re-sends the same idempotency key
    seen: list[str] = []
    for oid in [order_id, *legacy]:
        if oid in seen:
            continue
        seen.append(oid)
        try:
            found = await lookup(oid)
        except Exception as err:
            # A raw legacy key the provider refuses as an orderId (Toss validates the format) was never an order.
            if oid != order_id and is_decline(err):
                continue
            raise _unresolved(sub, oid, str(err)) from err
        if found is None or found.status == "failed":
            continue
        if found.status == "succeeded":
            return found
        raise _unresolved(sub, oid, f"order is {found.status}")
    return None


def _unresolved(sub: Subscription, order_id: str, reason: str) -> PaymentKitError:
    return PaymentKitError(
        "An earlier try of this upgrade may have charged; not charging until the provider answers",
        "upgrade_charge_unresolved",
        {"subscription_id": sub.id, "order_id": order_id, "reason": reason},
    )
