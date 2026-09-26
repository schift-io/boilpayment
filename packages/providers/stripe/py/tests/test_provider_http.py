"""HTTP-calling StripeProvider methods, driven entirely through `_fake_http.install_http_mock`
(see tests/_fake_http.py) — the stripe-python SDK's internal default-http-client factory
(`stripe._stripe_client.new_default_http_client`) is monkeypatched for the duration of each test to
return a fake `HTTPClient` subclass whose `request_async` never opens a socket, just records the
call and returns a queued canned response. No real network call is made anywhere. Every assertion
checks the exact method/absolute-URL path/Authorization header/Idempotency-Key header/body the spec
(packages/providers/stripe/spec/stripe.pseudo.md "엔드포인트 매핑") requires.

pytest-asyncio is not installed in this environment: every test drives the async provider methods
via `asyncio.run(...)` inside an ordinary sync `def test_...():`.
"""

from __future__ import annotations

import asyncio
from urllib.parse import parse_qs

import pytest
from _fake_http import install_http_mock
from boilpayment_core import (
    CreateCheckoutInput,
    Money,
    PaymentKitError,
    Plan,
    PlanPrice,
)
from boilpayment_stripe import StripeProvider

SECRET_KEY = "sk_test_dummy_secret"


@pytest.fixture()
def mock():
    handle = install_http_mock()
    yield handle
    handle.restore()


def _provider() -> StripeProvider:
    return StripeProvider(
        secret_key=SECRET_KEY, webhook_secret="whsec_unused_in_these_tests"
    )


def _auth_header(req) -> str | None:
    return req.headers.get("Authorization")


def _plan() -> Plan:
    return Plan(
        id="plan_pro",
        name="Pro",
        interval="month",
        credits_per_period=1000,
        usage_included=0,
        trial_days=0,
        prices=[],
    )


def _price(provider_ref: str | None) -> PlanPrice:
    return PlanPrice(
        currency="KRW",
        amount_minor=9900,
        provider_price_refs={"stripe": provider_ref} if provider_ref else None,
    )


def _checkout_input(**overrides) -> CreateCheckoutInput:
    base = {
        "customer_ref": "cus_test_1",
        "plan": _plan(),
        "price": _price("price_stripe_pro_monthly"),
        "mode": "subscription",
        "success_url": "https://app.example.com/success",
        "cancel_url": "https://app.example.com/cancel",
        "idempotency_key": "checkout:cus_test_1:plan_pro:1700000000",
    }
    base.update(overrides)
    return CreateCheckoutInput(**base)


def _sub_fixture(**overrides) -> dict:
    base = {
        "id": "sub_1",
        "object": "subscription",
        "customer": "cus_1",
        "status": "active",
        "current_period_start": 1700000000,
        "current_period_end": 1702592000,
        "billing_cycle_anchor": 1700000000,
        "cancel_at_period_end": False,
        "created": 1700000000,
        "metadata": {},
        "items": {"data": [{"id": "si_1", "price": {"id": "price_old"}}]},
    }
    base.update(overrides)
    return base


# ---------------------------------------------------------------------------
# [EC:F(Stripe)] create_customer
# ---------------------------------------------------------------------------


def test_ec_f_stripe_create_customer_posts_with_bearer_auth_and_body(mock):
    mock.respond_json(
        200, {"id": "cus_new_1", "object": "customer", "email": "a@b.com"}
    )
    provider = _provider()

    result = asyncio.run(
        provider.create_customer(
            email="a@b.com", name="Alice", metadata={"source": "signup"}
        )
    )

    assert result == {"ref": "cus_new_1"}
    assert len(mock.requests) == 1
    req = mock.requests[0]
    assert req.method == "post"
    assert req.path == "/v1/customers"
    assert _auth_header(req) == f"Bearer {SECRET_KEY}"
    assert "email=a%40b.com" in req.post_data
    assert "name=Alice" in req.post_data
    assert "metadata[source]=signup" in req.post_data


# ---------------------------------------------------------------------------
# [EC:E6] create_checkout
# ---------------------------------------------------------------------------


def test_ec_e6_create_checkout_subscription_idempotency_key_and_body(mock):
    mock.respond_json(
        200,
        {
            "id": "cs_1",
            "object": "checkout.session",
            "url": "https://checkout.stripe.com/cs_1",
        },
    )
    provider = _provider()

    result = asyncio.run(
        provider.create_checkout(
            _checkout_input(metadata={"checkoutEntitlementKey": "intent_immutable"})
        )
    )

    assert result.id == "cs_1"
    assert result.url == "https://checkout.stripe.com/cs_1"
    assert result.provider_ref == "cs_1"
    req = mock.requests[0]
    assert req.method == "post"
    assert req.path == "/v1/checkout/sessions"
    assert (
        req.headers.get("Idempotency-Key") == "checkout:cus_test_1:plan_pro:1700000000"
    )
    assert "mode=subscription" in req.post_data
    assert "client_reference_id=cus_test_1" in req.post_data
    assert "&customer=cus_test_1&" in req.post_data
    assert "line_items[0][price]=price_stripe_pro_monthly" in req.post_data
    assert "line_items[0][quantity]=1" in req.post_data
    assert "metadata[planId]=plan_pro" in req.post_data
    assert "subscription_data[metadata][planId]=plan_pro" in req.post_data
    assert (
        "subscription_data[metadata][checkoutEntitlementKey]=intent_immutable"
        in req.post_data
    )


def test_ec_e6_create_checkout_one_time_mode_payment_no_subscription_data(mock):
    mock.respond_json(
        200,
        {
            "id": "cs_2",
            "object": "checkout.session",
            "url": "https://checkout.stripe.com/cs_2",
        },
    )
    provider = _provider()

    asyncio.run(
        provider.create_checkout(
            _checkout_input(
                mode="one_time", metadata={"checkoutEntitlementKey": "intent_immutable"}
            )
        )
    )

    req = mock.requests[0]
    assert "mode=payment" in req.post_data
    assert (
        "payment_intent_data[metadata][checkoutEntitlementKey]=intent_immutable"
        in req.post_data
    )
    assert "subscription_data" not in req.post_data


def test_ec_f_stripe_missing_provider_price_ref_raises_before_any_http_call(mock):
    provider = _provider()

    with pytest.raises(PaymentKitError) as excinfo:
        asyncio.run(provider.create_checkout(_checkout_input(price=_price(None))))

    assert excinfo.value.code == "missing_provider_price_ref"
    assert len(mock.requests) == 0


# ---------------------------------------------------------------------------
# [EC:E7] get_payment
# ---------------------------------------------------------------------------


def test_ec_e7_get_payment_pi_prefix_gets_with_expand_invoice(mock):
    mock.respond_json(
        200,
        {
            "id": "pi_1",
            "object": "payment_intent",
            "amount": 10000,
            "currency": "krw",
            "status": "succeeded",
            "created": 1700000000,
            "last_payment_error": None,
            "invoice": None,
        },
    )
    provider = _provider()

    payment = asyncio.run(provider.get_payment("pi_1"))

    assert payment.id == "pi_1"
    assert payment.status == "succeeded"
    assert payment.kind == "topup"
    req = mock.requests[0]
    assert req.method == "get"
    assert req.path == "/v1/payment_intents/pi_1"
    assert parse_qs(req.query) == {"expand[0]": ["invoice"], "expand[1]": ["latest_charge"]}  # EC:E23
    assert _auth_header(req) == f"Bearer {SECRET_KEY}"


def test_ec_f_stripe_get_payment_in_prefix_two_calls_no_expand_on_invoice(mock):
    mock.respond_json(
        200,
        {
            "id": "in_1",
            "object": "invoice",
            "subscription": "sub_1",
            "amount_paid": 5000,
            "amount_due": 5000,
            "currency": "krw",
            "status": "paid",
            "created": 1700000000,
            "payment_intent": "pi_from_invoice",
            "lines": {"data": []},
        },
    )
    mock.respond_json(
        200,
        {
            "id": "pi_from_invoice",
            "object": "payment_intent",
            "amount": 5000,
            "currency": "krw",
            "status": "succeeded",
            "created": 1700000000,
            "last_payment_error": None,
        },
    )
    provider = _provider()

    payment = asyncio.run(provider.get_payment("in_1"))

    assert payment.kind == "subscription"
    assert len(mock.requests) == 2
    assert mock.requests[0].method == "get"
    assert mock.requests[0].path == "/v1/invoices/in_1"
    assert mock.requests[0].query == ""  # no expand param
    assert mock.requests[1].method == "get"
    assert mock.requests[1].path == "/v1/payment_intents/pi_from_invoice"


def test_get_payment_in_prefix_no_payment_intent_only_one_call(mock):
    mock.respond_json(
        200,
        {
            "id": "in_2",
            "object": "invoice",
            "subscription": None,
            "amount_paid": 0,
            "amount_due": 5000,
            "currency": "krw",
            "status": "open",
            "created": 1700000000,
            "lines": {"data": []},
        },
    )
    provider = _provider()

    payment = asyncio.run(provider.get_payment("in_2"))

    assert payment.status == "pending"
    assert len(mock.requests) == 1


# ---------------------------------------------------------------------------
# [EC:H4 E1] list_payments
# ---------------------------------------------------------------------------


def test_ec_h4_e1_list_payments_dedups_invoice_covered_payment_intent(mock):
    import datetime

    since = datetime.datetime(2024, 1, 1, tzinfo=datetime.UTC)
    mock.respond_json(
        200,
        {
            "object": "list",
            "data": [
                {
                    "id": "in_1",
                    "subscription": "sub_1",
                    "amount_paid": 5000,
                    "amount_due": 5000,
                    "currency": "krw",
                    "status": "paid",
                    "created": 1700000000,
                    "payment_intent": "pi_covered",
                    "lines": {"data": []},
                }
            ],
        },
    )
    mock.respond_json(
        200,
        {
            "object": "list",
            "data": [
                {
                    "id": "pi_covered",
                    "amount": 5000,
                    "currency": "krw",
                    "status": "succeeded",
                    "created": 1700000000,
                    "last_payment_error": None,
                    "invoice": None,
                },
                {
                    "id": "pi_standalone",
                    "amount": 2000,
                    "currency": "krw",
                    "status": "succeeded",
                    "created": 1700000100,
                    "last_payment_error": None,
                    "invoice": None,
                },
            ],
        },
    )
    provider = _provider()

    payments = asyncio.run(provider.list_payments(customer_ref="cus_1", since=since))

    ids = [p.id for p in payments]
    assert "in_1" in ids
    assert "pi_standalone" in ids
    assert "pi_covered" not in ids
    assert len(payments) == 2

    gte = int(since.timestamp())
    assert mock.requests[0].method == "get"
    assert mock.requests[0].path == "/v1/invoices"
    assert parse_qs(mock.requests[0].query) == {
        "customer": ["cus_1"],
        "created[gte]": [str(gte)],
    }
    assert mock.requests[1].method == "get"
    assert mock.requests[1].path == "/v1/payment_intents"
    assert parse_qs(mock.requests[1].query) == {
        "customer": ["cus_1"],
        "created[gte]": [str(gte)],
    }


# ---------------------------------------------------------------------------
# [EC:E3] get_subscription
# ---------------------------------------------------------------------------


def test_ec_e3_get_subscription_gets_and_normalizes(mock):
    mock.respond_json(
        200,
        _sub_fixture(
            metadata={
                "customerId": "internal_cust_1",
                "planId": "plan_pro",
                "subscriptionId": "internal_sub_1",
            }
        ),
    )
    provider = _provider()

    sub = asyncio.run(provider.get_subscription("sub_1"))

    assert sub.id == "internal_sub_1"
    assert sub.status == "active"
    req = mock.requests[0]
    assert req.method == "get"
    assert req.path == "/v1/subscriptions/sub_1"


# ---------------------------------------------------------------------------
# [EC:A1] change_subscription — proration + billing_cycle_anchor reset
# ---------------------------------------------------------------------------


def test_ec_a1_immediate_prorate_reset_anchor(mock):
    mock.respond_json(200, _sub_fixture())
    mock.respond_json(200, _sub_fixture(billing_cycle_anchor=1700050000))
    provider = _provider()

    asyncio.run(
        provider.change_subscription(
            "sub_1", new_price_ref="price_new", proration="immediate", reset_anchor=True
        )
    )

    assert len(mock.requests) == 2
    assert mock.requests[0].method == "get"
    assert mock.requests[0].path == "/v1/subscriptions/sub_1"
    update_req = mock.requests[1]
    assert update_req.method == "post"
    assert update_req.path == "/v1/subscriptions/sub_1"
    assert "items[0][id]=si_1" in update_req.post_data
    assert "items[0][price]=price_new" in update_req.post_data
    assert "proration_behavior=create_prorations" in update_req.post_data
    assert "billing_cycle_anchor=now" in update_req.post_data


def test_ec_a1_keep_anchor_no_billing_cycle_anchor_key_sent(mock):
    mock.respond_json(200, _sub_fixture())
    mock.respond_json(200, _sub_fixture())
    provider = _provider()

    asyncio.run(
        provider.change_subscription(
            "sub_1", new_price_ref="price_new", proration="none", reset_anchor=False
        )
    )

    update_req = mock.requests[1]
    assert "proration_behavior=none" in update_req.post_data
    assert "billing_cycle_anchor" not in update_req.post_data


def test_change_subscription_uses_first_item_id_from_retrieve(mock):
    mock.respond_json(
        200,
        _sub_fixture(
            items={"data": [{"id": "si_specific_7", "price": {"id": "price_old"}}]}
        ),
    )
    mock.respond_json(200, _sub_fixture())
    provider = _provider()

    asyncio.run(
        provider.change_subscription(
            "sub_1", new_price_ref="price_new", proration="none", reset_anchor=False
        )
    )

    assert "items[0][id]=si_specific_7" in mock.requests[1].post_data


# ---------------------------------------------------------------------------
# [EC:A5] cancel_subscription
# ---------------------------------------------------------------------------


def test_ec_a5_cancel_at_period_end_true_posts_update(mock):
    mock.respond_json(200, _sub_fixture(cancel_at_period_end=True))
    provider = _provider()

    sub = asyncio.run(provider.cancel_subscription("sub_1", at_period_end=True))

    assert sub.cancel_at_period_end is True
    assert len(mock.requests) == 1
    assert mock.requests[0].method == "post"
    assert mock.requests[0].path == "/v1/subscriptions/sub_1"
    assert mock.requests[0].post_data == "cancel_at_period_end=true"


def test_ec_a5_cancel_at_period_end_false_deletes(mock):
    mock.respond_json(200, _sub_fixture(status="canceled"))
    provider = _provider()

    sub = asyncio.run(provider.cancel_subscription("sub_1", at_period_end=False))

    assert sub.status == "canceled"
    assert len(mock.requests) == 1
    assert mock.requests[0].method == "delete"
    assert mock.requests[0].path == "/v1/subscriptions/sub_1"


# ---------------------------------------------------------------------------
# [EC:A23] uncancel_subscription
# ---------------------------------------------------------------------------


def test_ec_a23_uncancel_pending_cancellation_gets_then_updates(mock):
    mock.respond_json(200, _sub_fixture(status="active", cancel_at_period_end=True))
    mock.respond_json(200, _sub_fixture(status="active", cancel_at_period_end=False))
    provider = _provider()

    sub = asyncio.run(provider.uncancel_subscription("sub_1"))

    assert sub.cancel_at_period_end is False
    assert len(mock.requests) == 2
    assert mock.requests[0].method == "get"
    assert mock.requests[0].path == "/v1/subscriptions/sub_1"
    assert mock.requests[1].method == "post"
    assert mock.requests[1].path == "/v1/subscriptions/sub_1"
    assert mock.requests[1].post_data == "cancel_at_period_end=false"


def test_ec_a23_uncancel_already_canceled_raises_not_reactivatable(mock):
    mock.respond_json(200, _sub_fixture(status="canceled"))
    provider = _provider()

    with pytest.raises(PaymentKitError) as exc_info:
        asyncio.run(provider.uncancel_subscription("sub_1"))

    assert exc_info.value.code == "not_reactivatable"
    # only the GET retrieve happened — no update was attempted on an already-dead subscription.
    assert len(mock.requests) == 1
    assert mock.requests[0].method == "get"


# ---------------------------------------------------------------------------
# charge_billing_key — unsupported for Stripe (native subscriptions)
# ---------------------------------------------------------------------------


def test_charge_billing_key_raises_unsupported_without_http_call(mock):
    provider = _provider()

    with pytest.raises(PaymentKitError) as excinfo:
        asyncio.run(
            provider.charge_billing_key(
                billing_key="bk_1",
                amount=Money(amount_minor=1000, currency="KRW"),
                order_id="o1",
                customer_ref="cus_1",
                idempotency_key="k1",
            )
        )

    assert excinfo.value.code == "unsupported"
    assert len(mock.requests) == 0


# ---------------------------------------------------------------------------
# [EC:D4 D6] refund
# ---------------------------------------------------------------------------


def test_ec_d4_d6_refund_pi_prefix_direct_post_with_idempotency_key(mock):
    mock.respond_json(
        200,
        {
            "id": "re_1",
            "object": "refund",
            "amount": 3000,
            "currency": "krw",
            "status": "succeeded",
            "created": 1700000000,
            "payment_intent": "pi_1",
            "reason": None,
        },
    )
    provider = _provider()

    refund = asyncio.run(
        provider.refund(
            payment_ref="pi_1",
            amount=Money(amount_minor=3000, currency="KRW"),
            reason="duplicate",
            idempotency_key="refund:pi_1:1",
        )
    )

    assert refund.id == "re_1"
    assert len(mock.requests) == 1
    req = mock.requests[0]
    assert req.method == "post"
    assert req.path == "/v1/refunds"
    assert req.headers.get("Idempotency-Key") == "refund:pi_1:1"
    assert "payment_intent=pi_1" in req.post_data
    assert "amount=3000" in req.post_data
    assert "reason=duplicate" in req.post_data


def test_ec_d4_refund_reason_mapping_fraudulent_passthrough_else_requested_by_customer(
    mock,
):
    mock.respond_json(
        200,
        {
            "id": "re_2",
            "object": "refund",
            "amount": 1000,
            "currency": "krw",
            "status": "succeeded",
            "created": 1700000000,
            "payment_intent": "pi_1",
            "reason": None,
        },
    )
    mock.respond_json(
        200,
        {
            "id": "re_3",
            "object": "refund",
            "amount": 1000,
            "currency": "krw",
            "status": "succeeded",
            "created": 1700000000,
            "payment_intent": "pi_1",
            "reason": None,
        },
    )
    provider = _provider()

    asyncio.run(
        provider.refund(
            payment_ref="pi_1",
            amount=Money(amount_minor=1000, currency="KRW"),
            reason="fraudulent",
            idempotency_key="k1",
        )
    )
    asyncio.run(
        provider.refund(
            payment_ref="pi_1",
            amount=Money(amount_minor=1000, currency="KRW"),
            reason="customer_changed_mind",
            idempotency_key="k2",
        )
    )

    assert "reason=fraudulent" in mock.requests[0].post_data
    assert "reason=requested_by_customer" in mock.requests[1].post_data


def test_ec_d4_refund_in_prefix_resolves_payment_intent_via_invoice_lookup(mock):
    mock.respond_json(
        200,
        {
            "id": "in_1",
            "object": "invoice",
            "customer": "cus_from_invoice",
            "subscription": "sub_1",
            "amount_paid": 5000,
            "amount_due": 5000,
            "currency": "krw",
            "status": "paid",
            "created": 1700000000,
            "payment_intent": "pi_resolved",
            "lines": {"data": []},
        },
    )
    mock.respond_json(
        200,
        {
            "id": "re_4",
            "object": "refund",
            "amount": 5000,
            "currency": "krw",
            "status": "succeeded",
            "created": 1700000000,
            "payment_intent": "pi_resolved",
            "reason": None,
        },
    )
    provider = _provider()

    refund = asyncio.run(
        provider.refund(
            payment_ref="in_1",
            amount=Money(amount_minor=5000, currency="KRW"),
            reason="requested_by_customer",
            idempotency_key="refund:in_1:1",
        )
    )

    assert refund.customer_id == "cus_from_invoice"
    assert len(mock.requests) == 2
    assert mock.requests[0].method == "get"
    assert mock.requests[0].path == "/v1/invoices/in_1"
    assert mock.requests[1].method == "post"
    assert mock.requests[1].path == "/v1/refunds"
    assert "payment_intent=pi_resolved" in mock.requests[1].post_data


def test_ec_d4_refund_in_prefix_invoice_without_payment_intent_raises_provider_shape(
    mock,
):
    mock.respond_json(
        200,
        {
            "id": "in_no_pi",
            "object": "invoice",
            "customer": "cus_1",
            "amount_paid": 0,
            "amount_due": 5000,
            "currency": "krw",
            "status": "open",
            "created": 1700000000,
            "lines": {"data": []},
        },
    )
    provider = _provider()

    with pytest.raises(PaymentKitError) as excinfo:
        asyncio.run(
            provider.refund(
                payment_ref="in_no_pi",
                amount=Money(amount_minor=5000, currency="KRW"),
                reason="requested_by_customer",
                idempotency_key="k",
            )
        )

    assert excinfo.value.code == "provider_shape"
    assert len(mock.requests) == 1  # only the invoice GET, no refund POST


# ---------------------------------------------------------------------------
# [EC:C4] report_usage — Billing Meter Events
# ---------------------------------------------------------------------------


def test_ec_c4_report_usage_posts_meter_event(mock):
    import datetime

    mock.respond_json(200, {"object": "billing.meter_event"})
    provider = _provider()
    occurred_at = datetime.datetime(2024, 1, 15, 12, 0, 0, tzinfo=datetime.UTC)

    asyncio.run(
        provider.report_usage(
            meter="api_calls",
            customer_ref="cus_1",
            quantity=42,
            occurred_at=occurred_at,
            idempotency_key="usage:evt:1",
        )
    )

    assert len(mock.requests) == 1
    req = mock.requests[0]
    assert req.method == "post"
    assert req.path == "/v1/billing/meter_events"
    assert "event_name=api_calls" in req.post_data
    assert "payload[stripe_customer_id]=cus_1" in req.post_data
    assert "payload[value]=42" in req.post_data
    assert "identifier=usage%3Aevt%3A1" in req.post_data
    assert f"timestamp={int(occurred_at.timestamp())}" in req.post_data


# ---------------------------------------------------------------------------
# capabilities()
# ---------------------------------------------------------------------------


def test_capabilities_matches_spec():
    provider = _provider()
    caps = provider.capabilities()
    assert caps.native_subscriptions is True
    assert caps.partial_refund is True
    assert caps.meters is True
    assert caps.scheduling == "provider"
    assert caps.webhook_signature is True


@pytest.mark.parametrize("mode", ["one_time", "subscription"])
def test_checkout_entitlement_survives_payment_retrieval(mock, mode):
    from urllib.parse import parse_qs

    mock.respond_json(
        200,
        {
            "id": "cs_entitlement",
            "object": "checkout.session",
            "url": "https://checkout.stripe.com/cs_entitlement",
        },
    )
    provider = _provider()
    asyncio.run(
        provider.create_checkout(
            _checkout_input(
                mode=mode, metadata={"checkoutEntitlementKey": "intent_captured"}
            )
        )
    )
    body = parse_qs(mock.requests[0].post_data)
    prefix = "payment_intent_data" if mode == "one_time" else "subscription_data"
    metadata = {
        "checkoutEntitlementKey": body[f"{prefix}[metadata][checkoutEntitlementKey]"][0]
    }
    assert metadata["checkoutEntitlementKey"] == "intent_captured"
    payment_ref = "pi_entitlement" if mode == "one_time" else "in_entitlement"
    response = {"id": payment_ref, "currency": "krw", "created": 1735689600}
    if mode == "one_time":
        response.update(
            {
                "object": "payment_intent",
                "amount": 9900,
                "status": "succeeded",
                "metadata": metadata,
            }
        )
    else:
        response.update(
            {
                "object": "invoice",
                "amount_paid": 9900,
                "amount_due": 9900,
                "status": "paid",
                "metadata": {},
                "parent": {
                    "type": "subscription_details",
                    "subscription_details": {
                        "subscription": "sub_entitlement",
                        "metadata": metadata,
                    },
                },
                "payments": {"data": []},
            }
        )
    mock.respond_json(200, response)
    payment = asyncio.run(provider.get_payment(payment_ref))
    raw = payment.raw.to_dict() if hasattr(payment.raw, "to_dict") else payment.raw
    assert raw["metadata"]["checkoutEntitlementKey"] == "intent_captured"
    assert payment.subscription_id == (
        "sub_entitlement" if mode == "subscription" else None
    )
