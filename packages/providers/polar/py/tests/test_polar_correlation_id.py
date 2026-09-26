"""[EC:L5] PolarProvider.with_correlation_id -- driven through a monkeypatched httpx.AsyncClient
(same seam as test_http.py in this package: PolarProvider._request() builds a fresh AsyncClient
per call with no constructor-level injection, so httpx.AsyncClient itself is monkeypatched onto an
httpx.MockTransport). No real network call is made anywhere in this file.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest
from schift_payment_kit_core import CollectingLogger
from schift_payment_kit_polar import PolarProvider


def run(coro):
    return asyncio.run(coro)


class _Recorder:
    def __init__(self) -> None:
        self._responses: list[httpx.Response] = []

    def queue(self, response: httpx.Response) -> None:
        self._responses.append(response)

    def handler(self, request: httpx.Request) -> httpx.Response:
        if not self._responses:
            raise AssertionError(
                f"no queued response for {request.method} {request.url.path}"
            )
        return self._responses.pop(0)


@pytest.fixture
def recorder(monkeypatch: pytest.MonkeyPatch) -> _Recorder:
    rec = _Recorder()
    transport = httpx.MockTransport(rec.handler)
    real_async_client = httpx.AsyncClient

    def patched(*args, **kwargs):
        kwargs["transport"] = transport
        return real_async_client(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", patched)
    return rec


def json_response(body: object, status: int = 200) -> httpx.Response:
    return httpx.Response(status, json=body)


def test_with_correlation_id_overrides_the_logged_correlation_id(recorder: _Recorder):
    async def scenario():
        logger = CollectingLogger()
        provider = PolarProvider(
            access_token="polar_at_dummy",
            webhook_secret="whsec_x",
            server="sandbox",
            logger=logger,
        )

        recorder.queue(json_response({"id": "cust_default"}))
        await provider.create_customer(email="a@example.com")
        default_entry = next(
            e for e in logger.entries if e["event"] == "provider.request"
        )
        assert not default_entry.get(
            "correlationId"
        )  # create_customer sends no Idempotency-Key

        scoped = provider.with_correlation_id("corr_evt_123")
        recorder.queue(json_response({"id": "cust_scoped"}))
        await scoped.create_customer(email="b@example.com")
        scoped_entry = [e for e in logger.entries if e["event"] == "provider.request"][
            -1
        ]
        assert scoped_entry["correlationId"] == "corr_evt_123"

        # original instance unaffected by the clone
        recorder.queue(json_response({"id": "cust_default_2"}))
        await provider.create_customer(email="c@example.com")
        still_default = [e for e in logger.entries if e["event"] == "provider.request"][
            -1
        ]
        assert not still_default.get("correlationId")

    run(scenario())
