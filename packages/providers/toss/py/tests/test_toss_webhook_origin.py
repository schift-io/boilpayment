"""[EC:E18] Toss webhooks carry no signature. The IP allowlist uses the connection address the app
passes (remote_address), never a client-sent header; a DEPOSIT_CALLBACK must carry the `secret`
Toss returned on that payment (re-fetched by orderId, compared in constant time)."""
from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime

import httpx
import pytest
from boilpayment_core import WebhookSignatureError
from test_toss import make_provider

DONE = json.dumps({"eventType": "PAYMENT_STATUS_CHANGED", "createdAt": "2026-01-01T00:00:00+09:00",
                   "data": {"paymentKey": "pk_1", "orderId": "o_1", "status": "DONE"}})


def _deposit(secret: str) -> str:
    return json.dumps({"eventType": "DEPOSIT_CALLBACK", "createdAt": "2026-01-01T00:00:00+09:00", "secret": secret, "status": "DONE",
                       "transactionKey": "tx_1", "orderId": "o_va", "data": {"paymentKey": "pk_va", "orderId": "o_va", "status": "DONE"}})


def _no_fetch(request: httpx.Request) -> httpx.Response:
    raise AssertionError(f"should not fetch {request.url}")


def _payment_with_secret(request: httpx.Request) -> httpx.Response:
    assert "/v1/payments/orders/o_va" in str(request.url)
    return httpx.Response(200, json={"paymentKey": "pk_va", "orderId": "o_va", "status": "DONE", "secret": "s3cr3t",
                                     "method": "가상계좌", "totalAmount": 1000, "currency": "KRW"})


def test_ec_e18_spoofed_header_does_not_pass_allowlist() -> None:
    p = make_provider(_no_fetch, allowed_webhook_ips=["203.0.113.10"])
    for kwargs in ({"remote_address": "198.51.100.9"}, {}):
        with pytest.raises(WebhookSignatureError):
            asyncio.run(p.verify_webhook(headers={"x-paykit-remote-ip": "203.0.113.10"}, raw_body=DONE, **kwargs))


def test_ec_e18_reverify_after_receipt_needs_no_address() -> None:
    p = make_provider(_no_fetch, allowed_webhook_ips=["203.0.113.10"])
    e = asyncio.run(p.verify_webhook(headers={}, raw_body=DONE, received_at=datetime.now(UTC)))
    assert e.type == "payment.succeeded"


def test_ec_e18_deposit_callback_secret() -> None:
    p = make_provider(_payment_with_secret, allowed_webhook_ips=["203.0.113.10"])
    src = "203.0.113.10"
    assert asyncio.run(p.verify_webhook(headers={}, raw_body=_deposit("s3cr3t"), remote_address=src)).type == "payment.succeeded"
    with pytest.raises(WebhookSignatureError):
        asyncio.run(p.verify_webhook(headers={}, raw_body=_deposit("guess"), remote_address=src))


def test_ec_e19_deposit_callback_without_secret_refused() -> None:
    p = make_provider(_payment_with_secret, allowed_webhook_ips=["203.0.113.10"])
    body = json.loads(_deposit("s3cr3t"))
    del body["secret"]
    with pytest.raises(WebhookSignatureError):
        asyncio.run(p.verify_webhook(headers={}, raw_body=json.dumps(body), remote_address="203.0.113.10"))


def test_ec_e22_allowlist_mapped_ipv6_and_cidr() -> None:
    p = make_provider(_no_fetch, allowed_webhook_ips=["13.124.18.147", "203.0.113.0/24", "2001:db8::/32"])

    def at(addr: str):
        return asyncio.run(p.verify_webhook(headers={}, raw_body=DONE, remote_address=addr))

    for ok in ("::ffff:13.124.18.147", "203.0.113.77", "::ffff:203.0.113.5", "2001:db8:1::5"):
        assert at(ok).type == "payment.succeeded"
    for bad in ("203.0.114.1", "13.124.18.148", "2001:db9::1", "not-an-ip"):
        with pytest.raises(WebhookSignatureError):
            at(bad)


def test_ec_e22_invalid_allowlist_entry_refused() -> None:
    for entry in ("203.0.113.0/40", "toss.example"):
        with pytest.raises(ValueError):
            make_provider(_no_fetch, allowed_webhook_ips=[entry])
