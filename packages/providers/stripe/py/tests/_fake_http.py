"""Test helper — replaces the stripe-python SDK's internal default HTTP client factory
(`stripe._stripe_client.new_default_http_client` / `new_http_client_async_fallback`) with a fake
`HTTPClient` subclass that never opens a socket.

Why this seam: `StripeProvider.__init__` builds `stripe.StripeClient(api_key=..., stripe_version=...,
base_addresses=...)` and does NOT pass through an `http_client=` kwarg, even though `StripeClient`
itself accepts one (confirmed by reading site-packages/stripe/_stripe_client.py). Since we must not
edit the provider under test, we intercept one layer up: `StripeClient.__init__` only calls
`new_default_http_client(...)` when `http_client is None`, and that name is imported directly into
the `stripe._stripe_client` module namespace at import time — so patching it there (not on
`stripe._http_client`, which the already-bound name in `_stripe_client` does not observe) makes every
subsequently-constructed `StripeClient` use our fake. This was verified empirically against
stripe-python 15.6.1 before writing the assertions in test_provider_http.py.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

import stripe._stripe_client as _stripe_client_module
from stripe._http_client import HTTPClient


@dataclass
class RecordedRequest:
    method: str
    url: str
    headers: dict[str, str]
    post_data: Any

    @property
    def path(self) -> str:
        return urlsplit(self.url).path

    @property
    def query(self) -> str:
        return urlsplit(self.url).query


class FakeHTTPClient(HTTPClient):
    name = "fake"

    def __init__(self) -> None:
        super().__init__()
        self.requests: list[RecordedRequest] = []
        self._queue: list[
            Callable[[RecordedRequest], tuple[bytes, int, dict[str, str]]]
        ] = []

    def queue_json(self, status_code: int, body: Any) -> None:
        payload = json.dumps(body).encode("utf-8")
        self._queue.append(
            lambda _req: (payload, status_code, {"content-type": "application/json"})
        )

    async def request_async(self, method, url, headers, post_data=None):
        recorded = RecordedRequest(
            method=method, url=url, headers=dict(headers), post_data=post_data
        )
        self.requests.append(recorded)
        if not self._queue:
            raise RuntimeError(f"FakeHTTPClient: no response queued for {method} {url}")
        responder = self._queue.pop(0)
        return responder(recorded)

    async def close_async(self) -> None:
        pass


@dataclass
class HttpMock:
    client: FakeHTTPClient
    _patches: list[tuple[Any, str, Any]] = field(default_factory=list)

    @property
    def requests(self) -> list[RecordedRequest]:
        return self.client.requests

    def respond_json(self, status_code: int, body: Any) -> None:
        self.client.queue_json(status_code, body)

    def restore(self) -> None:
        for target, name, original in self._patches:
            setattr(target, name, original)


def install_http_mock() -> HttpMock:
    client = FakeHTTPClient()
    patches: list[tuple[Any, str, Any]] = []
    for name in ("new_default_http_client", "new_http_client_async_fallback"):
        original = getattr(_stripe_client_module, name)
        patches.append((_stripe_client_module, name, original))
        setattr(_stripe_client_module, name, lambda *a, **k: client)
    return HttpMock(client=client, _patches=patches)
