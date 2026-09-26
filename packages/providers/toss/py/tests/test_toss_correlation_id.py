"""[EC:L5] TossProvider.with_correlation_id -- driven through an httpx.MockTransport, no network."""

from __future__ import annotations

import asyncio

import httpx
from boilpayment_core import CollectingLogger
from boilpayment_toss import TossProvider, TossProviderConfig


def run(coro):
    return asyncio.run(coro)


PAYMENT_FIXTURE = {
    "paymentKey": "pay_1",
    "orderId": "order_1",
    "status": "DONE",
    "totalAmount": 1000,
    "currency": "KRW",
    "approvedAt": "2026-01-01T00:00:00+09:00",
}


def make_provider(logger, *, correlation_id=None) -> TossProvider:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=PAYMENT_FIXTURE)

    client = httpx.AsyncClient(
        base_url="https://api.tosspayments.com", transport=httpx.MockTransport(handler)
    )
    return TossProvider(
        TossProviderConfig(
            secret_key="sk_test", logger=logger, correlation_id=correlation_id
        ),
        client,
    )


def test_with_correlation_id_overrides_the_logged_correlation_id():
    async def scenario():
        logger = CollectingLogger()
        provider = make_provider(logger)

        await provider.get_payment("pay_default")
        default_entry = next(
            e for e in logger.entries if e["event"] == "provider.request"
        )
        assert not default_entry.get(
            "correlationId"
        )  # get_payment is a GET, no idempotency_key

        scoped = provider.with_correlation_id("corr_evt_123")
        await scoped.get_payment("pay_scoped")
        scoped_entry = [e for e in logger.entries if e["event"] == "provider.request"][
            -1
        ]
        assert scoped_entry["correlationId"] == "corr_evt_123"

        # original instance unaffected by the clone
        await provider.get_payment("pay_default_2")
        still_default = [e for e in logger.entries if e["event"] == "provider.request"][
            -1
        ]
        assert not still_default.get("correlationId")

    run(scenario())


def test_config_correlation_id_is_used_directly():
    async def scenario():
        logger = CollectingLogger()
        provider = make_provider(logger, correlation_id="corr_from_config")
        await provider.get_payment("pay_1")
        entry = next(e for e in logger.entries if e["event"] == "provider.request")
        assert entry["correlationId"] == "corr_from_config"

    run(scenario())
