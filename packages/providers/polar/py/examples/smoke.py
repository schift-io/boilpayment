"""Smoke test — no live Polar keys. Exercises verify_webhook (manual Standard Webhooks verification)
against a self-signed payload and the pure normalize functions against fixture objects. Mirrors
ts/examples/smoke.ts field-for-field so the two languages can be diffed. Run:
.venv/bin/python packages/providers/polar/py/examples/smoke.py
"""

from __future__ import annotations

import asyncio
import base64
import dataclasses
import hashlib
import hmac
import json
import time
from datetime import UTC, datetime, timedelta

from schift_payment_kit_core import WebhookSignatureError
from schift_payment_kit_polar import (
    PolarProvider,
    map_event_type,
    normalize_failure,
    normalize_order,
    normalize_refund,
    normalize_subscription,
    to_normalized_event,
    verify_standard_webhook_signature,
)


def dc(obj):
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return {f.name: dc(getattr(obj, f.name)) for f in dataclasses.fields(obj)}
    if isinstance(obj, list):
        return [dc(v) for v in obj]
    if isinstance(obj, dict):
        return {k: dc(v) for k, v in obj.items()}
    if hasattr(obj, "isoformat"):
        return obj.isoformat()
    return obj


def sign_standard_webhook(id_: str, timestamp: str, body: str, secret: str) -> str:
    secret_raw = secret.removeprefix("whsec_")
    key = base64.b64decode(secret_raw)
    signed_content = f"{id_}.{timestamp}.{body}".encode()
    sig = base64.b64encode(
        hmac.new(key, signed_content, hashlib.sha256).digest()
    ).decode("utf-8")
    return f"v1,{sig}"


async def main() -> None:
    webhook_secret = "whsec_c2VjcmV0a2V5Zm9ycG9sYXJ0ZXN0"
    provider = PolarProvider(
        access_token="polar_at_dummy", webhook_secret=webhook_secret, server="sandbox"
    )

    print("=== capabilities ===")
    print(provider.capabilities())

    now_iso = datetime(2026, 1, 1, tzinfo=UTC).isoformat()
    order_paid_body = json.dumps(
        {
            "type": "order.paid",
            "timestamp": now_iso,
            "data": {
                "id": "order_test_1",
                "customer_id": "cust_test_1",
                "subscription_id": "sub_test_1",
                "total_amount": 5000,
                "currency": "krw",
                "status": "paid",
                "paid": True,
                "created_at": now_iso,
            },
        }
    )
    webhook_id = "msg_test_1"
    timestamp = str(int(time.time()))
    sig_header = sign_standard_webhook(
        webhook_id, timestamp, order_paid_body, webhook_secret
    )

    print("\n=== verifyWebhook (valid signature, order.paid) ===")
    normalized = await provider.verify_webhook(
        headers={
            "webhook-id": webhook_id,
            "webhook-timestamp": timestamp,
            "webhook-signature": sig_header,
        },
        raw_body=order_paid_body,
    )
    print(json.dumps(dc(normalized), indent=2, ensure_ascii=False))

    print("\n=== verifyWebhook (bad signature) ===")
    try:
        await provider.verify_webhook(
            headers={
                "webhook-id": webhook_id,
                "webhook-timestamp": timestamp,
                "webhook-signature": "v1,deadbeef",
            },
            raw_body=order_paid_body,
        )
        print("FAIL: expected WebhookSignatureError, none thrown")
    except WebhookSignatureError as err:
        print("OK: rejected as WebhookSignatureError:", err)

    print("\n=== verify_standard_webhook_signature (missing headers) ===")
    try:
        verify_standard_webhook_signature(
            headers={}, raw_body=order_paid_body, secret=webhook_secret
        )
        print("FAIL: expected WebhookSignatureError")
    except WebhookSignatureError as err:
        print("OK:", err)

    print("\n=== normalize_failure fixture ===")
    print(normalize_failure(message="card processing error"))

    print("\n=== normalize_order fixture (topup) ===")
    print(
        json.dumps(
            dc(
                normalize_order(
                    {
                        "id": "order_test_2",
                        "customer_id": "cust_test_1",
                        "total_amount": 1000,
                        "currency": "usd",
                        "status": "paid",
                        "paid": True,
                        "created_at": now_iso,
                    }
                )
            ),
            indent=2,
            ensure_ascii=False,
        )
    )

    print("\n=== normalize_subscription fixture ===")
    print(
        json.dumps(
            dc(
                normalize_subscription(
                    {
                        "id": "sub_test_1",
                        "customer_id": "cust_test_1",
                        "status": "active",
                        "current_period_start": now_iso,
                        "current_period_end": (
                            datetime(2026, 1, 1, tzinfo=UTC) + timedelta(days=30)
                        ).isoformat(),
                        "cancel_at_period_end": False,
                        "created_at": now_iso,
                        "metadata": {
                            "customerId": "internal_cust_1",
                            "planId": "plan_pro",
                        },
                    }
                )
            ),
            indent=2,
            ensure_ascii=False,
        )
    )

    print("\n=== normalize_refund fixture ===")
    print(
        json.dumps(
            dc(
                normalize_refund(
                    {
                        "id": "refund_test_1",
                        "order_id": "order_test_1",
                        "customer_id": "cust_test_1",
                        "amount": 2000,
                        "currency": "krw",
                        "status": "succeeded",
                        "reason": "customer_request",
                        "created_at": now_iso,
                    },
                    "D4",
                )
            ),
            indent=2,
            ensure_ascii=False,
        )
    )

    print("\n=== map_event_type(subscription.revoked) ===")
    print(map_event_type("subscription.revoked"))

    print("\n=== to_normalized_event (subscription.past_due fixture) ===")
    print(
        json.dumps(
            dc(
                to_normalized_event(
                    {
                        "type": "subscription.past_due",
                        "timestamp": now_iso,
                        "data": {"id": "sub_test_2", "customer_id": "cust_test_2"},
                    }
                )
            ),
            indent=2,
            ensure_ascii=False,
        )
    )

    print("\nSMOKE OK")


if __name__ == "__main__":
    asyncio.run(main())
