"""Drives the real Stripe SDK code paths of StripeProvider against stripe-mock (no keys, no network).
Run: stripe-mock -http-port 12111 &  then  .venv/bin/python examples/live/stripe_mock.py"""

import asyncio
import json
import os
from datetime import UTC, datetime

from boilpayment_core import (
    CreateCheckoutInput,
    Money,
    PaymentKitError,
    Plan,
    PlanPrice,
)
from boilpayment_stripe import StripeProvider


def out(k, v):
    print(f"{k}: {json.dumps(v, default=str)}")


async def main():
    p = StripeProvider(
        secret_key="sk_test_123",
        webhook_secret="whsec_test",
        api_base=f"http://127.0.0.1:{os.environ.get('STRIPE_MOCK_PORT', '12111')}",
    )
    price = PlanPrice(
        currency="USD", amount_minor=1000, provider_price_refs={"stripe": "price_123"}
    )
    plan = Plan(
        id="plan_a",
        name="A",
        interval="month",
        credits_per_period=100,
        usage_included=0,
        trial_days=0,
        prices=[price],
    )
    c = await p.create_customer(email="a@b.c")
    out("createCustomer", c)
    ck = await p.create_checkout(
        CreateCheckoutInput(
            customer_ref=c["ref"],
            plan=plan,
            price=price,
            mode="subscription",
            success_url="https://x/s",
            cancel_url="https://x/c",
            idempotency_key="checkout:1",
        )
    )
    out("createCheckout", {"id": ck.id, "hasUrl": bool(ck.url)})
    pay = await p.get_payment("pi_123")
    out(
        "getPayment",
        {
            "status": pay.status,
            "kind": pay.kind,
            "amount": {
                "amountMinor": pay.amount.amount_minor,
                "currency": pay.amount.currency,
            },
        },
    )
    inv = await p.get_payment("in_123")
    out("getPayment_invoice", {"status": inv.status, "kind": inv.kind})
    sub = await p.get_subscription("sub_123")
    out(
        "getSubscription",
        {
            "status": sub.status,
            "anchorDay": sub.anchor_day,
            "hasPeriod": bool(sub.current_period.start),
        },
    )
    ch = await p.change_subscription(
        "sub_123", new_price_ref="price_456", proration="immediate", reset_anchor=True
    )
    out("changeSubscription", {"status": ch.status})
    cx = await p.cancel_subscription("sub_123", at_period_end=True)
    out(
        "cancelSubscription",
        {"status": cx.status, "cancelAtPeriodEnd": cx.cancel_at_period_end},
    )
    uc = await p.uncancel_subscription("sub_123")
    out(
        "uncancelSubscription",
        {"status": uc.status, "cancelAtPeriodEnd": uc.cancel_at_period_end},
    )
    rf = await p.refund(
        payment_ref="pi_123",
        amount=Money(amount_minor=500, currency="USD"),
        reason="requested_by_customer",
        idempotency_key="refund:1",
    )
    out(
        "refund",
        {
            "status": rf.status,
            "amount": {
                "amountMinor": rf.amount.amount_minor,
                "currency": rf.amount.currency,
            },
            "providerRef": rf.provider_ref,
        },
    )
    await p.report_usage(
        meter="api_calls",
        customer_ref=c["ref"],
        quantity=3,
        occurred_at=datetime.now(UTC),
        idempotency_key="u:1",
    )
    out("reportUsage", "ok")
    lp = await p.list_payments(
        customer_ref=c["ref"], since=datetime.fromtimestamp(0, UTC)
    )
    out("listPayments", {"count": len(lp)})
    try:
        await p.charge_billing_key(
            billing_key="x",
            amount=Money(amount_minor=1, currency="USD"),
            order_id="o",
            customer_ref=c["ref"],
            idempotency_key="k",
        )
        raise AssertionError("Expected unsupported billing-key rejection")
    except PaymentKitError as e:
        assert e.code == "unsupported"
        out("chargeBillingKey", e.code)
    print("STRIPE-MOCK ROUND TRIP OK")


asyncio.run(main())
