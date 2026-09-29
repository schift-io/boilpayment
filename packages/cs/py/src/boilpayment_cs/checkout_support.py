"""Capture checkout rules before provider creation and bind completed payments to that sale."""

from __future__ import annotations

from copy import deepcopy
from dataclasses import asdict, dataclass, replace

from boilpayment_core import (
    Checkout,
    CreateCheckoutInput,
    PaymentKitError,
    ProviderError,
    ProviderName,
    run_idempotent,
)

from .purchase_snapshot import (
    CheckoutSnapshot,
    parse_checkout_snapshot,
)
from .support import SupportDeps


@dataclass(frozen=True, slots=True, kw_only=True)
class StartCheckoutInput(SupportDeps):
    customer_id: str
    plan_id: str
    provider: ProviderName
    currency: str
    request_id: str
    success_url: str
    cancel_url: str
    allow_discount_codes: bool = False
    preset_discount_code: str | None = None
    affiliate_id: str | None = None


def _is_definitive_provider_refusal(error: ProviderError) -> bool:
    detail_status = (
        error.details.get("status") if isinstance(error.details, dict) else None
    )
    status = error.http_status if error.http_status is not None else detail_status
    return (
        isinstance(status, int)
        and 400 <= status < 500
        and status not in (408, 409, 429)
    )


async def start_checkout(input: StartCheckoutInput) -> Checkout:
    key = f"checkout-entitlement:{input.customer_id}:{input.request_id}"
    # EC:A73 -- a frozen or banned customer (an open or lost dispute) buys nothing.
    owner = await input.repo.customers.get(input.customer_id)
    if owner is not None and owner.status != "active":
        raise PaymentKitError(f"customer is {owner.status}", f"customer_{owner.status}", {"customer_id": input.customer_id})
    # EC:A74 -- a Toss/PortOne subscription plan starts with start_subscription (a billing key), never a checkout order.
    selling = await input.repo.plans.get(input.plan_id)
    seller = input.providers.get(input.provider)
    if selling is not None and selling.interval and seller is not None and not seller.capabilities().native_subscriptions:
        raise PaymentKitError(f"{input.provider} subscription plans start with start_subscription", "use_start_subscription",
                              {"plan_id": input.plan_id, "provider": input.provider})

    async def capture() -> CheckoutSnapshot:
        customer = await input.repo.customers.get(input.customer_id)
        plan = await input.repo.plans.get(input.plan_id)
        customer_ref = (
            next(
                (
                    ref.ref
                    for ref in customer.provider_refs
                    if ref.provider == input.provider
                ),
                None,
            )
            if customer
            else None
        )
        prices = (
            [price for price in plan.prices if price.currency == input.currency]
            if plan
            else []
        )
        if not customer_ref or not plan or len(prices) != 1:
            raise PaymentKitError(
                "customer, plan or unique price missing", "checkout_evidence_missing"
            )
        return deepcopy(
            CheckoutSnapshot(
                intent_key=key,
                checkout_id=None,
                checkout_provider_ref=None,
                customer_id=input.customer_id,
                customer_ref=customer_ref,
                provider=input.provider,
                plan=plan,
                price=prices[0],
                policy=input.policy,
                captured_at=input.clock.now().isoformat(),
                allow_discount_codes=input.allow_discount_codes,
                preset_discount_code=input.preset_discount_code,
                affiliate_id=input.affiliate_id,
            )
        )

    captured = await run_idempotent(
        repo=input.repo,
        clock=input.clock,
        key=key,
        kind="checkout.entitlement",
        payload={
            "customer_id": input.customer_id,
            "plan_id": input.plan_id,
            "provider": input.provider,
            "currency": input.currency,
            "allow_discount_codes": input.allow_discount_codes,
            "preset_discount_code": input.preset_discount_code,
            "affiliate_id": input.affiliate_id,
        },
        serialize=asdict,
        deserialize=parse_checkout_snapshot,
        fn=capture,
    )
    snapshot = captured.result
    provider = input.providers.get(snapshot.provider)
    if provider is None:
        raise PaymentKitError(
            "checkout provider unavailable", "checkout_evidence_missing"
        )
    # OT-03 -- Stripe/Polar require a provider-side price reference. Validate the captured sale
    # before invoking create_checkout and release the unsold snapshot for a repaired retry.
    price_refs = snapshot.price.provider_price_refs or {}
    if snapshot.provider in ("stripe", "polar") and snapshot.provider not in price_refs:
        recorded = await input.repo.operations.get(key)
        if recorded is not None and recorded.status == "done":
            await input.repo.operations.put(replace(
                recorded, status="failed", result=None, error="missing_provider_price_ref",
                completed_at=input.clock.now(),
            ))
        legacy_key = f"checkout-result:{input.customer_id}:{input.request_id}"
        legacy = await input.repo.operations.get(legacy_key)
        legacy_result = legacy.result if legacy is not None else None
        legacy_unknown = (
            isinstance(legacy_result, dict)
            and (legacy_result.get("kind") == "unknown" or legacy_result.get("checkout", False) is None)
        )
        if legacy is not None and legacy.status == "done" and legacy_unknown:
            await input.repo.operations.put(replace(
                legacy, status="failed", result=None, error="missing_provider_price_ref",
                completed_at=input.clock.now(),
            ))
        raise PaymentKitError(
            f"set plan_prices.provider_price_refs for plan {snapshot.plan.id} / {snapshot.price.currency}",
            "missing_provider_price_ref",
            {"plan_id": snapshot.plan.id},
        )

    async def create() -> CheckoutAttempt:
        try:
            checkout = await provider.create_checkout(
                CreateCheckoutInput(
                    customer_ref=snapshot.customer_ref,
                    plan=snapshot.plan,
                    price=snapshot.price,
                    mode="one_time"
                    if snapshot.plan.interval is None
                    else "subscription",
                    success_url=input.success_url,
                    cancel_url=input.cancel_url,
                    idempotency_key=key,
                    allow_discount_codes=snapshot.allow_discount_codes,
                    preset_discount_code=snapshot.preset_discount_code,
                    affiliate_id=snapshot.affiliate_id,
                    metadata={
                        "customerId": snapshot.customer_id,
                        "planId": snapshot.plan.id,
                        "checkoutEntitlementKey": key,
                        **({"affiliateId": snapshot.affiliate_id} if snapshot.affiliate_id else {}),
                    },
                )
            )

            return CheckoutAttempt(checkout=checkout)
        # OT-03 -- pre-request price validation is definitive. Discard the unsold snapshot so a
        # catalog repair is recaptured on retry; provider/transport outcomes remain unknown here.
        except PaymentKitError as error:
            if isinstance(error, ProviderError):
                if _is_definitive_provider_refusal(error):
                    raise
                return CheckoutAttempt(checkout=None)
            if error.code in ("missing_provider_price_ref", "full_discount_unsupported"):
                recorded = await input.repo.operations.get(key)
                if recorded is not None and recorded.status == "done":
                    await input.repo.operations.put(replace(
                        recorded, status="failed", result=None, error=str(error), completed_at=input.clock.now()
                    ))
            raise
        except (OSError, TimeoutError, RuntimeError):
            return CheckoutAttempt(checkout=None)

    result_key = f"checkout-result:{input.customer_id}:{input.request_id}"
    try:
        attempt = await run_idempotent(
            repo=input.repo,
            clock=input.clock,
            key=result_key,
            kind="checkout.entitlement",
            payload={
                "key": key,
                "success_url": input.success_url,
                "cancel_url": input.cancel_url,
            },
            serialize=asdict,
            deserialize=parse_checkout_attempt,
            fn=create,
        )
    except ProviderError as error:
        if _is_definitive_provider_refusal(error):
            await input.repo.operations.delete(result_key)
            await input.repo.operations.delete(key)
        raise
    if attempt.result.checkout is None:
        raise PaymentKitError(
            "checkout creation outcome unknown; reconcile before a new request",
            "checkout_outcome_unknown",
        )
    checkout = attempt.result.checkout

    async def alias() -> CheckoutSnapshot:
        return replace(
            snapshot,
            checkout_id=checkout.id,
            checkout_provider_ref=checkout.provider_ref,
        )

    await run_idempotent(
        repo=input.repo,
        clock=input.clock,
        key=f"checkout-entitlement-by-id:{checkout.id}",
        kind="checkout.entitlement",
        payload={"key": key},
        serialize=asdict,
        deserialize=parse_checkout_snapshot,
        fn=alias,
    )

    # OT-09 -- a one-time payment event can name only the kit's key (PaymentIntent metadata), never
    # the checkout id; this reverse pointer lets the webhook find the sale to hold the payment for.
    async def pointer() -> dict[str, str]:
        return {"checkoutId": checkout.id}

    await run_idempotent(
        repo=input.repo,
        clock=input.clock,
        key=f"checkout-id-by-key:{key}",
        kind="checkout.entitlement",
        payload={"checkoutId": checkout.id},
        fn=pointer,
    )
    return checkout


@dataclass(frozen=True, slots=True)
class CheckoutAttempt:
    checkout: Checkout | None


def parse_checkout_attempt(value) -> CheckoutAttempt:
    checkout = value.get("checkout")
    if checkout is None:
        return CheckoutAttempt(checkout=None)
    return CheckoutAttempt(
        checkout=Checkout(
            id=checkout["id"],
            url=checkout["url"],
            provider_ref=checkout["provider_ref"],
        )
    )
