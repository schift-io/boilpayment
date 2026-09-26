"""Phase 6 regression tests — [EC:E4] verify_webhook (Standard Webhooks / Svix-compatible
scheme). No network calls: httpx.AsyncClient is constructed with a MockTransport that
raises if ever called, so a bug that accidentally triggers a re-fetch fails loudly.

pytest-asyncio is not installed: every async call runs via asyncio.run() inside a sync
`def test_...():` function.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import time

import httpx
import pytest
from schift_payment_kit_core import WebhookSignatureError
from schift_payment_kit_portone import PortoneProvider, PortoneProviderConfig

WEBHOOK_SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"

BODY = (
    '{"type": "Transaction.Paid", "timestamp": "2024-04-25T10:00:00.000Z", '
    '"data": {"paymentId": "example-payment-id"}}'
)


def sign_standard_webhook(secret: str, id_: str, timestamp: str, body: str) -> str:
    secret_b64 = secret.removeprefix("whsec_")
    key = base64.b64decode(secret_b64)
    signed_content = f"{id_}.{timestamp}.{body}".encode()
    sig = base64.b64encode(
        hmac.new(key, signed_content, hashlib.sha256).digest()
    ).decode("ascii")
    return f"v1,{sig}"


def _never_called_transport(request: httpx.Request) -> httpx.Response:
    raise AssertionError("verify_webhook must not perform any HTTP request")


def make_provider(webhook_secret: str = WEBHOOK_SECRET) -> PortoneProvider:
    client = httpx.AsyncClient(
        base_url="https://api.portone.io",
        transport=httpx.MockTransport(_never_called_transport),
    )
    return PortoneProvider(
        PortoneProviderConfig(
            api_secret="test_sk_dummy",
            store_id="store_dummy",
            webhook_secret=webhook_secret,
        ),
        client,
    )


def test_ec_e4_valid_signature_verifies_and_webhook_id_becomes_event_id() -> None:
    provider = make_provider()
    id_ = "msg_2aXpZoWFrKlmCfxbRSjBRXP2C6H"
    timestamp = str(int(time.time()))
    signature = sign_standard_webhook(WEBHOOK_SECRET, id_, timestamp, BODY)

    event = asyncio.run(
        provider.verify_webhook(
            headers={
                "webhook-id": id_,
                "webhook-timestamp": timestamp,
                "webhook-signature": signature,
            },
            raw_body=BODY,
        )
    )
    assert event.id == id_
    assert event.type == "payment.succeeded"
    assert event.payment_ref == "example-payment-id"


def test_ec_e4_tampered_body_raises_webhook_signature_error() -> None:
    provider = make_provider()
    id_ = "msg_tampered"
    timestamp = str(int(time.time()))
    signature = sign_standard_webhook(WEBHOOK_SECRET, id_, timestamp, BODY)
    tampered = BODY.replace("example-payment-id", "attacker-controlled")

    with pytest.raises(WebhookSignatureError):
        asyncio.run(
            provider.verify_webhook(
                headers={
                    "webhook-id": id_,
                    "webhook-timestamp": timestamp,
                    "webhook-signature": signature,
                },
                raw_body=tampered,
            )
        )


def test_ec_e4_wrong_secret_raises_webhook_signature_error() -> None:
    provider = make_provider()
    id_ = "msg_wrong_secret"
    timestamp = str(int(time.time()))
    other_secret = (
        "whsec_" + base64.b64encode(b"a-totally-different-32-byte-key").decode()
    )
    signature = sign_standard_webhook(other_secret, id_, timestamp, BODY)

    with pytest.raises(WebhookSignatureError):
        asyncio.run(
            provider.verify_webhook(
                headers={
                    "webhook-id": id_,
                    "webhook-timestamp": timestamp,
                    "webhook-signature": signature,
                },
                raw_body=BODY,
            )
        )


def test_ec_e4_missing_webhook_signature_header_raises() -> None:
    provider = make_provider()
    id_ = "msg_missing_sig"
    timestamp = str(int(time.time()))

    with pytest.raises(WebhookSignatureError):
        asyncio.run(
            provider.verify_webhook(
                headers={"webhook-id": id_, "webhook-timestamp": timestamp},
                raw_body=BODY,
            )
        )


def test_ec_e4_missing_webhook_id_header_raises() -> None:
    provider = make_provider()
    timestamp = str(int(time.time()))
    signature = sign_standard_webhook(WEBHOOK_SECRET, "irrelevant", timestamp, BODY)

    with pytest.raises(WebhookSignatureError):
        asyncio.run(
            provider.verify_webhook(
                headers={
                    "webhook-timestamp": timestamp,
                    "webhook-signature": signature,
                },
                raw_body=BODY,
            )
        )


def test_ec_e4_stale_timestamp_beyond_5min_tolerance_raises() -> None:
    # spec: `if abs(now() - timestamp) > 300s: throw` — 301s old is just past tolerance.
    provider = make_provider()
    id_ = "msg_stale"
    stale_timestamp = str(int(time.time()) - 301)
    signature = sign_standard_webhook(WEBHOOK_SECRET, id_, stale_timestamp, BODY)

    with pytest.raises(WebhookSignatureError):
        asyncio.run(
            provider.verify_webhook(
                headers={
                    "webhook-id": id_,
                    "webhook-timestamp": stale_timestamp,
                    "webhook-signature": signature,
                },
                raw_body=BODY,
            )
        )


def test_ec_e4_timestamp_within_tolerance_299s_old_still_verifies() -> None:
    provider = make_provider()
    id_ = "msg_barely_fresh"
    timestamp = str(int(time.time()) - 299)
    signature = sign_standard_webhook(WEBHOOK_SECRET, id_, timestamp, BODY)

    event = asyncio.run(
        provider.verify_webhook(
            headers={
                "webhook-id": id_,
                "webhook-timestamp": timestamp,
                "webhook-signature": signature,
            },
            raw_body=BODY,
        )
    )
    assert event.type == "payment.succeeded"


def test_ec_e4_svix_header_aliases_accepted_in_place_of_webhook_headers() -> None:
    provider = make_provider()
    id_ = "msg_svix_alias"
    timestamp = str(int(time.time()))
    signature = sign_standard_webhook(WEBHOOK_SECRET, id_, timestamp, BODY)

    event = asyncio.run(
        provider.verify_webhook(
            headers={
                "svix-id": id_,
                "svix-timestamp": timestamp,
                "svix-signature": signature,
            },
            raw_body=BODY,
        )
    )
    assert event.id == id_
