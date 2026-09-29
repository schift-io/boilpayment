"""Phase 6 regression tests — pure normalizers. Fixtures mirror py/examples/smoke.py and
spec/polar.pseudo.md (status/failure mapping tables, webhook event mapping table). Mirrors
ts/test/normalizers.test.ts field-for-field (camelCase <-> snake_case only).
"""

from __future__ import annotations

import pytest
from boilpayment_polar import (
    map_event_type,
    normalize_failure,
    normalize_order,
    normalize_refund,
    normalize_subscription,
    to_normalized_event,
)


class TestNormalizeFailure:
    def test_ec_e12_always_unknown_retryable_no_provider_code(self):
        f = normalize_failure(message="card processing error")
        assert f.code == "unknown"
        assert f.provider_code is None
        assert f.retryable is True
        assert f.user_message == "card processing error"

    def test_ec_e12_default_korean_message_when_absent(self):
        f = normalize_failure()
        assert f.user_message == "결제 처리 중 오류가 발생했습니다. 다시 시도해 주세요."

    def test_ec_e12_none_message_falls_back_to_default(self):
        f = normalize_failure(message=None)
        assert f.user_message == "결제 처리 중 오류가 발생했습니다. 다시 시도해 주세요."


BASE_ORDER = {
    "id": "order_test_2",
    "customer_id": "cust_test_1",
    "total_amount": 1000,
    "currency": "usd",
    "created_at": "2024-01-01T00:00:00+00:00",
}


class TestNormalizeOrder:
    def test_ec_e7_status_paid_paid_true_succeeded(self):
        p = normalize_order({**BASE_ORDER, "status": "paid", "paid": True})
        assert p.status == "succeeded"

    def test_ec_e7_paid_true_without_status_succeeded(self):
        p = normalize_order({**BASE_ORDER, "paid": True})
        assert p.status == "succeeded"

    def test_ec_d6_status_refunded(self):
        assert (
            normalize_order({**BASE_ORDER, "status": "refunded"}).status == "refunded"
        )

    def test_ec_d6_status_partially_refunded(self):
        assert (
            normalize_order({**BASE_ORDER, "status": "partially_refunded"}).status
            == "partially_refunded"
        )

    def test_ec_e12_status_void_failed(self):
        assert normalize_order({**BASE_ORDER, "status": "void"}).status == "failed"

    def test_ec_e7_e13_unrecognized_or_absent_status_pending(self):
        assert (
            normalize_order({**BASE_ORDER, "status": "unknown_status"}).status
            == "pending"
        )
        assert normalize_order(BASE_ORDER).status == "pending"

    def test_ec_f_polar_kind_subscription_vs_topup(self):
        assert (
            normalize_order(
                {
                    **BASE_ORDER,
                    "status": "paid",
                    "paid": True,
                    "subscription_id": "sub_test_1",
                }
            ).kind
            == "subscription"
        )
        assert (
            normalize_order({**BASE_ORDER, "status": "paid", "paid": True}).kind
            == "topup"
        )

    def test_ec_d6_amount_currency_no_conversion_and_fallback_chain(self):
        p = normalize_order(
            {
                **BASE_ORDER,
                "status": "paid",
                "paid": True,
                "currency": "krw",
                "total_amount": 5000,
            }
        )
        assert p.amount.amount_minor == 5000
        assert p.amount.currency == "KRW"
        p2 = normalize_order(
            {
                **BASE_ORDER,
                "status": "paid",
                "paid": True,
                "total_amount": None,
                "net_amount": 700,
            }
        )
        assert p2.amount.amount_minor == 700

    def test_ec_f_polar_provider_and_ref_and_subscription_id_passthrough(self):
        p = normalize_order(
            {
                **BASE_ORDER,
                "status": "paid",
                "paid": True,
                "subscription_id": "sub_test_1",
            }
        )
        assert p.provider == "polar"
        assert p.provider_ref == "order_test_2"
        assert p.subscription_id == "sub_test_1"

    def test_dc_02_pl_01_af_01_authoritative_discount_link_and_affiliate_evidence(
        self,
    ):
        p = normalize_order(
            {
                **BASE_ORDER,
                "status": "paid",
                "paid": True,
                "subtotal_amount": 1000,
                "discount_amount": 200,
                "net_amount": 800,
                "total_amount": 800,
                "product_id": "prod_polar_1",
                "checkout_id": "checkout_1",
                "checkout_link_id": "link_1",
                "discount_id": "discount_20pct",
                "discount": {
                    "id": "discount_20pct",
                    "type": "percentage",
                    "basis_points": 2000,
                },
                "metadata": {
                    "reference_id": "customer_42",
                    "affiliateId": "affiliate_alpha",
                },
            }
        )

        assert p.amount.amount_minor == 800
        assert p.affiliate_id == "affiliate_alpha"
        assert p.sale_evidence is not None
        assert p.sale_evidence.provider_subtotal.amount_minor == 1000
        assert p.sale_evidence.discount_amount.amount_minor == 200
        assert p.sale_evidence.price_ref == "prod_polar_1"
        assert p.sale_evidence.checkout_id == "checkout_1"
        assert p.sale_evidence.payment_link_id == "link_1"
        assert p.sale_evidence.link_reference == "customer_42"

    def test_dc_02_records_zero_discount_evidence_without_discount(self):
        p = normalize_order(
            {
                **BASE_ORDER,
                "status": "paid",
                "paid": True,
                "subtotal_amount": 1000,
                "discount_amount": 0,
                "product_id": "prod_polar_1",
            }
        )

        assert p.sale_evidence is not None
        assert p.sale_evidence.discount_amount.amount_minor == 0


BASE_SUB = {
    "id": "sub_test_1",
    "customer_id": "cust_test_1",
    "current_period_start": "2024-01-01T00:00:00+00:00",
    "current_period_end": "2024-01-31T00:00:00+00:00",
    "cancel_at_period_end": False,
    "created_at": "2024-01-01T00:00:00+00:00",
}

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


class TestNormalizeSubscription:
    @pytest.mark.parametrize("raw,expected", SUB_STATUS_TABLE)
    def test_ec_f_polar_status_mapping(self, raw, expected):
        assert normalize_subscription({**BASE_SUB, "status": raw}).status == expected

    def test_ec_f_polar_unrecognized_status_falls_back_to_expired(self):
        assert (
            normalize_subscription({**BASE_SUB, "status": "some_future_status"}).status
            == "expired"
        )

    def test_ec_f_polar_id_customer_id_plan_id_from_metadata_per_contract_note(self):
        with_meta = normalize_subscription(
            {
                **BASE_SUB,
                "status": "active",
                "metadata": {
                    "customerId": "internal_cust_1",
                    "planId": "plan_pro",
                    "subscriptionId": "internal_sub_1",
                    "affiliateId": "affiliate_alpha",
                },
            }
        )
        assert with_meta.id == "internal_sub_1"
        assert with_meta.customer_id == "internal_cust_1"
        assert with_meta.plan_id == "plan_pro"
        assert with_meta.affiliate_id == "affiliate_alpha"

        without_meta = normalize_subscription({**BASE_SUB, "status": "active"})
        assert without_meta.id == "sub_test_1"
        assert without_meta.customer_id == "cust_test_1"
        assert without_meta.plan_id == ""

    def test_ec_a1_anchor_day_derives_from_current_period_start(self):
        s = normalize_subscription(
            {
                **BASE_SUB,
                "status": "active",
                "current_period_start": "2024-03-15T00:00:00+00:00",
            }
        )
        assert s.anchor_day == 15

    def test_ec_a5_cancel_at_period_end_passthrough(self):
        assert (
            normalize_subscription(
                {**BASE_SUB, "status": "active", "cancel_at_period_end": True}
            ).cancel_at_period_end
            is True
        )
        assert (
            normalize_subscription(
                {**BASE_SUB, "status": "active", "cancel_at_period_end": False}
            ).cancel_at_period_end
            is False
        )


BASE_REFUND = {
    "id": "refund_test_1",
    "order_id": "order_test_1",
    "customer_id": "cust_test_1",
    "amount": 2000,
    "currency": "krw",
    "reason": "customer_request",
    "created_at": "2024-01-01T00:00:00+00:00",
}


class TestNormalizeRefund:
    def test_ec_d4_status_succeeded(self):
        assert (
            normalize_refund({**BASE_REFUND, "status": "succeeded"}, "D4").status
            == "succeeded"
        )

    def test_ec_d4_status_failed_populates_failure(self):
        r = normalize_refund({**BASE_REFUND, "status": "failed"}, "D4")
        assert r.status == "failed"
        assert r.failure is not None
        assert r.failure.code == "unknown"
        assert r.failure.retryable is True

    def test_ec_d4_status_canceled_maps_to_failed(self):
        assert (
            normalize_refund({**BASE_REFUND, "status": "canceled"}, "D4").status
            == "failed"
        )

    def test_ec_d4_other_status_pending_no_failure(self):
        r = normalize_refund({**BASE_REFUND, "status": "pending"}, "D4")
        assert r.status == "pending"
        assert r.failure is None

    def test_ec_d6_amount_currency_passthrough_and_rule_id(self):
        r = normalize_refund({**BASE_REFUND, "status": "succeeded"}, "D4")
        assert r.amount.amount_minor == 2000
        assert r.amount.currency == "KRW"
        assert r.rule_id == "D4"
        assert r.payment_id == "order_test_1"
        assert r.provider_ref == "refund_test_1"


EVENT_TYPE_TABLE = [
    ("order.paid", "payment.succeeded"),
    ("order.created", "payment.pending"),
    ("order.refunded", "unknown"),
    ("refund.created", "refund.pending"),
    ("refund.updated", "refund.pending"),
    ("subscription.created", "subscription.created"),
    ("subscription.updated", "subscription.updated"),
    ("subscription.active", "subscription.updated"),
    ("subscription.uncanceled", "subscription.updated"),
    ("subscription.canceled", "subscription.canceled"),
    ("subscription.revoked", "subscription.canceled"),
    ("subscription.past_due", "subscription.payment_failed"),
]


class TestMapEventType:
    @pytest.mark.parametrize("raw,expected", EVENT_TYPE_TABLE)
    def test_ec_f_polar_webhook_event_mapping_table(self, raw, expected):
        assert map_event_type(raw) == expected

    def test_ec_f_polar_benefits_and_other_events_fall_back_to_unknown(self):
        assert map_event_type("benefit.created") == "unknown"
        assert map_event_type("benefit_grant.created") == "unknown"
        assert map_event_type("checkout.created") == "unknown"
        assert map_event_type("customer.updated") == "unknown"
        assert map_event_type("product.updated") == "unknown"


class TestToNormalizedEvent:
    def test_ec_f_polar_order_paid_field_extraction(self):
        ev = to_normalized_event(
            {
                "type": "order.paid",
                "timestamp": "2024-01-01T00:00:00+00:00",
                "data": {
                    "id": "order_test_1",
                    "customer_id": "cust_test_1",
                    "subscription_id": "sub_test_1",
                    "total_amount": 5000,
                    "currency": "krw",
                },
            }
        )
        assert ev.type == "payment.succeeded"
        assert ev.payment_ref == "order_test_1"
        assert ev.subscription_ref == "sub_test_1"
        assert ev.customer_ref == "cust_test_1"
        assert ev.amount.amount_minor == 5000
        assert ev.amount.currency == "KRW"
        assert ev.provider == "polar"
        assert ev.id == "order.paid:order_test_1"

    def test_ec_f_polar_subscription_past_due_no_payment_ref_or_amount(self):
        ev = to_normalized_event(
            {
                "type": "subscription.past_due",
                "timestamp": "2024-01-01T00:00:00+00:00",
                "data": {"id": "sub_test_2", "customer_id": "cust_test_2"},
            }
        )
        assert ev.type == "subscription.payment_failed"
        assert ev.subscription_ref == "sub_test_2"
        assert ev.customer_ref == "cust_test_2"
        assert ev.payment_ref is None
        assert ev.amount is None

    def test_ec_d4_refund_created_payment_ref_from_order_id_not_id(self):
        ev = to_normalized_event(
            {
                "type": "refund.created",
                "timestamp": "2024-01-01T00:00:00+00:00",
                "data": {
                    "id": "refund_1",
                    "status": "succeeded",
                    "order_id": "order_test_1",
                    "customer_id": "cust_test_1",
                    "amount": 2000,
                    "currency": "krw",
                },
            }
        )
        assert ev.type == "refund.created"
        assert ev.payment_ref == "order_test_1"
        assert ev.amount.amount_minor == 2000
        assert ev.amount.currency == "KRW"

    def test_ec_f_polar_raw_preserved_verbatim(self):
        parsed = {
            "type": "order.created",
            "timestamp": "2024-01-01T00:00:00+00:00",
            "data": {"id": "order_x"},
        }
        ev = to_normalized_event(parsed)
        assert ev.raw == parsed
