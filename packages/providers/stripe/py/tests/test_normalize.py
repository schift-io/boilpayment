"""Pure normalizer tests — no network, no StripeProvider instance. Fixtures are modeled on real
Stripe webhook/object shapes (mirroring py/examples/smoke.py) and checked against
packages/providers/stripe/spec/stripe.pseudo.md. No pytest-asyncio in this environment: every
function under test here is synchronous, so plain `def test_...():` is used throughout.
"""

from __future__ import annotations

import pytest
from _obj import _Obj
from boilpayment_core import PaymentKitError
from boilpayment_stripe import (
    invoice_payment_intent_ref,
    map_event_type,
    normalize_failure,
    normalize_invoice_as_payment,
    normalize_payment_intent,
    normalize_refund,
    normalize_subscription,
    to_normalized_event,
)

NOW = 1_700_000_000


# ---------------------------------------------------------------------------
# [EC:E12] normalize_failure
# ---------------------------------------------------------------------------

FAILURE_TABLE = [
    ("insufficient_funds", "insufficient_funds", True),
    ("card_declined", "card_declined", False),
    ("expired_card", "expired_card", False),
    ("processing_error", "processing_error", True),
    ("incorrect_cvc", "incorrect_cvc", True),
    ("incorrect_number", "incorrect_number", True),
    ("authentication_required", "authentication_required", True),
    ("lost_card", "lost_card", False),
    ("stolen_card", "stolen_card", False),
    ("api_connection_error", "provider_unavailable", True),
    ("api_error", "provider_unavailable", True),
    ("rate_limit_error", "provider_unavailable", True),
]


def test_ec_e12_failure_map_table():
    for decline_code, expected_code, expected_retryable in FAILURE_TABLE:
        result = normalize_failure(decline_code=decline_code)
        assert result.code == expected_code, decline_code
        assert result.retryable is expected_retryable, decline_code
        assert result.provider_code == decline_code


def test_ec_e12_unmapped_code_falls_back_to_unknown():
    result = normalize_failure(code="some_weird_code", message="weird")
    assert result.code == "unknown"
    assert result.provider_code == "some_weird_code"
    assert result.retryable is False
    assert result.user_message == "weird"


def test_ec_e12_unmapped_code_default_korean_message_when_no_message():
    result = normalize_failure(code="totally_unknown")
    assert result.code == "unknown"
    assert result.user_message == "결제 중 알 수 없는 오류가 발생했습니다."


def test_ec_e12_decline_code_takes_precedence_over_code():
    result = normalize_failure(code="card_error", decline_code="insufficient_funds")
    assert result.code == "insufficient_funds"
    assert result.provider_code == "insufficient_funds"


def test_ec_e12_no_code_no_decline_code_is_unknown_with_none_provider_code():
    result = normalize_failure(message="nothing to go on")
    assert result.code == "unknown"
    assert result.provider_code is None


# ---------------------------------------------------------------------------
# [EC:E7] normalize_payment_intent — PaymentIntent.status -> PaymentStatus
# ---------------------------------------------------------------------------


def _pi(status: str, **extra):
    data = {
        "id": "pi_test_1",
        "amount": 10000,
        "currency": "krw",
        "status": status,
        "created": NOW,
        "last_payment_error": None,
        "invoice": None,
    }
    data.update(extra)
    return _Obj(data)


def test_ec_e7_status_succeeded():
    assert normalize_payment_intent(_pi("succeeded")).status == "succeeded"


def test_ec_e7_requires_action_variants():
    for status in (
        "requires_action",
        "requires_confirmation",
        "requires_payment_method",
    ):
        assert normalize_payment_intent(_pi(status)).status == "requires_action", status


def test_ec_e7_processing_and_requires_capture_are_pending():
    for status in ("processing", "requires_capture"):
        assert normalize_payment_intent(_pi(status)).status == "pending", status


def test_ec_e7_canceled_is_failed():
    assert normalize_payment_intent(_pi("canceled")).status == "failed"


def test_ec_e7_unknown_status_defaults_to_pending():
    assert normalize_payment_intent(_pi("some_future_status")).status == "pending"


def test_ec_f_stripe_kind_topup_vs_subscription():
    topup = normalize_payment_intent(_pi("succeeded"), invoice=None)
    assert topup.kind == "topup"
    assert topup.subscription_id is None
    assert topup.period is None

    invoice = _Obj(
        {
            "id": "in_1",
            "subscription": "sub_test_1",
            "lines": {"data": [{"period": {"start": NOW, "end": NOW + 2592000}}]},
        }
    )
    with_invoice = normalize_payment_intent(_pi("succeeded"), invoice=invoice)
    assert with_invoice.kind == "subscription"
    assert with_invoice.subscription_id == "sub_test_1"
    assert with_invoice.period is not None
    assert with_invoice.period.start.timestamp() == NOW
    assert with_invoice.period.end.timestamp() == NOW + 2592000


def test_ec_e12_failure_populated_from_last_payment_error():
    pi = _pi(
        "requires_payment_method",
        last_payment_error={
            "code": "card_declined",
            "decline_code": "insufficient_funds",
            "message": "declined",
        },
    )
    result = normalize_payment_intent(pi)
    assert result.failure is not None
    assert result.failure.code == "insufficient_funds"
    assert result.failure.retryable is True


def test_ec_d6_amount_is_1to1_currency_uppercased():
    result = normalize_payment_intent(_pi("succeeded"))
    assert result.amount.amount_minor == 10000
    assert result.amount.currency == "KRW"


# ---------------------------------------------------------------------------
# [EC:F(Stripe)] normalize_invoice_as_payment
# ---------------------------------------------------------------------------


def _invoice(status, **extra):
    data = {
        "id": "in_test_1",
        "subscription": "sub_test_1",
        "amount_paid": 5000,
        "amount_due": 5000,
        "currency": "krw",
        "status": status,
        "created": NOW,
        "lines": {"data": [{"period": {"start": NOW, "end": NOW + 2592000}}]},
    }
    data.update(extra)
    return _Obj(data)


def test_ec_f_stripe_invoice_status_paid_succeeded_kind_always_subscription():
    result = normalize_invoice_as_payment(_invoice("paid"))
    assert result.status == "succeeded"
    assert result.kind == "subscription"
    assert result.subscription_id == "sub_test_1"


def test_ec_f_stripe_invoice_status_open_draft_pending():
    for status in ("open", "draft"):
        assert normalize_invoice_as_payment(_invoice(status)).status == "pending", (
            status
        )


def test_ec_f_stripe_invoice_status_uncollectible_void_failed():
    for status in ("uncollectible", "void"):
        assert normalize_invoice_as_payment(_invoice(status)).status == "failed", status


def test_ec_f_stripe_invoice_status_none_defaults_to_pending():
    assert normalize_invoice_as_payment(_invoice(None)).status == "pending"


def test_ec_e7_e12_invoice_failure_only_when_open_and_pi_supplied():
    pi = _Obj({"last_payment_error": {"code": "expired_card"}})
    open_with_pi = normalize_invoice_as_payment(_invoice("open"), pi=pi)
    assert open_with_pi.failure is not None
    assert open_with_pi.failure.code == "expired_card"

    paid_with_pi = normalize_invoice_as_payment(_invoice("paid"), pi=pi)
    assert paid_with_pi.failure is None

    open_no_pi = normalize_invoice_as_payment(_invoice("open"), pi=None)
    assert open_no_pi.failure is None


def test_ec_f_stripe_invoice_amount_falls_back_to_amount_due():
    result = normalize_invoice_as_payment(
        _invoice("open", amount_paid=0, amount_due=7000)
    )
    assert result.amount.amount_minor == 7000
    assert result.amount.currency == "KRW"


def test_dc_05_af_04_invoice_records_discount_evidence_and_affiliate():
    result = normalize_invoice_as_payment(
        _invoice(
            "paid",
            amount_paid=8000,
            subtotal=10000,
            total=8000,
            total_discount_amounts=[{"amount": 2000, "discount": "di_1"}],
            discounts=["di_1"],
            metadata={"affiliateId": "affiliate_7"},
            lines={"data": [{"price": {"id": "price_pro"}, "period": {"start": NOW, "end": NOW + 2592000}}]},
        )
    )

    assert result.amount.amount_minor == 8000
    assert result.affiliate_id == "affiliate_7"
    assert result.sale_evidence is not None
    assert result.sale_evidence.provider_subtotal.amount_minor == 10000
    assert result.sale_evidence.discount_amount.amount_minor == 2000
    assert result.sale_evidence.price_ref == "price_pro"


# ---------------------------------------------------------------------------
# [EC:F(Stripe)] normalize_subscription
# ---------------------------------------------------------------------------


def _sub(**extra):
    data = {
        "id": "sub_test_1",
        "customer": "cus_test_1",
        "status": "active",
        "current_period_start": NOW,
        "current_period_end": NOW + 2592000,
        "billing_cycle_anchor": NOW,
        "cancel_at_period_end": False,
        "created": NOW,
        "metadata": {},
    }
    data.update(extra)
    return _Obj(data)


SUB_STATUS_TABLE = [
    ("trialing", "trialing"),
    ("active", "active"),
    ("past_due", "past_due"),
    ("canceled", "canceled"),
    ("unpaid", "expired"),
    ("incomplete", "incomplete"),  # EC:A27
    ("incomplete_expired", "expired"),
    ("paused", "paused"),  # EC:A27
]


def test_ec_f_stripe_subscription_status_table():
    for stripe_status, expected in SUB_STATUS_TABLE:
        result = normalize_subscription(_sub(status=stripe_status))
        assert result.status == expected, stripe_status


def test_ec_a28_stripe_subscription_currency_carried():
    assert normalize_subscription(_sub(currency="krw")).currency == "KRW"
    assert normalize_subscription(_sub()).currency is None


def test_ec_f_stripe_subscription_unmapped_status_defaults_to_expired():
    assert normalize_subscription(_sub(status="some_future_status")).status == "expired"


def test_contract_note_metadata_populates_id_customer_id_plan_id():
    result = normalize_subscription(
        _sub(
            metadata={
                "customerId": "internal_cust_1",
                "planId": "plan_pro",
                "subscriptionId": "internal_sub_1",
            }
        )
    )
    assert result.id == "internal_sub_1"
    assert result.customer_id == "internal_cust_1"
    assert result.plan_id == "plan_pro"


def test_contract_note_missing_metadata_falls_back_to_provider_ids():
    result = normalize_subscription(_sub(metadata={}))
    assert result.id == "sub_test_1"
    assert result.customer_id == "cus_test_1"
    assert result.plan_id == ""


def test_ec_g1_anchor_day_is_utc_day_of_month():
    import datetime

    jan15 = int(
        datetime.datetime(2024, 1, 15, 3, 0, 0, tzinfo=datetime.UTC).timestamp()
    )
    result = normalize_subscription(_sub(billing_cycle_anchor=jan15))
    assert result.anchor_day == 15


def test_normalize_subscription_surfaces_cancel_at_period_end_and_provider_ref():
    result = normalize_subscription(_sub(cancel_at_period_end=True))
    assert result.cancel_at_period_end is True
    assert result.provider_ref == "sub_test_1"
    assert result.provider == "stripe"


def test_normalize_subscription_reads_period_from_items_when_absent_on_subscription(
    monkeypatch=None,
):
    sub = _Obj(
        {
            "id": "sub_basil_1",
            "customer": "cus_1",
            "status": "active",
            "billing_cycle_anchor": NOW,
            "cancel_at_period_end": False,
            "created": NOW,
            "metadata": {},
            "items": {
                "data": [
                    {"current_period_start": NOW, "current_period_end": NOW + 2592000}
                ]
            },
        }
    )
    result = normalize_subscription(sub)
    assert result.current_period.start.timestamp() == NOW
    assert result.current_period.end.timestamp() == NOW + 2592000


def test_ec_f_stripe_subscription_raises_provider_shape_when_no_current_period_anywhere():
    sub = _Obj(
        {
            "id": "sub_no_period",
            "customer": "cus_1",
            "status": "active",
            "billing_cycle_anchor": NOW,
            "cancel_at_period_end": False,
            "created": NOW,
            "metadata": {},
            "items": {"data": [{}]},
        }
    )
    with pytest.raises(PaymentKitError) as excinfo:
        normalize_subscription(sub)
    assert excinfo.value.code == "provider_shape"


def test_ec_f_stripe_subscription_raises_provider_shape_when_items_data_empty():
    sub = _Obj(
        {
            "id": "sub_no_items",
            "customer": "cus_1",
            "status": "active",
            "billing_cycle_anchor": NOW,
            "cancel_at_period_end": False,
            "created": NOW,
            "metadata": {},
            "items": {"data": []},
        }
    )
    with pytest.raises(PaymentKitError) as excinfo:
        normalize_subscription(sub)
    assert excinfo.value.code == "provider_shape"


# ---------------------------------------------------------------------------
# [EC:D4 D6] normalize_refund
# ---------------------------------------------------------------------------


def _refund(status, **extra):
    data = {
        "id": "re_test_1",
        "payment_intent": "pi_test_1",
        "amount": 3000,
        "currency": "krw",
        "status": status,
        "created": NOW,
        "reason": None,
        "failure_reason": None,
    }
    data.update(extra)
    return _Obj(data)


def test_ec_d4_d6_refund_status_succeeded():
    assert normalize_refund(_refund("succeeded"), "cust_1", "D4").status == "succeeded"


def test_ec_d4_d6_refund_status_failed_canceled():
    for status in ("failed", "canceled"):
        assert normalize_refund(_refund(status), "cust_1", "D4").status == "failed", (
            status
        )


def test_ec_d4_d6_refund_status_unknown_defaults_to_pending():
    assert normalize_refund(_refund("pending"), "cust_1", "D4").status == "pending"


def test_ec_d6_refund_amount_passthrough_and_reason_passthrough():
    result = normalize_refund(
        _refund("succeeded", reason="requested_by_customer"), "cust_1", "D4"
    )
    assert result.amount.amount_minor == 3000
    assert result.amount.currency == "KRW"
    assert result.reason == "requested_by_customer"
    assert result.rule_id == "D4"
    assert result.payment_id == "pi_test_1"
    assert result.credits_revoked == 0


def test_ec_d4_d6_refund_failure_only_when_status_failed():
    failed = normalize_refund(
        _refund("failed", failure_reason="expired_or_canceled_card"), "cust_1", "D4"
    )
    assert failed.failure is not None
    succeeded = normalize_refund(_refund("succeeded"), "cust_1", "D4")
    assert succeeded.failure is None


# ---------------------------------------------------------------------------
# invoice_payment_intent_ref
# ---------------------------------------------------------------------------


def test_invoice_payment_intent_ref_legacy_string():
    invoice = _Obj({"payment_intent": "pi_legacy_1"})
    assert invoice_payment_intent_ref(invoice) == "pi_legacy_1"


def test_invoice_payment_intent_ref_legacy_object():
    invoice = _Obj({"payment_intent": {"id": "pi_legacy_2"}})
    assert invoice_payment_intent_ref(invoice) == "pi_legacy_2"


def test_invoice_payment_intent_ref_basil_string_form():
    invoice = _Obj(
        {"payments": {"data": [{"payment": {"payment_intent": "pi_basil_1"}}]}}
    )
    assert invoice_payment_intent_ref(invoice) == "pi_basil_1"


def test_invoice_payment_intent_ref_basil_object_form():
    invoice = _Obj(
        {"payments": {"data": [{"payment": {"payment_intent": {"id": "pi_basil_2"}}}]}}
    )
    assert invoice_payment_intent_ref(invoice) == "pi_basil_2"


def test_invoice_payment_intent_ref_none_when_absent():
    invoice = _Obj({})
    assert invoice_payment_intent_ref(invoice) is None


# ---------------------------------------------------------------------------
# [EC:F(Stripe)] map_event_type — full webhook event mapping table
# ---------------------------------------------------------------------------


def _evt(event_type: str, obj: dict | None = None) -> dict:
    return {
        "id": "evt_1",
        "type": event_type,
        "created": NOW,
        "data": {"object": obj or {}},
    }


def test_map_event_type_invoice_paid():
    assert map_event_type(_evt("invoice.paid")) == "payment.succeeded"


def test_map_event_type_invoice_payment_failed():
    assert (
        map_event_type(_evt("invoice.payment_failed")) == "subscription.payment_failed"
    )


def test_map_event_type_checkout_completed_mode_payment():
    assert (
        map_event_type(_evt("checkout.session.completed", {"mode": "payment"}))
        == "payment.succeeded"
    )


def test_map_event_type_checkout_completed_mode_subscription():
    assert (
        map_event_type(_evt("checkout.session.completed", {"mode": "subscription"}))
        == "subscription.created"
    )


def test_ec_e3_payment_intent_succeeded_without_invoice():
    assert (
        map_event_type(_evt("payment_intent.succeeded", {"invoice": None}))
        == "payment.succeeded"
    )


def test_ec_e3_payment_intent_succeeded_with_invoice_is_unknown():
    assert (
        map_event_type(_evt("payment_intent.succeeded", {"invoice": "in_1"}))
        == "unknown"
    )


def test_map_event_type_payment_intent_payment_failed():
    assert map_event_type(_evt("payment_intent.payment_failed")) == "payment.failed"


def test_map_event_type_subscription_created():
    assert (
        map_event_type(_evt("customer.subscription.created")) == "subscription.created"
    )


def test_map_event_type_subscription_updated():
    assert (
        map_event_type(_evt("customer.subscription.updated")) == "subscription.updated"
    )


def test_map_event_type_subscription_deleted():
    assert (
        map_event_type(_evt("customer.subscription.deleted")) == "subscription.canceled"
    )


def test_map_event_type_charge_refunded():
    assert map_event_type(_evt("charge.refunded")) == "unknown"


def test_map_event_type_dispute_created():
    assert map_event_type(_evt("charge.dispute.created")) == "dispute.opened"


def test_map_event_type_dispute_closed():
    assert map_event_type(_evt("charge.dispute.closed")) == "dispute.closed"


def test_map_event_type_unhandled_is_unknown():
    assert map_event_type(_evt("customer.created")) == "unknown"


# ---------------------------------------------------------------------------
# [EC:F(Stripe)] to_normalized_event — field extraction per event type
# ---------------------------------------------------------------------------


def test_to_normalized_event_invoice_paid_fields():
    event = _evt(
        "invoice.paid",
        {
            "id": "in_1",
            "customer": "cus_1",
            "subscription": "sub_1",
            "amount_paid": 5000,
            "amount_due": 5000,
            "currency": "krw",
        },
    )
    result = to_normalized_event(event)
    assert result.type == "payment.succeeded"
    assert result.payment_ref == "in_1"
    assert result.subscription_ref == "sub_1"
    assert result.customer_ref == "cus_1"
    assert result.amount.amount_minor == 5000
    assert result.amount.currency == "KRW"


def test_to_normalized_event_checkout_customer_ref_falls_back_to_client_reference_id():
    event = _evt(
        "checkout.session.completed",
        {
            "id": "cs_1",
            "mode": "payment",
            "customer": None,
            "client_reference_id": "internal_cust_9",
            "payment_intent": "pi_1",
            "amount_total": 4200,
            "currency": "usd",
        },
    )
    result = to_normalized_event(event)
    assert result.customer_ref == "internal_cust_9"
    assert result.payment_ref == "cs_1"
    assert result.amount.amount_minor == 4200
    assert result.amount.currency == "USD"
    assert result.type == "payment.succeeded"


def test_pl_01_payment_link_event_uses_encoded_reference_and_checkout_id():
    event = _evt(
        "checkout.session.completed",
        {
            "id": "cs_link",
            "mode": "payment",
            "customer": "cus_stripe",
            "client_reference_id": "encoded_customer",
            "payment_intent": "pi_link",
            "payment_link": "plink_1",
            "amount_total": 4200,
            "currency": "usd",
        },
    )

    result = to_normalized_event(event)

    assert result.customer_ref == "encoded_customer"
    assert result.payment_ref == "cs_link"


def test_to_normalized_event_checkout_subscription_mode():
    event = _evt(
        "checkout.session.completed",
        {
            "id": "cs_2",
            "mode": "subscription",
            "customer": "cus_2",
            "subscription": "sub_2",
        },
    )
    result = to_normalized_event(event)
    assert result.subscription_ref == "sub_2"
    assert result.type == "subscription.created"


def test_pl_02_subscription_payment_link_is_payment_success():
    event = _evt(
        "checkout.session.completed",
        {
            "id": "cs_link_sub",
            "mode": "subscription",
            "customer": "cus_2",
            "subscription": "sub_2",
            "payment_link": "plink_2",
            "client_reference_id": "encoded_customer",
        },
    )

    result = to_normalized_event(event)

    assert result.type == "payment.succeeded"
    assert result.payment_ref == "cs_link_sub"
    assert result.subscription_ref == "sub_2"
    assert result.customer_ref == "encoded_customer"


def test_to_normalized_event_payment_intent_failed_fields():
    event = _evt(
        "payment_intent.payment_failed",
        {"id": "pi_1", "customer": "cus_1", "amount": 1000, "currency": "krw"},
    )
    result = to_normalized_event(event)
    assert result.payment_ref == "pi_1"
    assert result.customer_ref == "cus_1"
    assert result.type == "payment.failed"


def test_to_normalized_event_subscription_updated_fields():
    event = _evt("customer.subscription.updated", {"id": "sub_1", "customer": "cus_1"})
    result = to_normalized_event(event)
    assert result.subscription_ref == "sub_1"
    assert result.customer_ref == "cus_1"
    assert result.type == "subscription.updated"


def test_to_normalized_event_subscription_deleted_type():
    event = _evt("customer.subscription.deleted", {"id": "sub_1", "customer": "cus_1"})
    assert to_normalized_event(event).type == "subscription.canceled"


def test_ec_d4_to_normalized_event_charge_refunded_fields():
    event = _evt(
        "charge.refunded",
        {
            "payment_intent": "pi_1",
            "customer": "cus_1",
            "amount_refunded": 2000,
            "currency": "krw",
        },
    )
    result = to_normalized_event(event)
    assert result.type == "unknown"
    assert result.refund_ref is None
    assert result.payment_ref == "pi_1"
    assert result.amount.amount_minor == 2000
    assert result.amount.currency == "KRW"


def test_to_normalized_event_dispute_created_fields_from_smoke_fixture():
    # fixture mirrors py/examples/smoke.py's dispute fixture verbatim
    event = {
        "id": "evt_test_dispute",
        "type": "charge.dispute.created",
        "created": NOW,
        "data": {
            "object": {"payment_intent": "pi_test_2", "amount": 3000, "currency": "krw"}
        },
    }
    result = to_normalized_event(event)
    assert result.type == "dispute.opened"
    assert result.payment_ref == "pi_test_2"
    assert result.amount.amount_minor == 3000
    assert result.amount.currency == "KRW"


def test_to_normalized_event_dispute_closed_type():
    event = _evt(
        "charge.dispute.closed",
        {"payment_intent": "pi_1", "amount": 3000, "currency": "krw", "status": "lost"},
    )
    assert to_normalized_event(event).type == "dispute.closed"


def test_ec_d21_dispute_closed_carries_the_verdict_from_dispute_status():
    def closed(status: str):  # type: ignore[no-untyped-def]
        return to_normalized_event(_evt("charge.dispute.closed", {"payment_intent": "pi_1", "amount": 3000, "currency": "krw", "status": status}))

    assert closed("won").dispute_outcome == "won"
    assert closed("lost").dispute_outcome == "lost"
    assert closed("warning_closed").dispute_outcome is None
    opened = to_normalized_event(_evt("charge.dispute.created", {"payment_intent": "pi_1", "amount": 3000, "currency": "krw", "status": "needs_response"}))
    assert opened.dispute_outcome is None


def test_to_normalized_event_unhandled_type_all_refs_none():
    event = _evt("customer.created", {"id": "cus_1"})
    result = to_normalized_event(event)
    assert result.type == "unknown"
    assert result.customer_ref is None
    assert result.subscription_ref is None
    assert result.payment_ref is None
    assert result.amount is None
    assert result.raw is event


def test_subscription_checkout_identity_from_invoice_snapshot():
    metadata = {"checkoutEntitlementKey": "intent_immutable", "planId": "captured_plan"}
    for shape in [
        {"subscription": "sub_test_1", "subscription_details": {"metadata": metadata}},
        {
            "subscription": None,
            "parent": {
                "type": "subscription_details",
                "subscription_details": {
                    "subscription": "sub_test_1",
                    "metadata": metadata,
                },
            },
        },
    ]:
        original = _invoice("paid", metadata={}, **shape)
        normalized = normalize_invoice_as_payment(original)
        assert normalized.subscription_id == "sub_test_1"
        assert normalized.raw["metadata"] == metadata
        assert original.metadata.to_dict() == {}


def test_ec_e23_refunded_charge_is_not_succeeded():
    def ch(**kw):
        base = {"id": "ch_1", "amount_captured": 10000, "amount_refunded": 0, "refunded": False, "disputed": False}
        base.update(kw)
        return _Obj(base)

    assert normalize_payment_intent(_pi("succeeded", latest_charge=ch(amount_refunded=10000, refunded=True))).status == "refunded"
    assert normalize_payment_intent(_pi("succeeded", latest_charge=ch(amount_refunded=2500))).status == "partially_refunded"
    assert normalize_payment_intent(_pi("succeeded", latest_charge=ch(disputed=True))).status == "disputed"
    assert normalize_payment_intent(_pi("succeeded", latest_charge=ch())).status == "succeeded"
    assert normalize_payment_intent(_pi("succeeded", latest_charge="ch_1")).status == "succeeded"
