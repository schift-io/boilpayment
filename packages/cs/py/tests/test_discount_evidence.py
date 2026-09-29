from dataclasses import replace
from datetime import UTC, datetime

from boilpayment_core import (
    DEFAULT_POLICY,
    Money,
    Payment,
    Plan,
    PlanPrice,
    SaleEvidence,
)
from boilpayment_cs.purchase_snapshot import (
    CheckoutSnapshot,
    matches_captured_sale_amount,
)


def _fixtures() -> tuple[CheckoutSnapshot, Payment]:
    snapshot = CheckoutSnapshot(
        intent_key="key",
        checkout_id="cs_1",
        checkout_provider_ref="cs_1",
        customer_id="customer",
        customer_ref="cus_1",
        provider="stripe",
        plan=Plan(id="plan", name="Plan", interval=None, credits_per_period=100, usage_included=0, trial_days=0, prices=[]),
        price=PlanPrice(currency="USD", amount_minor=2_000, provider_price_refs={"stripe": "price_1"}),
        policy=DEFAULT_POLICY,
        captured_at="2026-09-28T00:00:00+00:00",
    )
    payment = Payment(
        id="payment:stripe:pi_1", customer_id="customer", provider="stripe", provider_ref="pi_1",
        subscription_id=None, amount=Money(amount_minor=1_600, currency="USD"), status="succeeded", kind="topup",
        period=None, occurred_at=datetime(2026, 9, 28, tzinfo=UTC),
        sale_evidence=SaleEvidence(
            provider_subtotal=Money(amount_minor=2_000, currency="USD"),
            discount_amount=Money(amount_minor=400, currency="USD"), price_ref="price_1",
            checkout_id="cs_1", payment_link_id=None, link_reference=None,
        ),
    )
    return snapshot, payment


def test_dc_02_accepts_provider_discount_arithmetic():
    # Given
    snapshot, payment = _fixtures()

    # When / Then
    assert matches_captured_sale_amount(snapshot, payment)


def test_dc_02_refuses_lower_payment_without_discount():
    # Given
    snapshot, payment = _fixtures()

    # When / Then
    assert not matches_captured_sale_amount(snapshot, replace(payment, sale_evidence=None))


def test_dc_02_refuses_different_provider_price():
    # Given
    snapshot, payment = _fixtures()
    assert payment.sale_evidence is not None

    # When / Then
    assert not matches_captured_sale_amount(
        snapshot,
        replace(payment, sale_evidence=replace(payment.sale_evidence, price_ref="price_other")),
    )
