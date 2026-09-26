"""[EC:L5] PortoneProvider.with_correlation_id -- driven through an httpx.MockTransport, no network.
PortOne's `_request` has no per-call idempotency_key at all (unlike the other 3 providers), so
before this change every portone `provider.request` log line had no correlationId whatsoever.
"""

from __future__ import annotations

import asyncio

import httpx
from schift_payment_kit_core import CollectingLogger
from schift_payment_kit_portone import PortoneProvider, PortoneProviderConfig

PAYMENT_FIXTURE = {
    "id": "pay_1",
    "status": "PAID",
    "amount": {"total": 1000},
    "currency": "KRW",
    "paidAt": "2026-01-01T00:00:00+09:00",
}


def run(coro):
    return asyncio.run(coro)


def make_provider(logger, *, correlation_id=None) -> PortoneProvider:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=PAYMENT_FIXTURE)

    client = httpx.AsyncClient(
        base_url="https://api.portone.io", transport=httpx.MockTransport(handler)
    )
    return PortoneProvider(
        PortoneProviderConfig(
            api_secret="secret",
            store_id="store_1",
            webhook_secret="whsec_x",
            logger=logger,
            correlation_id=correlation_id,
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
        assert default_entry.get("correlationId") is None

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
        assert still_default.get("correlationId") is None

    run(scenario())
