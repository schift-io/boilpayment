"""[EC:E17] process() re-verifies a stored body long after receipt: the Standard Webhooks
5-minute tolerance is judged at received_at, the HMAC is always checked."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import time
from datetime import UTC, datetime

import httpx
import pytest
from boilpayment_core import WebhookSignatureError
from boilpayment_portone import PortoneProvider, PortoneProviderConfig

SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"
BODY = json.dumps({"type": "Transaction.Paid", "timestamp": "2024-04-25T10:00:00.000Z", "data": {"paymentId": "pay_e17"}})


def _sign(id_: str, ts: str, body: str) -> str:
    key = base64.b64decode(SECRET.removeprefix("whsec_"))
    return "v1," + base64.b64encode(hmac.new(key, f"{id_}.{ts}.{body}".encode(), hashlib.sha256).digest()).decode()


T = int(time.time()) - 600
AT = datetime.fromtimestamp(T, tz=UTC)
HEADERS = {"webhook-id": "msg_e17", "webhook-timestamp": str(T), "webhook-signature": _sign("msg_e17", str(T), BODY)}


def _p():
    return PortoneProvider(PortoneProviderConfig(api_secret="test_sk_dummy", store_id="store_dummy", webhook_secret=SECRET), httpx.AsyncClient(base_url="https://api.portone.io", transport=httpx.MockTransport(lambda r: (_ for _ in ()).throw(AssertionError("no fetch")))))


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
