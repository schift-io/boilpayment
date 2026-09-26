"""EC:A52 (round-5 audit A5-5) -- only Toss NOT_FOUND_PAYMENT means the order does not exist."""

from __future__ import annotations

import asyncio

import httpx
import pytest
from boilpayment_core import ProviderError
from boilpayment_toss import TossProvider, TossProviderConfig


def make(status: int, body: str, content_type: str = "application/json") -> TossProvider:
    transport = httpx.MockTransport(lambda req: httpx.Response(status, content=body.encode(), headers={"content-type": content_type}))
    client = httpx.AsyncClient(base_url="https://api.tosspayments.com", transport=transport)
    return TossProvider(TossProviderConfig(secret_key="test_sk_x", allowed_webhook_ips=["1.1.1.1"]), client)


def test_not_found_payment_is_none() -> None:
    assert asyncio.run(make(404, '{"code":"NOT_FOUND_PAYMENT","message":"x"}').get_payment_by_order_id("ord_1")) is None


def test_html_404_is_an_error() -> None:
    with pytest.raises(ProviderError):
        asyncio.run(make(404, "<html>Not Found</html>", "text/html").get_payment_by_order_id("ord_1"))


def test_other_json_404_is_an_error() -> None:
    with pytest.raises(ProviderError):
        asyncio.run(make(404, '{"code":"NOT_FOUND","message":"no route"}').get_payment_by_order_id("ord_1"))
