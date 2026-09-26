"""Phase 6 regression tests for TossProvider (Python). No network calls — every
HTTP-calling method is driven through an httpx.MockTransport. Fixtures are taken
from examples/smoke.py (docs.tosspayments.com example response shapes) plus the
status/failure/webhook mapping tables in spec/toss.pseudo.md.

pytest-asyncio is not installed in this environment: every test is a plain
``def test_...():`` that drives async code via ``asyncio.run(...)``.
"""

from __future__ import annotations

import asyncio
import base64
import json

import httpx
import pytest
from schift_payment_kit_core import (
    CreateCheckoutInput,
    Money,
    Plan,
    PlanPrice,
    ProviderError,
    WebhookSignatureError,
)
from schift_payment_kit_toss import (
    TossProvider,
    TossProviderConfig,
    map_toss_webhook,
    normalize_toss_cash_receipt,
    normalize_toss_failure,
    normalize_toss_payment,
    normalize_toss_status,
)

# ── shared fixtures (mirrors ts/test/toss.test.ts and examples/smoke.py) ─────

WEBHOOK_FIXTURE = {
    "eventType": "PAYMENT_STATUS_CHANGED",
    "createdAt": "2022-05-12T00:00:00.000",
    "data": {
        "paymentKey": "B3EvL1cKz9p-kO6XPNpfF",
        "status": "DONE",
        "orderId": "YOWWcpZSDCZ8WJC5x7mkl",
    },
}

PAYMENT_FIXTURE_DONE = {
    "paymentKey": "B3EvL1cKz9p-kO6XPNpfF",
    "orderId": "YOWWcpZSDCZ8WJC5x7mkl",
    "status": "DONE",
    "totalAmount": 15000,
    "currency": "KRW",
    "method": "카드",
    "approvedAt": "2022-05-12T00:00:05+09:00",
    "requestedAt": "2022-05-12T00:00:00+09:00",
}

PAYMENT_FIXTURE_ABORTED = {
    "paymentKey": "ABORTED_KEY",
    "orderId": "ord_aborted",
    "status": "ABORTED",
    "totalAmount": 5000,
    "currency": "KRW",
    "method": "카드",
    "requestedAt": "2022-05-12T00:10:00+09:00",
    "failure": {
        "code": "REJECT_CARD_COMPANY",
        "message": "카드사에서 승인을 거절했습니다.",
    },
}

PAYMENT_FIXTURE_VA = {
    "paymentKey": "VA_KEY",
    "orderId": "ord_va",
    "status": "PARTIAL_CANCELED",
    "totalAmount": 20000,
    "currency": "KRW",
    "method": "가상계좌",
    "approvedAt": "2022-05-12T00:00:00+09:00",
    "cancels": [
        {
            "transactionKey": "txn_1",
            "cancelAmount": 5000,
            "canceledAt": "2022-05-13T00:00:00+09:00",
        }
    ],
}

# EC:H4 — /v1/transactions rows are TransactionDto, NOT Payment: field names differ
# (`amount`/`transactionAt` vs `totalAmount`/`approvedAt`). Shape per
# docs.tosspayments.com/reference#거래-조회.
TRANSACTION_FIXTURE_DONE = {
    "mId": "tosspayments_test",
    "transactionKey": "txn_9F8fPFGA3fyprBrpqNyC1",
    "paymentKey": "B3EvL1cKz9p-kO6XPNpfF",
    "orderId": "YOWWcpZSDCZ8WJC5x7mkl",
    "method": "카드",
    "customerKey": "cus_abc",
    "useEscrow": False,
    "status": "DONE",
    "transactionAt": "2022-05-12T00:00:05+09:00",
    "currency": "KRW",
    "amount": 15000,
    "receiptUrl": "https://dashboard.tosspayments.com/receipt/txn_9F8fPFGA3fyprBrpqNyC1",
}

TRANSACTION_FIXTURE_OTHER_CUSTOMER = {
    "mId": "tosspayments_test",
    "transactionKey": "txn_other",
    "paymentKey": "ABORTED_KEY",
    "orderId": "ord_aborted",
    "method": "카드",
    "customerKey": "cus_other",
    "useEscrow": False,
    "status": "ABORTED",
    "transactionAt": "2022-05-12T00:10:00+09:00",
    "currency": "KRW",
    "amount": 5000,
    "receiptUrl": "https://dashboard.tosspayments.com/receipt/txn_other",
}

PAYMENT_FIXTURE_WAITING = {
    "paymentKey": "WAIT_KEY",
    "orderId": "ord_wait",
    "status": "WAITING_FOR_DEPOSIT",
    "totalAmount": 10000,
    "currency": "KRW",
    "method": "가상계좌",
    "requestedAt": "2022-05-12T00:00:00+09:00",
}

EXPECTED_AUTH = "Basic " + base64.b64encode(b"sk_test:").decode("ascii")

PLAN = Plan(
    id="plan_1",
    name="Pro",
    interval="month",
    credits_per_period=1000,
    usage_included=0,
    trial_days=0,
    prices=[],
)
PRICE = PlanPrice(currency="KRW", amount_minor=15000)


def make_provider(handler, *, allowed_webhook_ips=None) -> TossProvider:
    """Build a TossProvider backed by an httpx.MockTransport instead of the network."""
    client = httpx.AsyncClient(
        base_url="https://api.tosspayments.com", transport=httpx.MockTransport(handler)
    )
    return TossProvider(
        TossProviderConfig(
            secret_key="sk_test", allowed_webhook_ips=allowed_webhook_ips
        ),
        client,
    )


def unreachable_transport(request: httpx.Request) -> httpx.Response:
    raise AssertionError(
        f"should not fetch, but got {request.method} {request.url.path}"
    )


def recording_transport(routes: dict[str, httpx.Response]):
    """routes keyed by 'METHOD /path' (query string stripped). Records every request."""
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        key = f"{request.method} {request.url.path}"
        resp = routes.get(key)
        if resp is None:
            raise AssertionError(f"unhandled route {key}")
        return resp

    return handler, calls


def json_response(body, status_code: int = 200) -> httpx.Response:
    return httpx.Response(status_code, json=body)


# ── (a) pure normalizers ─────────────────────────────────────────────────────


class TestNormalizeTossStatus:
    def test_ec_e8_waiting_for_deposit_maps_to_pending(self):
        assert normalize_toss_status("WAITING_FOR_DEPOSIT") == "pending"

    def test_ec_e8_ready_and_in_progress_map_to_pending(self):
        assert normalize_toss_status("READY") == "pending"
        assert normalize_toss_status("IN_PROGRESS") == "pending"

    def test_ec_e8_done_maps_to_succeeded(self):
        assert normalize_toss_status("DONE") == "succeeded"

    def test_ec_d4_canceled_and_partial_canceled(self):
        assert normalize_toss_status("CANCELED") == "refunded"
        assert normalize_toss_status("PARTIAL_CANCELED") == "partially_refunded"

    def test_ec_e8_aborted_and_expired_map_to_failed(self):
        assert normalize_toss_status("ABORTED") == "failed"
        assert normalize_toss_status("EXPIRED") == "failed"


class TestNormalizeTossFailure:
    def test_ec_e9_known_failure_code_maps_with_retryable_flag(self):
        f = normalize_toss_failure(
            {
                "code": "REJECT_CARD_COMPANY",
                "message": "카드사에서 승인을 거절했습니다.",
            }
        )
        assert f.code == "card_declined"
        assert f.provider_code == "REJECT_CARD_COMPANY"
        assert f.retryable is True
        assert f.user_message == "카드사에서 승인을 거절했습니다."

    def test_ec_e9_expired_card_not_retryable(self):
        f = normalize_toss_failure({"code": "EXPIRED_CARD", "message": "expired"})
        assert f.code == "expired_card"
        assert f.retryable is False

    def test_ec_e9_unmapped_code_falls_back_to_unknown(self):
        f = normalize_toss_failure({"code": "SOME_NEW_TOSS_CODE", "message": "huh"})
        assert f.code == "unknown"
        assert f.provider_code == "SOME_NEW_TOSS_CODE"
        assert f.retryable is False

    def test_ec_e9_returns_none_when_no_failure(self):
        assert normalize_toss_failure(None) is None
        assert normalize_toss_failure({}) is None


class TestNormalizeTossPayment:
    def test_ec_e8_done_payment_normalizes_to_succeeded_no_failure(self):
        p = normalize_toss_payment(PAYMENT_FIXTURE_DONE)
        assert p.status == "succeeded"
        assert p.id == "B3EvL1cKz9p-kO6XPNpfF"
        assert p.amount.amount_minor == 15000
        assert p.amount.currency == "KRW"
        assert p.failure is None

    def test_ec_e9_aborted_payment_normalizes_to_failed_with_failure(self):
        p = normalize_toss_payment(PAYMENT_FIXTURE_ABORTED)
        assert p.status == "failed"
        assert p.failure.code == "card_declined"
        assert p.failure.provider_code == "REJECT_CARD_COMPANY"
        assert p.failure.retryable is True


# ── (b) verify_webhook — IP allowlist (EC:E4, Toss has no crypto signature) ─


class TestVerifyWebhookIpAllowlist:
    def test_ec_e4_allowed_ip_passes_and_returns_mapped_event(self):
        provider = make_provider(
            unreachable_transport, allowed_webhook_ips=["203.0.113.10"]
        )
        raw_body = json.dumps(WEBHOOK_FIXTURE)

        async def run():
            return await provider.verify_webhook(
                headers={"x-paykit-remote-ip": "203.0.113.10"}, raw_body=raw_body
            )

        event = asyncio.run(run())
        assert event.type == "payment.succeeded"
        assert event.payment_ref == "B3EvL1cKz9p-kO6XPNpfF"

    def test_ec_e4_disallowed_ip_raises_webhook_signature_error(self):
        provider = make_provider(
            unreachable_transport, allowed_webhook_ips=["203.0.113.10"]
        )
        raw_body = json.dumps(WEBHOOK_FIXTURE)

        async def run():
            await provider.verify_webhook(
                headers={"x-paykit-remote-ip": "198.51.100.1"}, raw_body=raw_body
            )

        with pytest.raises(WebhookSignatureError):
            asyncio.run(run())

    def test_ec_e4_missing_ip_header_raises_when_allowlist_configured(self):
        provider = make_provider(
            unreachable_transport, allowed_webhook_ips=["203.0.113.10"]
        )
        raw_body = json.dumps(WEBHOOK_FIXTURE)

        async def run():
            await provider.verify_webhook(headers={}, raw_body=raw_body)

        with pytest.raises(WebhookSignatureError):
            asyncio.run(run())

    def test_ec_e4_no_allowlist_configured_skips_ip_check(self):
        provider = make_provider(unreachable_transport, allowed_webhook_ips=None)
        raw_body = json.dumps(WEBHOOK_FIXTURE)

        async def run():
            return await provider.verify_webhook(headers={}, raw_body=raw_body)

        event = asyncio.run(run())
        assert event.type == "payment.succeeded"


class TestMapTossWebhook:
    def test_ec_e3_payment_status_changed_done_maps_to_payment_succeeded(self):
        assert map_toss_webhook(WEBHOOK_FIXTURE).type == "payment.succeeded"

    def test_ec_d4_payment_status_changed_canceled_maps_to_refund_created(self):
        body = {
            "eventType": "PAYMENT_STATUS_CHANGED",
            "createdAt": "2022-05-12T00:00:00.000",
            "data": {"paymentKey": "k", "status": "CANCELED"},
        }
        assert map_toss_webhook(body).type == "refund.created"

    def test_ec_d4_payment_status_changed_partial_canceled_maps_to_refund_created(self):
        body = {
            "eventType": "PAYMENT_STATUS_CHANGED",
            "createdAt": "2022-05-12T00:00:00.000",
            "data": {"paymentKey": "k", "status": "PARTIAL_CANCELED"},
        }
        assert map_toss_webhook(body).type == "refund.created"

    def test_ec_e8_waiting_for_deposit_maps_to_payment_pending(self):
        body = {
            "eventType": "PAYMENT_STATUS_CHANGED",
            "createdAt": "2022-05-12T00:00:00.000",
            "data": {"paymentKey": "k", "status": "WAITING_FOR_DEPOSIT"},
        }
        assert map_toss_webhook(body).type == "payment.pending"

    def test_ec_e8_expired_and_aborted_map_to_payment_failed(self):
        expired = {
            "eventType": "PAYMENT_STATUS_CHANGED",
            "createdAt": "2022-05-12T00:00:00.000",
            "data": {"paymentKey": "k", "status": "EXPIRED"},
        }
        aborted = {
            "eventType": "PAYMENT_STATUS_CHANGED",
            "createdAt": "2022-05-12T00:00:00.000",
            "data": {"paymentKey": "k", "status": "ABORTED"},
        }
        assert map_toss_webhook(expired).type == "payment.failed"
        assert map_toss_webhook(aborted).type == "payment.failed"

    def test_ec_d4_cancel_status_changed_without_completion_stays_pending(
        self,
    ):
        body = {
            "eventType": "CANCEL_STATUS_CHANGED",
            "createdAt": "2022-05-12T00:00:00.000",
            "data": {"paymentKey": "k"},
        }
        assert map_toss_webhook(body).type == "refund.pending"

    def test_ec_f_billing_deleted_maps_to_subscription_canceled(self):
        body = {
            "eventType": "BILLING_DELETED",
            "createdAt": "2022-05-12T00:00:00.000",
            "data": {},
        }
        assert map_toss_webhook(body).type == "subscription.canceled"

    def test_ec_e3_unrecognized_event_type_maps_to_unknown(self):
        body = {
            "eventType": "SOMETHING_ELSE",
            "createdAt": "2022-05-12T00:00:00.000",
            "data": {},
        }
        assert map_toss_webhook(body).type == "unknown"

    def test_ec_e3_synthesized_id_is_stable_across_identical_retries(self):
        e1 = map_toss_webhook(WEBHOOK_FIXTURE)
        e2 = map_toss_webhook(dict(WEBHOOK_FIXTURE))
        assert e1.id == e2.id
        assert (
            e1.id
            == "PAYMENT_STATUS_CHANGED:B3EvL1cKz9p-kO6XPNpfF:DONE:2022-05-12T00:00:00.000"
        )

    def test_ec_e3_deposit_callback_done_maps_to_payment_succeeded(self):
        body = {
            "eventType": "DEPOSIT_CALLBACK",
            "createdAt": "2022-05-12T00:00:00.000",
            "data": {"paymentKey": "k", "status": "DONE"},
        }
        assert map_toss_webhook(body).type == "payment.succeeded"


# ── (c) HTTP-calling methods via httpx.MockTransport ─────────────────────────


class TestConfirmPayment:
    def test_ec_e13_posts_to_confirm_with_basic_auth_and_exact_body_no_idempotency_header(
        self,
    ):
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.method == "POST"
            assert request.url.path == "/v1/payments/confirm"
            assert request.headers["authorization"] == EXPECTED_AUTH
            assert "idempotency-key" not in request.headers
            assert json.loads(request.content) == {
                "paymentKey": "B3EvL1cKz9p-kO6XPNpfF",
                "orderId": "YOWWcpZSDCZ8WJC5x7mkl",
                "amount": 15000,
            }
            return json_response(PAYMENT_FIXTURE_DONE)

        provider = make_provider(handler)

        async def run():
            return await provider.confirm_payment(
                payment_key="B3EvL1cKz9p-kO6XPNpfF",
                order_id="YOWWcpZSDCZ8WJC5x7mkl",
                amount=15000,
            )

        payment = asyncio.run(run())
        assert payment.status == "succeeded"

    def test_ec_e13_e6_e10_amount_sent_verbatim_no_client_side_short_circuit(self):
        # Per spec/toss.pseudo.md: Toss's server compares the confirm amount against
        # the amount recorded when the checkout widget opened, and rejects on mismatch
        # (EC:E6/E10 defense line). TossProvider does not itself validate amount —
        # it must forward whatever the caller supplies, verbatim, and let a rejection
        # from Toss propagate as an error rather than being silently absorbed.
        seen = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["body"] = json.loads(request.content)
            return json_response(
                {"message": "요청 금액과 실제 결제 금액이 일치하지 않습니다."}, 400
            )

        provider = make_provider(handler)

        async def run():
            await provider.confirm_payment(
                payment_key="B3EvL1cKz9p-kO6XPNpfF",
                order_id="YOWWcpZSDCZ8WJC5x7mkl",
                amount=999,
            )

        with pytest.raises(ProviderError):
            asyncio.run(run())
        assert seen["body"]["amount"] == 999


class TestChargeBillingKey:
    def test_ec_f_posts_to_billing_key_with_idempotency_header_and_exact_body(self):
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.method == "POST"
            assert request.url.path == "/v1/billing/bk_123"
            assert request.headers["authorization"] == EXPECTED_AUTH
            assert (
                request.headers["idempotency-key"]
                == "charge:sub_1:2026-09-01T00:00:00.000Z"
            )
            assert json.loads(request.content) == {
                "customerKey": "cus_abc",
                "amount": 15000,
                "orderId": "charge:sub_1:2026-09-01T00:00:00.000Z",
                "orderName": "Subscription charge",
            }
            return json_response(PAYMENT_FIXTURE_DONE)

        provider = make_provider(handler)

        async def run():
            return await provider.charge_billing_key(
                billing_key="bk_123",
                amount=Money(amount_minor=15000, currency="KRW"),
                order_id="charge:sub_1:2026-09-01T00:00:00.000Z",
                customer_ref="cus_abc",
                idempotency_key="charge:sub_1:2026-09-01T00:00:00.000Z",
            )

        payment = asyncio.run(run())
        assert payment.status == "succeeded"

    def test_ec_f_provider_error_response_raises_provider_error_with_normalized_failure(
        self,
    ):
        def handler(request: httpx.Request) -> httpx.Response:
            return json_response(
                {"code": "NOT_ENOUGH_BALANCE", "message": "잔액이 부족합니다."}, 400
            )

        provider = make_provider(handler)

        async def run():
            await provider.charge_billing_key(
                billing_key="bk_fail",
                amount=Money(amount_minor=1000, currency="KRW"),
                order_id="o1",
                customer_ref="c1",
                idempotency_key="k1",
            )

        with pytest.raises(ProviderError) as exc_info:
            asyncio.run(run())
        failure = exc_info.value.failure
        assert failure.code == "insufficient_funds"
        assert failure.retryable is True
        assert failure.provider_code == "NOT_ENOUGH_BALANCE"


class TestRefund:
    def test_ec_d13_virtual_account_refund_without_refund_receive_account_raises(self):
        handler, calls = recording_transport(
            {"GET /v1/payments/VA_KEY": json_response(PAYMENT_FIXTURE_VA)}
        )
        provider = make_provider(handler)

        async def run():
            await provider.refund(
                payment_ref="VA_KEY",
                amount=Money(amount_minor=5000, currency="KRW"),
                reason="customer request",
                idempotency_key="revoke:1",
            )

        with pytest.raises(Exception) as exc_info:
            asyncio.run(run())
        assert (
            getattr(exc_info.value, "code", None) == "refund_receive_account_required"
        )
        # only the GET happened — the cancel POST must never have been attempted.
        assert len(calls) == 1

    def test_ec_d13_d4_refund_with_refund_receive_account_posts_cancel_amount_and_account(
        self,
    ):
        handler, calls = recording_transport(
            {
                "GET /v1/payments/VA_KEY": json_response(PAYMENT_FIXTURE_VA),
                "POST /v1/payments/VA_KEY/cancel": json_response(PAYMENT_FIXTURE_VA),
            }
        )
        provider = make_provider(handler)
        refund_receive_account = {
            "bank": "004",
            "accountNumber": "123456789",
            "holderName": "홍길동",
        }

        async def run():
            return await provider.refund(
                payment_ref="VA_KEY",
                amount=Money(amount_minor=5000, currency="KRW"),
                reason="customer request",
                idempotency_key="revoke:2",
                extra={"refundReceiveAccount": refund_receive_account},
            )

        refund = asyncio.run(run())
        assert refund.amount.amount_minor == 5000
        assert len(calls) == 2
        assert calls[0].method == "GET"
        cancel_call = calls[1]
        assert cancel_call.method == "POST"
        assert cancel_call.url.path == "/v1/payments/VA_KEY/cancel"
        assert cancel_call.headers["idempotency-key"] == "revoke:2"
        assert cancel_call.headers["authorization"] == EXPECTED_AUTH
        assert json.loads(cancel_call.content) == {
            "cancelReason": "customer request",
            "cancelAmount": 5000,
            "refundReceiveAccount": refund_receive_account,
        }

    def test_ec_d4_card_payment_refund_does_not_require_refund_receive_account(self):
        handler, calls = recording_transport(
            {
                "GET /v1/payments/CARD_KEY": json_response(PAYMENT_FIXTURE_DONE),
                "POST /v1/payments/CARD_KEY/cancel": json_response(
                    PAYMENT_FIXTURE_DONE
                ),
            }
        )
        provider = make_provider(handler)

        async def run():
            return await provider.refund(
                payment_ref="CARD_KEY",
                amount=Money(amount_minor=5000, currency="KRW"),
                reason="r",
                idempotency_key="revoke:3",
            )

        refund = asyncio.run(run())
        assert refund is not None
        assert json.loads(calls[1].content) == {
            "cancelReason": "r",
            "cancelAmount": 5000,
        }


class TestCreateCheckout:
    def _base_input(self, **overrides) -> CreateCheckoutInput:
        kwargs = {
            "customer_ref": "cus_abc",
            "plan": PLAN,
            "price": PRICE,
            "mode": "subscription",
            "success_url": "https://app.example.com/success",
            "cancel_url": "https://app.example.com/cancel",
            "idempotency_key": "checkout:cus_abc:plan_1:2026-09-09T00:00",
        }
        kwargs.update(overrides)
        return CreateCheckoutInput(**kwargs)

    def test_ec_e10_rejects_non_krw_price(self):
        provider = make_provider(unreachable_transport)
        usd_price = PlanPrice(currency="USD", amount_minor=1500)

        async def run():
            await provider.create_checkout(self._base_input(price=usd_price))

        with pytest.raises(Exception) as exc_info:
            asyncio.run(run())
        assert getattr(exc_info.value, "code", None) == "currency_unsupported"

    def test_ec_e6_deterministic_order_id_same_idempotency_key_same_order_id(self):
        provider = make_provider(unreachable_transport)
        base_input = self._base_input()

        async def run():
            c1 = await provider.create_checkout(base_input)
            c2 = await provider.create_checkout(base_input)
            return c1, c2

        c1, c2 = asyncio.run(run())
        assert c1.id == c2.id
        assert c1.provider_ref == c1.id
        assert f"orderId={c1.id}" in c1.url
        assert "amount=15000" in c1.url

    def test_ec_e6_different_idempotency_key_different_order_id(self):
        provider = make_provider(unreachable_transport)

        async def run():
            c1 = await provider.create_checkout(self._base_input())
            c2 = await provider.create_checkout(
                self._base_input(
                    idempotency_key="checkout:cus_abc:plan_1:2026-09-09T00:01"
                )
            )
            return c1, c2

        c1, c2 = asyncio.run(run())
        assert c1.id != c2.id


class TestUnsupportedByDesign:
    def test_ec_f_get_subscription_raises_unsupported(self):
        provider = make_provider(unreachable_transport)

        async def run():
            await provider.get_subscription("sub_ref")

        with pytest.raises(Exception) as exc_info:
            asyncio.run(run())
        assert getattr(exc_info.value, "code", None) == "unsupported"

    def test_ec_f_change_subscription_raises_unsupported(self):
        provider = make_provider(unreachable_transport)

        async def run():
            await provider.change_subscription(
                "sub_ref", new_price_ref="price_2", proration="none", reset_anchor=False
            )

        with pytest.raises(Exception) as exc_info:
            asyncio.run(run())
        assert getattr(exc_info.value, "code", None) == "unsupported"

    def test_ec_f_cancel_subscription_raises_unsupported(self):
        provider = make_provider(unreachable_transport)

        async def run():
            await provider.cancel_subscription("sub_ref", at_period_end=True)

        with pytest.raises(Exception) as exc_info:
            asyncio.run(run())
        assert getattr(exc_info.value, "code", None) == "unsupported"

    def test_ec_a23_uncancel_subscription_raises_unsupported(self):
        provider = make_provider(unreachable_transport)

        async def run():
            await provider.uncancel_subscription("sub_ref")

        with pytest.raises(Exception) as exc_info:
            asyncio.run(run())
        assert getattr(exc_info.value, "code", None) == "unsupported"

    def test_ec_f_report_usage_raises_unsupported_and_capabilities_meters_is_false(
        self,
    ):
        provider = make_provider(unreachable_transport)
        assert provider.capabilities().meters is False

        async def run():
            from datetime import UTC, datetime

            await provider.report_usage(
                meter="m",
                customer_ref="c",
                quantity=1,
                occurred_at=datetime.now(UTC),
                idempotency_key="k",
            )

        with pytest.raises(Exception) as exc_info:
            asyncio.run(run())
        assert getattr(exc_info.value, "code", None) == "unsupported"


class TestCreateCustomer:
    def test_ec_f_generates_deterministic_customer_key_from_email(self):
        provider = make_provider(unreachable_transport)

        async def run():
            r1 = await provider.create_customer(email="user@example.com")
            r2 = await provider.create_customer(email="user@example.com")
            return r1, r2

        r1, r2 = asyncio.run(run())
        assert r1["ref"].startswith("cus_")
        assert len(r1["ref"]) <= 50
        assert r1["ref"] == r2["ref"]

    def test_ec_f_uses_metadata_customer_key_verbatim(self):
        provider = make_provider(unreachable_transport)

        async def run():
            return await provider.create_customer(
                email="user@example.com", metadata={"customerKey": "custom_key_1"}
            )

        result = asyncio.run(run())
        assert result["ref"] == "custom_key_1"


class TestListPayments:
    def test_ec_h4_gets_transactions_with_date_range_and_filters_by_customer_key(self):
        from datetime import datetime

        def handler(request: httpx.Request) -> httpx.Response:
            assert request.method == "GET"
            assert request.url.path == "/v1/transactions"
            assert "startDate" in str(request.url)
            return json_response(
                [TRANSACTION_FIXTURE_DONE, TRANSACTION_FIXTURE_OTHER_CUSTOMER]
            )

        provider = make_provider(handler)

        async def run():
            from datetime import UTC, datetime

            return await provider.list_payments(
                customer_ref="cus_abc", since=datetime(2026, 1, 1, tzinfo=UTC)
            )

        payments = asyncio.run(run())
        assert len(payments) == 1
        assert payments[0].id == "B3EvL1cKz9p-kO6XPNpfF"
        # TransactionDto uses `amount`/`transactionAt`, not Payment's `totalAmount`/`approvedAt` —
        # asserting these catches the field-name mismatch bug (pre-fix: raised KeyError).
        assert payments[0].status == "succeeded"
        assert payments[0].amount.amount_minor == 15000
        assert payments[0].amount.currency == "KRW"
        assert payments[0].occurred_at == datetime.fromisoformat(
            "2022-05-12T00:00:05+09:00"
        )


class TestGetPayment:
    def test_ec_e8_waiting_for_deposit_returns_pending_not_succeeded(self):
        handler, _ = recording_transport(
            {"GET /v1/payments/WAIT_KEY": json_response(PAYMENT_FIXTURE_WAITING)}
        )
        provider = make_provider(handler)

        async def run():
            return await provider.get_payment("WAIT_KEY")

        payment = asyncio.run(run())
        assert payment.status == "pending"


# ── (d) EC:K2-K7 — KR cash receipt ────────────────────────────────────────

# Real response shape confirmed live 2026-09-09 against api.tosspayments.com (test_sk_ key,
# POST /v1/cash-receipts) — see __init__.py's normalize_toss_cash_receipt doc comment.
CASH_RECEIPT_ISSUE_FIXTURE = {
    "receiptKey": "vdX0wJDpj5mBZ1gQ4YVX9wpP6aLypjrl2KPoqNbMGOkn9EW7",
    "orderId": "YOWWcpZSDCZ8WJC5x7mkl",
    "orderName": "paykit live test",
    "type": "소득공제",
    "issueNumber": "730000031",
    "receiptUrl": "https://dashboard-sandbox.tosspayments.com/receipts/cash-receipt/YOWWcpZSDCZ8WJC5x7mkl/tvivarepublica?ref=PX",
    "businessNumber": "",
    "transactionType": "CONFIRM",
    "amount": 10000,
    "taxFreeAmount": 0,
    "issueStatus": "IN_PROGRESS",
    "failure": None,
    "customerIdentityNumber": "01012345678",
    "requestedAt": "2026-09-09T12:00:02+09:00",
}

CASH_RECEIPT_CANCEL_FIXTURE = {
    **CASH_RECEIPT_ISSUE_FIXTURE,
    "receiptKey": "c_vdX0wJDpj5mBZ1gQ4YVX9wpP6aLypjrl2KPoqNbMGOkn9EW7",
    "transactionType": "CANCEL",
}


class TestNormalizeTossCashReceipt:
    def test_ec_k2_k5_maps_issue_response_to_in_progress(self):
        receipt = normalize_toss_cash_receipt(CASH_RECEIPT_ISSUE_FIXTURE)
        assert receipt.status == "in_progress"
        assert receipt.type == "personal"
        assert receipt.receipt_key == CASH_RECEIPT_ISSUE_FIXTURE["receiptKey"]

    def test_ec_k5_maps_cancel_response_to_canceled(self):
        receipt = normalize_toss_cash_receipt(CASH_RECEIPT_CANCEL_FIXTURE)
        assert receipt.status == "canceled"

    def test_ec_k3_maps_지출증빙_to_business(self):
        receipt = normalize_toss_cash_receipt(
            {**CASH_RECEIPT_ISSUE_FIXTURE, "type": "지출증빙"}
        )
        assert receipt.type == "business"


class TestIssueCashReceipt:
    def test_ec_k4_refuses_card_payment_without_calling_issue_endpoint(self):
        handler, calls = recording_transport(
            {
                "GET /v1/payments/B3EvL1cKz9p-kO6XPNpfF": json_response(
                    PAYMENT_FIXTURE_DONE
                )
            }
        )
        provider = make_provider(handler)

        async def run():
            await provider.issue_cash_receipt(
                payment_ref="B3EvL1cKz9p-kO6XPNpfF",
                type="personal",
                customer_identity_number="01012345678",
            )

        with pytest.raises(Exception) as exc_info:
            asyncio.run(run())
        assert (
            getattr(exc_info.value, "code", None)
            == "cash_receipt_unsupported_for_payment_method"
        )
        assert len(calls) == 1  # only the GET re-fetch, no POST /v1/cash-receipts

    def test_ec_k2_k3_issues_against_cash_eligible_payment(self):
        handler, calls = recording_transport(
            {
                "GET /v1/payments/VA_KEY": json_response(PAYMENT_FIXTURE_VA),
                "POST /v1/cash-receipts": json_response(CASH_RECEIPT_ISSUE_FIXTURE),
            }
        )
        provider = make_provider(handler)

        async def run():
            return await provider.issue_cash_receipt(
                payment_ref="VA_KEY",
                type="personal",
                customer_identity_number="01012345678",
            )

        receipt = asyncio.run(run())
        assert receipt.status == "in_progress"
        assert receipt.type == "personal"
        post_call = calls[1]
        body = json.loads(post_call.content)
        assert body["orderId"] == "ord_va"
        assert body["type"] == "소득공제"
        assert body["amount"] == 20000


class TestCancelCashReceipt:
    def test_ec_k5_full_cancel_omits_amount(self):
        receipt_key = CASH_RECEIPT_ISSUE_FIXTURE["receiptKey"]
        handler, calls = recording_transport(
            {
                f"POST /v1/cash-receipts/{receipt_key}/cancel": json_response(
                    CASH_RECEIPT_CANCEL_FIXTURE
                )
            }
        )
        provider = make_provider(handler)

        async def run():
            return await provider.cancel_cash_receipt(receipt_key=receipt_key)

        receipt = asyncio.run(run())
        assert receipt.status == "canceled"
        assert json.loads(calls[0].content) == {}

    def test_ec_k5_partial_cancel_sends_amount(self):
        receipt_key = CASH_RECEIPT_ISSUE_FIXTURE["receiptKey"]
        handler, calls = recording_transport(
            {
                f"POST /v1/cash-receipts/{receipt_key}/cancel": json_response(
                    {**CASH_RECEIPT_CANCEL_FIXTURE, "amount": 3000}
                )
            }
        )
        provider = make_provider(handler)

        async def run():
            return await provider.cancel_cash_receipt(
                receipt_key=receipt_key, amount_minor=3000
            )

        asyncio.run(run())
        assert json.loads(calls[0].content) == {"amount": 3000}


class TestGetCashReceipt:
    def test_ec_k7_lists_by_request_date_and_filters_by_order_id(self):
        handler, _ = recording_transport(
            {"GET /v1/cash-receipts": json_response([CASH_RECEIPT_ISSUE_FIXTURE])}
        )
        provider = make_provider(handler)

        async def run():
            return await provider.get_cash_receipt(
                order_id="YOWWcpZSDCZ8WJC5x7mkl", request_date="2026-09-09"
            )

        receipt = asyncio.run(run())
        assert receipt is not None
        assert receipt.receipt_key == CASH_RECEIPT_ISSUE_FIXTURE["receiptKey"]

    def test_ec_k7_returns_none_when_no_match(self):
        handler, _ = recording_transport(
            {"GET /v1/cash-receipts": json_response([CASH_RECEIPT_ISSUE_FIXTURE])}
        )
        provider = make_provider(handler)

        async def run():
            return await provider.get_cash_receipt(
                order_id="no_such_order", request_date="2026-09-09"
            )

        receipt = asyncio.run(run())
        assert receipt is None
