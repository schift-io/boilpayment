"""Phase 6 regression tests — Standard Webhooks signature verification. Signing helper mirrors
py/examples/smoke.py sign_standard_webhook exactly. Mirrors ts/test/webhook.test.ts.

pytest-asyncio is NOT installed in this environment: async provider.verify_webhook calls are
driven via asyncio.run(...) inside plain sync test functions.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import time

import pytest
from boilpayment_core import WebhookSignatureError
from boilpayment_polar import PolarProvider, verify_standard_webhook_signature

WEBHOOK_SECRET = "whsec_c2VjcmV0a2V5Zm9ycG9sYXJ0ZXN0"


# 5-minute Standard Webhooks tolerance was added to verify_standard_webhook_signature
# (2026-09-09, mirroring PortoneProvider) -- signature-validity tests below use a fresh
# timestamp so they keep testing HMAC matching, not staleness (own dedicated test below).
def fresh_timestamp() -> str:
    return str(int(time.time()))


def sign_standard_webhook(id_: str, timestamp: str, body: str, secret: str) -> str:
    secret_raw = secret.removeprefix("whsec_")
    key = base64.b64decode(secret_raw)
    signed_content = f"{id_}.{timestamp}.{body}".encode()
    sig = base64.b64encode(
        hmac.new(key, signed_content, hashlib.sha256).digest()
    ).decode("utf-8")
    return f"v1,{sig}"


ORDER_PAID_BODY = json.dumps(
    {
        "type": "order.paid",
        "timestamp": "2024-01-01T00:00:00+00:00",
        "data": {
            "id": "order_test_1",
            "customer_id": "cust_test_1",
            "subscription_id": "sub_test_1",
            "total_amount": 5000,
            "currency": "krw",
            "status": "paid",
            "paid": True,
            "created_at": "2024-01-01T00:00:00+00:00",
        },
    }
)


class TestVerifyStandardWebhookSignature:
    def test_ec_webhook_signature_valid_signature_passes(self):
        id_ = "msg_test_1"
        timestamp = fresh_timestamp()
        sig = sign_standard_webhook(id_, timestamp, ORDER_PAID_BODY, WEBHOOK_SECRET)
        verify_standard_webhook_signature(
            headers={
                "webhook-id": id_,
                "webhook-timestamp": timestamp,
                "webhook-signature": sig,
            },
            raw_body=ORDER_PAID_BODY,
            secret=WEBHOOK_SECRET,
        )  # no raise

    def test_ec_e4_tampered_body_raises_webhook_signature_error(self):
        id_ = "msg_test_1"
        timestamp = fresh_timestamp()
        sig = sign_standard_webhook(id_, timestamp, ORDER_PAID_BODY, WEBHOOK_SECRET)
        tampered_body = ORDER_PAID_BODY.replace("5000", "999999")
        with pytest.raises(WebhookSignatureError):
            verify_standard_webhook_signature(
                headers={
                    "webhook-id": id_,
                    "webhook-timestamp": timestamp,
                    "webhook-signature": sig,
                },
                raw_body=tampered_body,
                secret=WEBHOOK_SECRET,
            )

    def test_ec_e4_wrong_secret_raises_webhook_signature_error(self):
        id_ = "msg_test_1"
        timestamp = fresh_timestamp()
        sig = sign_standard_webhook(id_, timestamp, ORDER_PAID_BODY, WEBHOOK_SECRET)
        with pytest.raises(WebhookSignatureError):
            verify_standard_webhook_signature(
                headers={
                    "webhook-id": id_,
                    "webhook-timestamp": timestamp,
                    "webhook-signature": sig,
                },
                raw_body=ORDER_PAID_BODY,
                secret="whsec_ZGlmZmVyZW50c2VjcmV0a2V5",
            )

    def test_ec_e4_garbage_signature_raises(self):
        with pytest.raises(WebhookSignatureError):
            verify_standard_webhook_signature(
                headers={
                    "webhook-id": "msg_test_1",
                    "webhook-timestamp": fresh_timestamp(),
                    "webhook-signature": "v1,deadbeef",
                },
                raw_body=ORDER_PAID_BODY,
                secret=WEBHOOK_SECRET,
            )

    def test_ec_e4_missing_headers_raises(self):
        with pytest.raises(WebhookSignatureError):
            verify_standard_webhook_signature(
                headers={}, raw_body=ORDER_PAID_BODY, secret=WEBHOOK_SECRET
            )

    def test_ec_e4_header_lookup_is_case_insensitive(self):
        id_ = "msg_test_1"
        timestamp = fresh_timestamp()
        sig = sign_standard_webhook(id_, timestamp, ORDER_PAID_BODY, WEBHOOK_SECRET)
        verify_standard_webhook_signature(
            headers={
                "Webhook-Id": id_,
                "Webhook-Timestamp": timestamp,
                "Webhook-Signature": sig,
            },
            raw_body=ORDER_PAID_BODY,
            secret=WEBHOOK_SECRET,
        )  # no raise

    def test_ec_webhook_signature_multiple_candidates_matches_if_any_valid(self):
        id_ = "msg_test_1"
        timestamp = fresh_timestamp()
        sig = sign_standard_webhook(id_, timestamp, ORDER_PAID_BODY, WEBHOOK_SECRET)
        verify_standard_webhook_signature(
            headers={
                "webhook-id": id_,
                "webhook-timestamp": timestamp,
                "webhook-signature": f"v1,bogus {sig}",
            },
            raw_body=ORDER_PAID_BODY,
            secret=WEBHOOK_SECRET,
        )  # no raise

    def test_ec_webhook_signature_stale_timestamp_raises_even_with_valid_signature(
        self,
    ):
        id_ = "msg_test_1"
        timestamp = "1704067200"  # 2024-01-01 -- far outside the 5-minute tolerance
        sig = sign_standard_webhook(id_, timestamp, ORDER_PAID_BODY, WEBHOOK_SECRET)
        with pytest.raises(WebhookSignatureError):
            verify_standard_webhook_signature(
                headers={
                    "webhook-id": id_,
                    "webhook-timestamp": timestamp,
                    "webhook-signature": sig,
                },
                raw_body=ORDER_PAID_BODY,
                secret=WEBHOOK_SECRET,
            )

    def test_ec_webhook_signature_non_numeric_timestamp_raises(self):
        id_ = "msg_test_1"
        sig = sign_standard_webhook(
            id_, "not-a-number", ORDER_PAID_BODY, WEBHOOK_SECRET
        )
        with pytest.raises(WebhookSignatureError):
            verify_standard_webhook_signature(
                headers={
                    "webhook-id": id_,
                    "webhook-timestamp": "not-a-number",
                    "webhook-signature": sig,
                },
                raw_body=ORDER_PAID_BODY,
                secret=WEBHOOK_SECRET,
            )


class TestPolarProviderVerifyWebhook:
    provider = PolarProvider(
        access_token="polar_at_dummy", webhook_secret=WEBHOOK_SECRET, server="sandbox"
    )

    def test_ec_e4_valid_signature_returns_normalized_event(self):
        id_ = "msg_test_1"
        timestamp = fresh_timestamp()
        sig = sign_standard_webhook(id_, timestamp, ORDER_PAID_BODY, WEBHOOK_SECRET)

        async def run():
            return await self.provider.verify_webhook(
                headers={
                    "webhook-id": id_,
                    "webhook-timestamp": timestamp,
                    "webhook-signature": sig,
                },
                raw_body=ORDER_PAID_BODY,
            )

        ev = asyncio.run(run())
        assert ev.type == "payment.succeeded"
        assert ev.payment_ref == "order_test_1"
        assert ev.provider == "polar"

    def test_ec_e4_tampered_body_raises_through_verify_webhook(self):
        id_ = "msg_test_1"
        timestamp = fresh_timestamp()
        sig = sign_standard_webhook(id_, timestamp, ORDER_PAID_BODY, WEBHOOK_SECRET)
        tampered_body = ORDER_PAID_BODY.replace("5000", "1")

        async def run():
            await self.provider.verify_webhook(
                headers={
                    "webhook-id": id_,
                    "webhook-timestamp": timestamp,
                    "webhook-signature": sig,
                },
                raw_body=tampered_body,
            )

        with pytest.raises(WebhookSignatureError):
            asyncio.run(run())

    def test_ec_e4_valid_signature_invalid_json_body_raises_webhook_signature_error(
        self,
    ):
        raw_body = "not json"
        id_ = "msg_test_2"
        timestamp = fresh_timestamp()
        sig = sign_standard_webhook(id_, timestamp, raw_body, WEBHOOK_SECRET)

        async def run():
            await self.provider.verify_webhook(
                headers={
                    "webhook-id": id_,
                    "webhook-timestamp": timestamp,
                    "webhook-signature": sig,
                },
                raw_body=raw_body,
            )

        with pytest.raises(WebhookSignatureError):
            asyncio.run(run())


def test_signed_refund_updates_keep_delivery_ids_distinct_from_refund_id():
    provider = PolarProvider(
        access_token="polar_at_dummy", webhook_secret=WEBHOOK_SECRET, server="sandbox"
    )
    timestamp = fresh_timestamp()

    async def run():
        deliveries = []
        for delivery_id, status in [
            ("msg_pending", "pending"),
            ("msg_succeeded", "succeeded"),
        ]:
            raw_body = json.dumps(
                {
                    "type": "refund.updated",
                    "timestamp": "2026-01-01T00:00:00Z",
                    "data": {
                        "id": "refund_same",
                        "order_id": "order_1",
                        "amount": 250,
                        "currency": "usd",
                        "status": status,
                    },
                }
            )
            headers = {
                "webhook-id": delivery_id,
                "webhook-timestamp": timestamp,
                "webhook-signature": sign_standard_webhook(
                    delivery_id, timestamp, raw_body, WEBHOOK_SECRET
                ),
            }
            event = await provider.verify_webhook(headers=headers, raw_body=raw_body)
            assert (
                await provider.verify_webhook(headers=headers, raw_body=raw_body)
            ).id == delivery_id
            deliveries.append(event)
        return deliveries

    events = asyncio.run(run())
    assert [event.id for event in events] == ["msg_pending", "msg_succeeded"]
    assert [event.refund_ref for event in events] == ["refund_same", "refund_same"]
    assert [event.type for event in events] == ["refund.pending", "refund.created"]
