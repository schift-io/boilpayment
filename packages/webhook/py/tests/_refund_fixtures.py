"""Actual provider verification and default handlers settle the original refund hold."""

import base64
import hashlib
import hmac
import json
import time
from datetime import UTC, datetime
from typing import Literal, assert_never

import httpx
from boilpayment_core import (
    PaymentProvider,
    ProviderName,
)
from boilpayment_polar import PolarProvider
from boilpayment_portone import PortoneProvider, PortoneProviderConfig
from boilpayment_stripe import StripeProvider
from boilpayment_toss import TossProvider, TossProviderConfig

SECRET = "whsec_" + base64.b64encode(b"settlement-test-secret").decode()
Status = Literal["succeeded", "failed", "pending"]


def delivery(name: ProviderName, status: Status) -> tuple[str, dict[str, str]]:
    timestamp = str(int(time.time()))
    event_id = f"delivery-{name}-{status}"
    now = datetime.now(UTC).isoformat()
    match name:
        case "stripe":
            body = {
                "id": event_id,
                "type": "refund.updated",
                "created": int(timestamp),
                "data": {
                    "object": {
                        "id": "refund-1",
                        "object": "refund",
                        "status": status,
                        "payment_intent": "payment-1",
                        "amount": 1000,
                        "currency": "usd",
                    }
                },
            }
        case "polar":
            body = {
                "type": "refund.updated",
                "timestamp": now,
                "data": {
                    "id": "refund-1",
                    "status": status,
                    "order_id": "payment-1",
                    "amount": 1000,
                    "currency": "usd",
                    "created_at": now,
                },
            }
        case "toss":
            body = {
                "eventType": "CANCEL_STATUS_CHANGED",
                "createdAt": now,
                "data": {
                    "transactionKey": "refund-1",
                    "cancelAmount": 1000,
                    "cancelStatus": "DONE",
                },
            }
        case "portone":
            body = {
                "type": "Transaction.CancelPending",
                "timestamp": now,
                "data": {"paymentId": "payment-1", "cancellationId": "refund-1"},
            }
        case unreachable:
            assert_never(unreachable)
    raw = json.dumps(body)
    standard_sig = base64.b64encode(
        hmac.digest(
            base64.b64decode(SECRET[6:]),
            f"{event_id}.{timestamp}.{raw}".encode(),
            "sha256",
        )
    ).decode()
    stripe_sig = hmac.new(
        SECRET.encode(), f"{timestamp}.{raw}".encode(), hashlib.sha256
    ).hexdigest()
    return raw, {
        "webhook-id": event_id,
        "webhook-timestamp": timestamp,
        "webhook-signature": f"v1,{standard_sig}",
        "stripe-signature": f"t={timestamp},v1={stripe_sig}",
        "x-paykit-remote-ip": "127.0.0.1",
    }


def provider_for(name: ProviderName, client: httpx.AsyncClient) -> PaymentProvider:
    match name:
        case "stripe":
            return StripeProvider(secret_key="sk_test_fixture", webhook_secret=SECRET)
        case "polar":
            return PolarProvider(access_token="fixture", webhook_secret=SECRET)
        case "toss":
            return TossProvider(
                TossProviderConfig(
                    secret_key="test_sk_fixture", allowed_webhook_ips=["127.0.0.1"]
                ),
                client,
            )
        case "portone":
            return PortoneProvider(
                PortoneProviderConfig(
                    api_secret="fixture", store_id="fixture", webhook_secret=SECRET
                ),
                client,
            )
        case unreachable:
            assert_never(unreachable)
