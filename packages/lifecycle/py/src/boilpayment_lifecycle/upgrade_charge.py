"""spec: packages/lifecycle/spec/lifecycle.pseudo.md — EC:A57. Mirrors upgrade-charge.ts.

The prorated money delta of an immediate upgrade on a self-scheduled provider (Toss/PortOne).
"""

from __future__ import annotations

from boilpayment_core import (
    Money,
    Payment,
    PaymentKitError,
    PaymentProvider,
    Repo,
    Subscription,
)

from .charge_attempt import is_decline, provider_order_id


async def charge_upgrade_delta(
    *, provider: PaymentProvider, repo: Repo, sub: Subscription, op_key: str, charge_key: str,
    legacy_order_ids: list[str], amount: Money,
) -> Payment:
    """EC:A57 -- charge the delta once. orderId and idempotency key are ``ord_`` + 40 hex of the charge
    key (EC:A35). When the upgrade operation runs again the provider is asked first, for this orderId and
    for the raw keys an earlier release sent: a paid order ends the charge, a pending or unknown answer
    stops the upgrade, and only an order absent or failed everywhere is charged."""
    order_id = provider_order_id(charge_key)
    op = await repo.operations.get(op_key)
    if (op.attempts if op is not None else 1) > 1:
        prior = await _prior_charge(provider, sub, order_id, legacy_order_ids)
        if prior is not None:
            return prior
    return await provider.charge_billing_key(
        billing_key=sub.billing_key or "", amount=amount, order_id=order_id,
        customer_ref=sub.customer_id, idempotency_key=order_id,
    )


async def _prior_charge(provider: PaymentProvider, sub: Subscription, order_id: str, legacy: list[str]) -> Payment | None:
    lookup = getattr(provider, "get_payment_by_order_id", None)
    if lookup is None:
        return None  # the charge re-sends the same idempotency key
    for oid in [order_id, *[x for x in legacy if x != order_id]]:
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
