"""[EC:E4] verify_webhook signature verification tests. Signatures are constructed by hand
(HMAC-SHA256 over "{t}.{body}", header "t=...,v1=...") via _webhook_sig.sign_stripe_payload,
mirroring Stripe's documented scheme — not the SDK's own `stripe.WebhookSignature
.generate_signature_header` test helper — so the test doesn't validate the SDK against itself.
No network calls: verify_webhook is pure crypto + parsing (spec "엔드포인트 매핑" row for
verify_webhook). pytest-asyncio is not installed, so every test drives the async provider method
via `asyncio.run(...)` inside an ordinary sync `def test_...():`.
"""

from __future__ import annotations

import asyncio
import json
import time

import pytest
from _webhook_sig import sign_stripe_payload
from boilpayment_core import WebhookSignatureError
from boilpayment_stripe import StripeProvider

WEBHOOK_SECRET = "whsec_testsecret1234567890"


def _provider() -> StripeProvider:
    return StripeProvider(secret_key="sk_test_dummy", webhook_secret=WEBHOOK_SECRET)


def _invoice_paid_payload(now: int) -> str:
    return json.dumps(
        {
            "id": "evt_test_invoice_paid",
            "object": "event",
            "type": "invoice.paid",
            "created": now,
            "data": {
                "object": {
                    "id": "in_test_1",
                    "object": "invoice",
                    "customer": "cus_test_1",
                    "subscription": "sub_test_1",
                    "amount_paid": 5000,
                    "amount_due": 5000,
                    "currency": "krw",
                    "status": "paid",
                    "created": now,
                    "lines": {
                        "data": [{"period": {"start": now, "end": now + 30 * 86400}}]
                    },
                }
            },
        }
    )


def test_ec_e4_valid_signature_passes_and_maps_correctly():
    provider = _provider()
    now = int(time.time())
    payload = _invoice_paid_payload(now)
    header = sign_stripe_payload(payload, WEBHOOK_SECRET, now)

    normalized = asyncio.run(
        provider.verify_webhook(headers={"stripe-signature": header}, raw_body=payload)
    )

    assert normalized.type == "payment.succeeded"
    assert normalized.payment_ref == "in_test_1"
    assert normalized.subscription_ref == "sub_test_1"
    assert normalized.customer_ref == "cus_test_1"
    assert normalized.amount.amount_minor == 5000
    assert normalized.amount.currency == "KRW"


def test_ec_e4_capitalized_header_name_also_accepted():
    provider = _provider()
    now = int(time.time())
    payload = _invoice_paid_payload(now)
    header = sign_stripe_payload(payload, WEBHOOK_SECRET, now)

    normalized = asyncio.run(
        provider.verify_webhook(headers={"Stripe-Signature": header}, raw_body=payload)
    )
    assert normalized.type == "payment.succeeded"


def test_ec_e4_tampered_body_rejected():
    provider = _provider()
    now = int(time.time())
    payload = _invoice_paid_payload(now)
    header = sign_stripe_payload(payload, WEBHOOK_SECRET, now)
    tampered_payload = payload.replace('"amount_paid": 5000', '"amount_paid": 999999')

    with pytest.raises(WebhookSignatureError):
        asyncio.run(
            provider.verify_webhook(
                headers={"stripe-signature": header}, raw_body=tampered_payload
            )
        )


def test_ec_e4_wrong_secret_rejected():
    provider = _provider()
    now = int(time.time())
    payload = _invoice_paid_payload(now)
    header = sign_stripe_payload(payload, "whsec_totally_different_secret", now)

    with pytest.raises(WebhookSignatureError):
        asyncio.run(
            provider.verify_webhook(
                headers={"stripe-signature": header}, raw_body=payload
            )
        )


def test_ec_e4_missing_header_rejected_without_verification_attempt():
    provider = _provider()
    payload = _invoice_paid_payload(int(time.time()))

    with pytest.raises(WebhookSignatureError, match="missing stripe-signature header"):
        asyncio.run(provider.verify_webhook(headers={}, raw_body=payload))


def test_ec_e4_malformed_header_rejected():
    provider = _provider()
    payload = _invoice_paid_payload(int(time.time()))

    with pytest.raises(WebhookSignatureError):
        asyncio.run(
            provider.verify_webhook(
                headers={"stripe-signature": "t=123,not_v1=deadbeef"}, raw_body=payload
            )
        )


def test_ec_e4_stale_timestamp_beyond_default_tolerance_rejected():
    provider = _provider()
    stale_timestamp = int(time.time()) - 600  # 10 minutes ago, > 300s default tolerance
    payload = _invoice_paid_payload(stale_timestamp)
    header = sign_stripe_payload(payload, WEBHOOK_SECRET, stale_timestamp)

    with pytest.raises(WebhookSignatureError):
        asyncio.run(
            provider.verify_webhook(
                headers={"stripe-signature": header}, raw_body=payload
            )
        )


def test_ec_e4_timestamp_within_tolerance_still_passes():
    provider = _provider()
    recent_timestamp = int(time.time()) - 60
    payload = _invoice_paid_payload(recent_timestamp)
    header = sign_stripe_payload(payload, WEBHOOK_SECRET, recent_timestamp)

    normalized = asyncio.run(
        provider.verify_webhook(headers={"stripe-signature": header}, raw_body=payload)
    )
    assert normalized.type == "payment.succeeded"
