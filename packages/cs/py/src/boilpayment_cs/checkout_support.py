"""Capture checkout rules before provider creation and bind completed payments to that sale."""

from __future__ import annotations

from copy import deepcopy
from dataclasses import asdict, dataclass, replace

from boilpayment_core import (
    Checkout,
    CreateCheckoutInput,
    PaymentKitError,
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


async def start_checkout(input: StartCheckoutInput) -> Checkout:
    key = f"checkout-entitlement:{input.customer_id}:{input.request_id}"

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
                    metadata={
                        "customerId": snapshot.customer_id,
                        "planId": snapshot.plan.id,
                        "checkoutEntitlementKey": key,
                    },
                )
            )

            return CheckoutAttempt(checkout=checkout)
        except (PaymentKitError, OSError, TimeoutError, RuntimeError):
            return CheckoutAttempt(checkout=None)

    attempt = await run_idempotent(
        repo=input.repo,
        clock=input.clock,
        key=f"checkout-result:{input.customer_id}:{input.request_id}",
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
