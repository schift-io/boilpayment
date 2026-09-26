"""EC:A52 (round-5 audit A5-5) -- only PortOne PAYMENT_NOT_FOUND means the order does not exist."""

from __future__ import annotations

import asyncio

import httpx
import pytest
from boilpayment_core import ProviderError
from boilpayment_portone import PortoneProvider, PortoneProviderConfig


def make(status: int, body: str, content_type: str = "application/json") -> PortoneProvider:
    transport = httpx.MockTransport(lambda req: httpx.Response(status, content=body.encode(), headers={"content-type": content_type}))
    client = httpx.AsyncClient(base_url="https://api.portone.io", transport=transport)
    return PortoneProvider(PortoneProviderConfig(api_secret="s", store_id="st", webhook_secret="whsec_c2VjcmV0", scheduling="self"), client)


def test_payment_not_found_is_none() -> None:
    assert asyncio.run(make(404, '{"type":"PAYMENT_NOT_FOUND","message":"x"}').get_payment_by_order_id("ord_1")) is None


def test_html_404_is_an_error() -> None:
    with pytest.raises(ProviderError):
        asyncio.run(make(404, "<html>Not Found</html>", "text/html").get_payment_by_order_id("ord_1"))


def test_other_json_404_is_an_error() -> None:
    with pytest.raises(ProviderError):
        asyncio.run(make(404, '{"type":"NOT_FOUND","message":"no route"}').get_payment_by_order_id("ord_1"))
