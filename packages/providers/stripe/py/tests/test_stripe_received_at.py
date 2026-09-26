"""[EC:E17] process() re-verifies a stored body long after receipt: freshness is judged at
`received_at`, the signature is always checked."""
from __future__ import annotations

import asyncio
import json
import time
from datetime import UTC, datetime

import pytest
from _webhook_sig import sign_stripe_payload
from boilpayment_core import WebhookSignatureError
from boilpayment_stripe import StripeProvider

SECRET = "whsec_testsecret1234567890"


def _body(t: int) -> str:
    return json.dumps({"id": "evt_e17", "object": "event", "type": "invoice.paid", "created": t,
        "data": {"object": {"id": "in_e17", "object": "invoice", "customer": "cus_1", "subscription": "sub_1",
        "amount_paid": 5000, "amount_due": 5000, "currency": "krw", "status": "paid", "created": t,
        "lines": {"data": [{"period": {"start": t, "end": t + 86400}}]}}}})


T = int(time.time()) - 600
RAW = _body(T)
HEADERS = {"stripe-signature": sign_stripe_payload(RAW, SECRET, T)}
AT = datetime.fromtimestamp(T, tz=UTC)
P = StripeProvider(secret_key="sk_test_dummy", webhook_secret=SECRET)


def test_ec_e17_fresh_at_receipt_verifies_later() -> None:
    e = asyncio.run(P.verify_webhook(headers=HEADERS, raw_body=RAW, received_at=AT))
    assert e.payment_ref == "in_e17"


def test_ec_e17_without_received_at_old_timestamp_refused() -> None:
    with pytest.raises(WebhookSignatureError):
        asyncio.run(P.verify_webhook(headers=HEADERS, raw_body=RAW))


def test_ec_e17_tampered_body_refused() -> None:
    with pytest.raises(WebhookSignatureError):
        asyncio.run(P.verify_webhook(headers=HEADERS, raw_body=RAW.replace("5000", "1"), received_at=AT))


def test_ec_e17_stale_at_receipt_refused() -> None:
    old = T - 3600
    raw = _body(old)
    with pytest.raises(WebhookSignatureError):
        asyncio.run(P.verify_webhook(headers={"stripe-signature": sign_stripe_payload(raw, SECRET, old)}, raw_body=raw))


def test_ec_e20_rotation_previous_secret_reverifies() -> None:
    new = StripeProvider(secret_key="sk_test_dummy", webhook_secret="whsec_rotated_new", previous_webhook_secrets=[SECRET])
    assert asyncio.run(new.verify_webhook(headers=HEADERS, raw_body=RAW, received_at=AT)).payment_ref == "in_e17"
    bare = StripeProvider(secret_key="sk_test_dummy", webhook_secret="whsec_rotated_new")
    with pytest.raises(WebhookSignatureError):
        asyncio.run(bare.verify_webhook(headers=HEADERS, raw_body=RAW, received_at=AT))
