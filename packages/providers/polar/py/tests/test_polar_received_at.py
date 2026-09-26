"""[EC:E17] process() re-verifies a stored body long after receipt: the Standard Webhooks
5-minute tolerance is judged at received_at, the HMAC is always checked."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import time
from datetime import datetime, timezone

import pytest
from boilpayment_core import WebhookSignatureError
from boilpayment_polar import PolarProvider

SECRET = "whsec_c2VjcmV0a2V5Zm9ycG9sYXJ0ZXN0"
BODY = json.dumps({"type": "order.paid", "timestamp": "2024-01-01T00:00:00.000Z", "data": {"id": "order_e17", "customer_id": "c1", "subscription_id": "s1", "total_amount": 5000, "currency": "krw", "status": "paid", "paid": True, "created_at": "2024-01-01T00:00:00.000Z"}})


def _sign(id_: str, ts: str, body: str) -> str:
    key = base64.b64decode(SECRET.removeprefix("whsec_"))
    return "v1," + base64.b64encode(hmac.new(key, f"{id_}.{ts}.{body}".encode(), hashlib.sha256).digest()).decode()


T = int(time.time()) - 600
AT = datetime.fromtimestamp(T, tz=timezone.utc)
HEADERS = {"webhook-id": "msg_e17", "webhook-timestamp": str(T), "webhook-signature": _sign("msg_e17", str(T), BODY)}


def _p():
    return PolarProvider(access_token="polar_at_dummy", webhook_secret=SECRET, server="sandbox")


def test_ec_e17_fresh_at_receipt_verifies_later() -> None:
    e = asyncio.run(_p().verify_webhook(headers=HEADERS, raw_body=BODY, received_at=AT))
    assert e.id


def test_ec_e17_without_received_at_old_timestamp_refused() -> None:
    with pytest.raises(WebhookSignatureError):
        asyncio.run(_p().verify_webhook(headers=HEADERS, raw_body=BODY))


def test_ec_e17_tampered_body_refused() -> None:
    with pytest.raises(WebhookSignatureError):
        asyncio.run(_p().verify_webhook(headers=HEADERS, raw_body=BODY.replace("5000", "1").replace("pay_e17", "pay_x"), received_at=AT))


def test_ec_e17_stale_at_receipt_refused() -> None:
    old = str(T - 3600)
    h = {"webhook-id": "msg_e17", "webhook-timestamp": old, "webhook-signature": _sign("msg_e17", old, BODY)}
    with pytest.raises(WebhookSignatureError):
        asyncio.run(_p().verify_webhook(headers=h, raw_body=BODY, received_at=AT))
