"""[EC:A28] A subscription registered from a checkout remembers the currency it was bought in."""
from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime

import anyio
from boilpayment_core import Checkout, Period, Plan, PlanPrice, Subscription
from boilpayment_cs import (
    RegisterCompletedCheckoutInput,
    StartCheckoutInput,
    register_completed_checkout,
    start_checkout,
)
from test_support import setup


def test_ot_09_registration_links_held_subscription_payment() -> None:
    async def run():
        deps, provider, _ = await setup()
        period = Period(start=deps["clock"].now(), end=datetime(2026, 2, 1, tzinfo=UTC))
        await deps["repo"].plans.put(Plan(id="monthly", name="Monthly", interval="month", credits_per_period=100,
                                          usage_included=0, trial_days=0, prices=[PlanPrice(
                                              currency="USD", amount_minor=1000,
                                              provider_price_refs={"stripe": "price_currency"},
                                          )]))
        base_get = provider.get_payment

        async def get_payment(ref):
            p = await base_get(ref)
            return replace(p, provider_ref="pi_sub", kind="subscription", subscription_id="sub_remote", period=period)

        async def list_payments(**kwargs):
            return [await get_payment("pi_sub")]

        async def get_subscription(ref):
            return Subscription(id="sub_remote", customer_id="cus_1", plan_id="monthly", provider="stripe", provider_ref="sub_remote",
                                status="active", current_period=period, anchor_day=1, cancel_at_period_end=False, grace_until=None,
                                billing_key=None, scheduled_plan_id=None, created_at=deps["clock"].now())

        async def create_checkout(input):
            provider.checkout_key = input.metadata["checkoutEntitlementKey"]
            return Checkout(id="cs_sub", provider_ref="cs_sub", url="https://example.test/sub")

        provider.get_payment, provider.list_payments, provider.get_subscription = get_payment, list_payments, get_subscription
        provider.create_checkout = create_checkout
        await start_checkout(StartCheckoutInput(**deps, customer_id="customer", plan_id="monthly", provider="stripe", currency="USD",
                                                request_id="sub-sale", success_url="https://example.test/ok", cancel_url="https://example.test/cancel"))
        held = replace(
            await get_payment("cs_sub"),
            id="payment:stripe:pi_sub",
            customer_id="customer",
            subscription_id=None,
        )
        await deps["repo"].payments.put(held)
        payment = await register_completed_checkout(RegisterCompletedCheckoutInput(**deps, customer_id="customer", checkout_id="cs_sub", payment_ref="pi_sub"))
        sub = await deps["repo"].subscriptions.get("subscription:stripe:sub_remote")
        return payment.subscription_id, sub.currency if sub else "missing"

    assert anyio.run(run) == ("subscription:stripe:sub_remote", "USD")
