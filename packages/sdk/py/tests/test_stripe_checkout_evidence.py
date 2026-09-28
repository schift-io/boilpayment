from __future__ import annotations

import stripe
from boilpayment_core import Plan, PlanPrice, resolve_policy
from boilpayment_cs.purchase_snapshot import CheckoutSnapshot, matches_checkout_payment
from boilpayment_stripe import normalize_payment_intent


def test_real_stripe_payment_intent_matches_checkout_evidence() -> None:
    intent_key = "intent_immutable"
    payment_intent = stripe.PaymentIntent.construct_from(
        {
            "id": "pi_test_1",
            "amount": 9900,
            "currency": "krw",
            "status": "succeeded",
            "created": 1_700_000_000,
            "metadata": {"checkoutEntitlementKey": intent_key},
        },
        "sk_test",
    )
    price = PlanPrice(currency="KRW", amount_minor=9900)
    snapshot = CheckoutSnapshot(
        intent_key=intent_key,
        checkout_id="cs_test_1",
        checkout_provider_ref="cs_test_1",
        customer_id="customer_1",
        customer_ref="cus_test_1",
        provider="stripe",
        plan=Plan(
            id="plan_topup",
            name="Top up",
            interval=None,
            credits_per_period=100,
            usage_included=0,
            trial_days=0,
            prices=[price],
        ),
        price=price,
        policy=resolve_policy(),
        captured_at="2023-11-14T22:13:20+00:00",
    )

    payment = normalize_payment_intent(payment_intent)

    assert isinstance(payment.raw, dict)
    assert isinstance(payment.raw["metadata"], dict)
    assert matches_checkout_payment(snapshot, payment.raw, payment.provider_ref) is True
