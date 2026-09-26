"""Phase 6 regression tests — HTTP-calling PaymentProvider methods, driven through a stubbed
httpx transport so NO real network call is made anywhere in this file.

Seam used: PolarProvider._request() (packages/providers/polar/py/src/boilpayment_polar/
__init__.py) builds a fresh `httpx.AsyncClient(base_url=..., timeout=30.0)` per call and has no
constructor-level client injection (unlike e.g. TossProvider, which does accept a client). Since
no DI seam is exposed, this file monkeypatches `httpx.AsyncClient` itself (as explicitly permitted
by the task brief as a fallback) to force every AsyncClient built by the provider onto an
httpx.MockTransport that answers from a queue of fixture httpx.Response objects and records every
httpx.Request for assertion. Mirrors ts/test/http.test.ts.

pytest-asyncio is NOT installed: async provider methods are driven via asyncio.run(...) inside
plain sync test functions.
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime

import httpx
import pytest
from boilpayment_core import (
    Money,
    PaymentKitError,
    Plan,
    PlanPrice,
    ProviderError,
)
from boilpayment_polar import PolarProvider


class _Recorder:
    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self._responses: list[httpx.Response] = []

    def queue(self, response: httpx.Response) -> None:
        self._responses.append(response)

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if not self._responses:
            raise AssertionError(
                f"no queued response for {request.method} {request.url.path}"
            )
        return self._responses.pop(0)

    @property
    def last(self) -> httpx.Request:
        return self.requests[-1]

    def body(self) -> dict:
        return json.loads(self.last.content)


@pytest.fixture
def recorder(monkeypatch: pytest.MonkeyPatch) -> _Recorder:
    rec = _Recorder()
    transport = httpx.MockTransport(rec.handler)
    real_async_client = httpx.AsyncClient

    def patched(*args, **kwargs):
        kwargs["transport"] = transport
        return real_async_client(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", patched)
    return rec


def json_response(body: object, status: int = 200) -> httpx.Response:
    return httpx.Response(status, json=body)


def provider() -> PolarProvider:
    return PolarProvider(
        access_token="polar_at_dummy", webhook_secret="whsec_c2VjcmV0", server="sandbox"
    )


class TestCreateCustomer:
    def test_ec_f_polar_post_customers_with_bearer_auth_and_body(self, recorder):
        recorder.queue(json_response({"id": "cust_abc"}))

        async def run():
            return await provider().create_customer(
                email="a@example.com", name="A", metadata={"foo": "bar"}
            )

        result = asyncio.run(run())
        assert result == {"ref": "cust_abc"}
        req = recorder.last
        assert req.method == "POST"
        assert str(req.url) == "https://sandbox-api.polar.sh/v1/customers/"
        assert req.headers["Authorization"] == "Bearer polar_at_dummy"
        assert req.headers["Content-Type"] == "application/json"
        assert recorder.body() == {
            "email": "a@example.com",
            "name": "A",
            "metadata": {"foo": "bar"},
        }


class TestCreateCheckout:
    def test_ec_e6_post_checkouts_custom_with_products_and_idempotency_header(
        self, recorder
    ):
        recorder.queue(
            json_response(
                {"id": "checkout_1", "url": "https://polar.sh/checkout/checkout_1"}
            )
        )
        price = PlanPrice(
            currency="usd",
            amount_minor=1000,
            provider_price_refs={"polar": "prod_polar_1"},
        )
        plan = Plan(
            id="plan_pro",
            name="Pro",
            interval="month",
            credits_per_period=1000,
            usage_included=0,
            trial_days=0,
            prices=[price],
        )
        from boilpayment_core import CreateCheckoutInput

        checkout_input = CreateCheckoutInput(
            customer_ref="cust_abc",
            plan=plan,
            price=price,
            mode="subscription",
            success_url="https://app.example.com/success",
            cancel_url="https://app.example.com/cancel",
            idempotency_key="checkout:cust_abc:plan_pro:0",
            metadata={"checkoutEntitlementKey": "intent_immutable", "extra": "1"},
        )

        async def run():
            return await provider().create_checkout(checkout_input)

        checkout = asyncio.run(run())
        assert checkout.id == "checkout_1"
        assert checkout.url == "https://polar.sh/checkout/checkout_1"
        assert checkout.provider_ref == "checkout_1"
        req = recorder.last
        assert req.method == "POST"
        assert str(req.url) == "https://sandbox-api.polar.sh/v1/checkouts/"
        assert req.headers["Idempotency-Key"] == "checkout:cust_abc:plan_pro:0"
        assert recorder.body() == {
            "products": ["prod_polar_1"],
            "customer_id": "cust_abc",
            "metadata": {
                "checkoutEntitlementKey": "intent_immutable",
                "extra": "1",
                "planId": "plan_pro",
            },
            "success_url": "https://app.example.com/success",
        }

    def test_ec_f_polar_missing_provider_price_ref_raises_without_network_call(
        self, recorder
    ):
        price = PlanPrice(currency="usd", amount_minor=1000)
        plan = Plan(
            id="plan_pro",
            name="Pro",
            interval="month",
            credits_per_period=1000,
            usage_included=0,
            trial_days=0,
            prices=[price],
        )
        from boilpayment_core import CreateCheckoutInput

        checkout_input = CreateCheckoutInput(
            customer_ref="cust_abc",
            plan=plan,
            price=price,
            mode="subscription",
            success_url="https://app.example.com/success",
            cancel_url="https://app.example.com/cancel",
            idempotency_key="k1",
        )

        async def run():
            await provider().create_checkout(checkout_input)

        with pytest.raises(PaymentKitError) as excinfo:
            asyncio.run(run())
        assert excinfo.value.code == "missing_provider_price_ref"
        assert recorder.requests == []


class TestGetPayment:
    def test_ec_e7_e12_get_orders_ref(self, recorder):
        recorder.queue(
            json_response(
                {
                    "id": "order_1",
                    "metadata": {"checkoutEntitlementKey": "intent_immutable"},
                    "customer_id": "cust_abc",
                    "total_amount": 1000,
                    "currency": "usd",
                    "status": "paid",
                    "paid": True,
                    "created_at": "2024-01-01T00:00:00+00:00",
                }
            )
        )

        async def run():
            return await provider().get_payment("order_1")

        payment = asyncio.run(run())
        assert payment.status == "succeeded"
        assert payment.provider_ref == "order_1"
        assert payment.raw["metadata"]["checkoutEntitlementKey"] == "intent_immutable"
        req = recorder.last
        assert req.method == "GET"
        assert str(req.url) == "https://sandbox-api.polar.sh/v1/orders/order_1"


class TestListPayments:
    def test_ec_h4_e1_get_orders_query_filters_by_since_client_side(self, recorder):
        recorder.queue(
            json_response(
                {
                    "items": [
                        {
                            "id": "order_old",
                            "customer_id": "cust_abc",
                            "total_amount": 100,
                            "currency": "usd",
                            "status": "paid",
                            "paid": True,
                            "created_at": "2023-01-01T00:00:00+00:00",
                        },
                        {
                            "id": "order_new",
                            "customer_id": "cust_abc",
                            "total_amount": 200,
                            "currency": "usd",
                            "status": "paid",
                            "paid": True,
                            "created_at": "2024-06-01T00:00:00+00:00",
                        },
                    ]
                }
            )
        )
        since = datetime(2024, 1, 1, tzinfo=UTC)

        async def run():
            return await provider().list_payments(customer_ref="cust_abc", since=since)

        payments = asyncio.run(run())
        assert [p.provider_ref for p in payments] == ["order_new"]
        req = recorder.last
        assert req.method == "GET"
        assert (
            str(req.url)
            == "https://sandbox-api.polar.sh/v1/orders/?customer_id=cust_abc&limit=100"
        )


class TestGetSubscription:
    def test_ec_e3_get_subscriptions_ref(self, recorder):
        recorder.queue(
            json_response(
                {
                    "id": "sub_1",
                    "customer_id": "cust_abc",
                    "status": "active",
                    "current_period_start": "2024-01-01T00:00:00+00:00",
                    "current_period_end": "2024-01-31T00:00:00+00:00",
                    "cancel_at_period_end": False,
                    "created_at": "2024-01-01T00:00:00+00:00",
                }
            )
        )

        async def run():
            return await provider().get_subscription("sub_1")

        sub = asyncio.run(run())
        assert sub.status == "active"
        req = recorder.last
        assert req.method == "GET"
        assert str(req.url) == "https://sandbox-api.polar.sh/v1/subscriptions/sub_1"


SUB_FIXTURE = {
    "id": "sub_1",
    "customer_id": "cust_abc",
    "status": "active",
    "current_period_start": "2024-01-01T00:00:00+00:00",
    "current_period_end": "2024-01-31T00:00:00+00:00",
    "cancel_at_period_end": False,
    "created_at": "2024-01-01T00:00:00+00:00",
}


class TestChangeSubscription:
    def test_ec_a1_proration_immediate_maps_to_prorate_and_ignores_reset_anchor(
        self, recorder
    ):
        recorder.queue(json_response(SUB_FIXTURE))

        async def run():
            return await provider().change_subscription(
                "sub_1",
                new_price_ref="prod_new",
                proration="immediate",
                reset_anchor=True,
            )

        asyncio.run(run())
        req = recorder.last
        assert req.method == "PATCH"
        assert str(req.url) == "https://sandbox-api.polar.sh/v1/subscriptions/sub_1"
        assert recorder.body() == {
            "product_id": "prod_new",
            "proration_behavior": "prorate",
        }

    def test_ec_a1_proration_none_maps_to_next_period(self, recorder):
        recorder.queue(json_response(SUB_FIXTURE))

        async def run():
            return await provider().change_subscription(
                "sub_1", new_price_ref="prod_new", proration="none", reset_anchor=False
            )

        asyncio.run(run())
        assert recorder.body() == {
            "product_id": "prod_new",
            "proration_behavior": "next_period",
        }


class TestCancelSubscription:
    def test_ec_a5_at_period_end_true_patches_cancel_flag(self, recorder):
        recorder.queue(json_response({**SUB_FIXTURE, "cancel_at_period_end": True}))

        async def run():
            return await provider().cancel_subscription("sub_1", at_period_end=True)

        asyncio.run(run())
        req = recorder.last
        assert req.method == "PATCH"
        assert str(req.url) == "https://sandbox-api.polar.sh/v1/subscriptions/sub_1"
        assert recorder.body() == {"cancel_at_period_end": True}

    def test_ec_a5_at_period_end_false_deletes_no_body(self, recorder):
        recorder.queue(json_response({**SUB_FIXTURE, "status": "canceled"}))

        async def run():
            return await provider().cancel_subscription("sub_1", at_period_end=False)

        asyncio.run(run())
        req = recorder.last
        assert req.method == "DELETE"
        assert str(req.url) == "https://sandbox-api.polar.sh/v1/subscriptions/sub_1"
        assert req.content in (b"", b"null")


class TestUncancelSubscription:
    def test_ec_a23_pending_cancellation_gets_then_patches_false(self, recorder):
        recorder.queue(json_response({**SUB_FIXTURE, "cancel_at_period_end": True}))
        recorder.queue(json_response({**SUB_FIXTURE, "cancel_at_period_end": False}))

        async def run():
            return await provider().uncancel_subscription("sub_1")

        sub = asyncio.run(run())
        assert sub.cancel_at_period_end is False
        assert len(recorder.requests) == 2
        assert recorder.requests[0].method == "GET"
        req = recorder.last
        assert req.method == "PATCH"
        assert str(req.url) == "https://sandbox-api.polar.sh/v1/subscriptions/sub_1"
        assert recorder.body() == {"cancel_at_period_end": False}

    def test_ec_a23_already_canceled_raises_not_reactivatable_no_patch(self, recorder):
        recorder.queue(json_response({**SUB_FIXTURE, "status": "canceled"}))

        async def run():
            return await provider().uncancel_subscription("sub_1")

        with pytest.raises(PaymentKitError) as exc_info:
            asyncio.run(run())
        assert exc_info.value.code == "not_reactivatable"
        assert len(recorder.requests) == 1
        assert recorder.requests[0].method == "GET"


class TestRefund:
    def test_ec_d4_d6_post_refunds_with_reason_passthrough_for_fraudulent(
        self, recorder
    ):
        recorder.queue(
            json_response(
                {
                    "id": "refund_1",
                    "order_id": "order_1",
                    "customer_id": "cust_abc",
                    "amount": 500,
                    "currency": "usd",
                    "status": "succeeded",
                    "reason": "fraudulent",
                    "created_at": "2024-01-01T00:00:00+00:00",
                }
            )
        )

        async def run():
            return await provider().refund(
                payment_ref="order_1",
                amount=Money(amount_minor=500, currency="USD"),
                reason="fraudulent",
                idempotency_key="refund:order_1",
            )

        refund = asyncio.run(run())
        assert refund.status == "succeeded"
        req = recorder.last
        assert req.method == "POST"
        assert str(req.url) == "https://sandbox-api.polar.sh/v1/refunds/"
        assert recorder.body() == {
            "order_id": "order_1",
            "amount": 500,
            "reason": "fraudulent",
        }

    def test_ec_d4_unrecognized_reason_falls_back_to_customer_request(self, recorder):
        recorder.queue(
            json_response(
                {
                    "id": "refund_2",
                    "order_id": "order_1",
                    "customer_id": "cust_abc",
                    "amount": 500,
                    "currency": "usd",
                    "status": "succeeded",
                    "reason": "customer_request",
                    "created_at": "2024-01-01T00:00:00+00:00",
                }
            )
        )

        async def run():
            return await provider().refund(
                payment_ref="order_1",
                amount=Money(amount_minor=500, currency="USD"),
                reason="requested_by_customer",
                idempotency_key="refund:order_1",
            )

        asyncio.run(run())
        assert recorder.body()["reason"] == "customer_request"


class TestReportUsage:
    def test_ec_c4_post_events_ingest_shape(self, recorder):
        recorder.queue(httpx.Response(204))
        occurred_at = datetime(2024, 1, 1, 12, 0, 0, tzinfo=UTC)

        async def run():
            await provider().report_usage(
                meter="api_calls",
                customer_ref="cust_abc",
                quantity=42,
                occurred_at=occurred_at,
                idempotency_key="usage:cust_abc:2024-01-01",
            )

        asyncio.run(run())
        req = recorder.last
        assert req.method == "POST"
        assert str(req.url) == "https://sandbox-api.polar.sh/v1/events/ingest"
        assert recorder.body() == {
            "events": [
                {
                    "name": "api_calls",
                    "customer_id": "cust_abc",
                    "timestamp": occurred_at.isoformat(),
                    "external_id": "usage:cust_abc:2024-01-01",
                    "metadata": {"value": 42},
                }
            ]
        }


class TestErrorHandling:
    def test_ec_e12_non_2xx_raises_provider_error_with_normalized_failure(
        self, recorder
    ):
        recorder.queue(httpx.Response(403, text="insufficient permissions"))

        async def run():
            await provider().get_payment("order_x")

        with pytest.raises(ProviderError) as excinfo:
            asyncio.run(run())
        assert excinfo.value.failure.code == "unknown"
        assert excinfo.value.failure.retryable is True


class TestChargeBillingKey:
    def test_ec_f_polar_unsupported_no_network_call(self, recorder):
        async def run():
            await provider().charge_billing_key(
                billing_key="bk_1",
                amount=Money(amount_minor=1000, currency="USD"),
                order_id="order_1",
                customer_ref="cust_abc",
                idempotency_key="k1",
            )

        with pytest.raises(PaymentKitError) as excinfo:
            asyncio.run(run())
        assert excinfo.value.code == "unsupported"
        assert recorder.requests == []
