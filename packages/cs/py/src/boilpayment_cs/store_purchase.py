"""EC:N1 -- in-app purchases (Apple App Store, Google Play). Mirrors packages/cs/ts/src/storePurchase.ts.

Sibling of register_completed_checkout for purchases that happen on the device: the store's proof
is verified by the store provider, immutable sale facts are pinned, the payment is recorded once,
the original grant primitive runs, and Google purchases are acknowledged only after the grant.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, replace
from datetime import timedelta
from typing import Any

from boilpayment_core import (
    IapSettings,
    Money,
    Payment,
    PaymentKitError,
    PlanPrice,
    ProviderRef,
    StoreProof,
    is_store_purchase_provider,
    run_idempotent,
    store_account_token,
)

from .apply_purchased_grant import apply_purchased_grant
from .purchase_snapshot import PurchaseSnapshot, parse_purchase_snapshot
from .recover_missing_grant import (
    RecoverMissingGrantInput,
    SupportGrantOutcome,
    SupportGrants,
)
from .support import SupportDeps


@dataclass(frozen=True, slots=True, kw_only=True)
class RegisterStorePurchaseInput(SupportDeps):
    customer_id: str
    provider: str
    proof: StoreProof
    grants: SupportGrants
    iap: IapSettings | None = None


@dataclass(frozen=True, slots=True, kw_only=True)
class StorePurchaseResult:
    payment: Payment
    replayed: bool  # EC:N2 -- the same proof was already recorded
    grant: SupportGrantOutcome
    acknowledged: bool  # EC:N1 -- False when a Google acknowledgement failed


def _iso(value: Any) -> str:
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _refuse(code: str, message: str, details: Any = None) -> PaymentKitError:
    return PaymentKitError(message, code, details)


async def register_store_purchase(
    input: RegisterStorePurchaseInput,
) -> StorePurchaseResult:
    repo, clock, customer_id, name = (
        input.repo,
        input.clock,
        input.customer_id,
        input.provider,
    )
    provider = input.providers.get(name)  # type: ignore[call-overload]
    if not is_store_purchase_provider(provider):
        raise _refuse(
            "iap_provider_missing",
            f"{name} is not configured as an in-app purchase store",
        )
    iap = input.iap or IapSettings()
    v = await provider.verify_purchase(input.proof)  # type: ignore[union-attr]
    if v.environment == "sandbox" and iap.environments == "production_only":  # EC:N3
        raise _refuse("iap_wrong_environment", "sandbox purchases are not accepted")
    if v.ownership == "family_shared" and iap.family_sharing == "ignore":  # EC:N5
        raise _refuse(
            "iap_family_shared_refused", "family-shared purchases are not granted"
        )
    expected = store_account_token(customer_id)
    mismatch = (
        v.account_token != expected
        if v.account_token is not None
        else iap.account_link == "require"
    )
    if mismatch:  # EC:N4
        reason = (
            "purchase carries no account token"
            if v.account_token is None
            else "purchase belongs to another account"
        )
        raise _refuse("iap_account_mismatch", reason)
    if v.payment.status != "succeeded":  # EC:A25
        raise _refuse(
            "iap_payment_not_succeeded",
            f"store purchase is {v.payment.status}",
            {"status": v.payment.status},
        )
    payment_ref = v.payment.provider_ref
    payment_id = f"payment:{name}:{payment_ref}"
    already = await repo.payments.get(payment_id)
    if already is not None and already.customer_id != customer_id:  # EC:N2 N4
        raise _refuse(
            "iap_already_claimed", "this purchase is recorded for another customer"
        )

    plans = await repo.plans.list()
    plan = next(
        (
            p
            for p in plans
            if any(
                (pr.provider_price_refs or {}).get(name) == v.product_id
                for pr in p.prices
            )
        ),
        None,
    )
    if plan is None:
        raise _refuse(
            "iap_unknown_product",
            f"no plan maps {name} product {v.product_id}",
            {"productId": v.product_id},
        )
    if (plan.interval is None) != (v.subscription_ref is None):
        raise _refuse(
            "iap_product_mismatch",
            "store product type does not match the plan interval",
        )
    catalog = next(
        pr
        for pr in plan.prices
        if (pr.provider_price_refs or {}).get(name) == v.product_id
    )
    # EC:N11 -- the store's charged amount is the payment's money; the plan decides the grant.
    src = v.payment.amount if v.amount_from_store else None
    price = PlanPrice(
        currency=src.currency if src else catalog.currency,
        amount_minor=src.amount_minor if src else catalog.amount_minor,
        provider_price_refs={name: v.product_id},  # type: ignore[dict-item]
    )
    period = v.payment.period
    if v.subscription_ref and (period is None or period.end <= clock.now()):
        raise _refuse(
            "iap_purchase_expired", "store subscription period has already ended"
        )

    customer = await repo.customers.get(customer_id)
    if customer is None:
        raise _refuse(
            "customer_not_found",
            "customer must exist before registering a store purchase",
        )
    customer_ref = v.account_token or customer_id
    if not any(
        r.provider == name and r.ref == customer_ref for r in customer.provider_refs
    ):
        await repo.customers.put(
            replace(
                customer,
                provider_refs=[
                    *customer.provider_refs,
                    ProviderRef(provider=name, ref=customer_ref),
                ],
            )  # type: ignore[arg-type]
        )

    subscription_id: str | None = None
    if v.subscription_ref and v.subscription is not None:
        subscription_id = f"subscription:{name}:{v.subscription_ref}"
        existing = await repo.subscriptions.get(subscription_id)
        if existing is not None and existing.customer_id != customer_id:
            raise _refuse(
                "iap_already_claimed",
                "this subscription is recorded for another customer",
            )
        if existing is None:
            await repo.subscriptions.put(
                replace(
                    v.subscription,
                    id=subscription_id,
                    customer_id=customer_id,
                    plan_id=plan.id,
                    provider=name,
                    provider_ref=v.subscription_ref,
                    version=0,  # type: ignore[arg-type]
                )
            )
        if v.replaces_subscription_ref:  # EC:N9 -- one purchase is never held twice
            for old in await repo.subscriptions.list(
                provider=name, provider_ref=v.replaces_subscription_ref
            ):
                if old.status not in ("canceled", "expired"):
                    await repo.subscriptions.put(replace(old, status="canceled"))

    snapshot = PurchaseSnapshot(
        intent_key=f"store:{name}:{payment_ref}",
        checkout_id=None,
        checkout_provider_ref=None,
        customer_id=customer_id,
        customer_ref=customer_ref,
        provider=name,  # type: ignore[arg-type]
        plan=plan,
        price=price,
        policy=input.policy,
        captured_at=_iso(clock.now()),
        payment_id=payment_id,
        payment_ref=payment_ref,
        purchased_at=_iso(v.payment.occurred_at),
        subscription_id=subscription_id,
        period={"start": _iso(period.start), "end": _iso(period.end)}
        if period
        else None,
    )

    async def capture() -> PurchaseSnapshot:
        return snapshot

    await run_idempotent(
        repo=repo,
        clock=clock,
        key=f"purchase-entitlement:{payment_id}",
        kind="purchase.entitlement",
        payload={"provider": name, "paymentRef": payment_ref},
        serialize=asdict,
        deserialize=parse_purchase_snapshot,
        fn=capture,
    )
    payment = already or await repo.payments.put(
        replace(
            v.payment,
            id=payment_id,
            customer_id=customer_id,
            subscription_id=subscription_id,
            amount=Money(amount_minor=price.amount_minor, currency=price.currency),
            kind="topup" if plan.interval is None else "subscription",
            cash_receipt=None,
            raw=None,
        )
    )
    grant = await apply_purchased_grant(
        RecoverMissingGrantInput(
            policy=input.policy,
            providers=input.providers,
            ledger=input.ledger,
            repo=repo,
            clock=clock,
            ids=input.ids,
            notifier=input.notifier,
            on_case_event=input.on_case_event,
            reporter=input.reporter,
            customer_id=customer_id,
            payment_id=payment_id,
            grants=input.grants,
        )
    )
    acknowledged = v.acknowledged or await _acknowledge(
        input.providers, repo, clock, payment
    )
    return StorePurchaseResult(
        payment=payment,
        replayed=already is not None,
        grant=grant,
        acknowledged=acknowledged,
    )


async def _acknowledge(providers: Any, repo: Any, clock: Any, payment: Payment) -> bool:
    """EC:N1 -- acknowledge once the grant is committed; a failure is left for the reconcile cron."""
    provider = providers.get(payment.provider)
    ack = getattr(provider, "acknowledge", None)
    if not is_store_purchase_provider(provider) or not callable(ack):
        return True

    async def run() -> dict[str, bool]:
        return await ack(payment.provider_ref)

    try:
        await run_idempotent(
            repo=repo,
            clock=clock,
            key=f"iap-ack:{payment.id}",
            kind="iap.acknowledge",
            payload={"paymentRef": payment.provider_ref},
            fn=run,
        )
        return True
    except Exception:  # noqa: BLE001 -- any failure is retried by reack_store_purchases
        return False


async def reack_store_purchases(
    *, providers: Any, repo: Any, clock: Any, within_days: int = 3
) -> dict[str, Any]:
    """EC:N1 -- re-acknowledge store purchases granted in the last `within_days` (Google's window)."""
    since = clock.now() - timedelta(days=within_days)
    acknowledged, failed = 0, []
    for name, provider in providers.items():
        if not is_store_purchase_provider(provider) or not callable(
            getattr(provider, "acknowledge", None)
        ):
            continue
        for payment in await repo.payments.list(provider=name):
            if payment.status != "succeeded" or payment.occurred_at < since:
                continue
            done = await repo.operations.get(f"iap-ack:{payment.id}")
            if done is not None and done.status == "done":
                continue
            if await _acknowledge(providers, repo, clock, payment):
                acknowledged += 1
            else:
                failed.append(payment.id)
    return {"acknowledged": acknowledged, "failed": failed}
