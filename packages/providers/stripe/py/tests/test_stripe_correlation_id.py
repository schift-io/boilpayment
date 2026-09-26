"""[EC:L5] StripeProvider.with_correlation_id -- unit test directly against `_LoggingHTTPClient`
(the actual carrier of correlationId for stripe's `provider.request` log lines), since driving it
through the full StripeClient SDK requires the elaborate _fake_http.py monkeypatch seam used
elsewhere in this package. `correlation_id_override`, when set, wins over the per-request
Idempotency-Key header; unset falls back to the header, unchanged from before.
"""

from __future__ import annotations

import asyncio

from schift_payment_kit_core import CollectingLogger
from schift_payment_kit_stripe import _LoggingHTTPClient


def run(coro):
    return asyncio.run(coro)


class _FakeInner:
    async def request_with_retries_async(
        self,
        method,
        url,
        headers,
        post_data=None,
        max_network_retries=None,
        *,
        _usage=None,
    ):
        return b'{"id":"x"}', 200, {}


def test_correlation_id_override_wins_over_idempotency_key_header():
    async def scenario():
        logger = CollectingLogger()
        client = _LoggingHTTPClient(
            _FakeInner(), logger, correlation_id_override="corr_evt_123"
        )
        await client.request_with_retries_async(
            "POST",
            "https://api.stripe.com/v1/customers",
            {"Idempotency-Key": "idem_should_be_overridden"},
        )
        entry = next(e for e in logger.entries if e["event"] == "provider.request")
        assert entry["correlationId"] == "corr_evt_123"

    run(scenario())


def test_no_override_falls_back_to_idempotency_key_header():
    async def scenario():
        logger = CollectingLogger()
        client = _LoggingHTTPClient(_FakeInner(), logger)
        await client.request_with_retries_async(
            "POST",
            "https://api.stripe.com/v1/customers",
            {"Idempotency-Key": "idem_abc"},
        )
        entry = next(e for e in logger.entries if e["event"] == "provider.request")
        assert entry["correlationId"] == "idem_abc"

    run(scenario())


def test_with_correlation_id_reconstructs_a_new_provider_leaving_the_original_untouched():
    from schift_payment_kit_stripe import StripeProvider

    original = StripeProvider(secret_key="sk_test_dummy", webhook_secret="whsec_x")
    scoped = original.with_correlation_id("corr_evt_456")
    assert scoped is not original
    assert isinstance(scoped, StripeProvider)
