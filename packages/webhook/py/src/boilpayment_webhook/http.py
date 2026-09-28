# HTTP adapter — framework-agnostic. See spec/webhook.pseudo.md.
# NOTE: ts has both create_node_handler and a Fetch-API (Request/Response) adapter;
# Fetch's Request/Response are JS/browser/Node-runtime types with no Python stdlib
# equivalent, so only the framework-agnostic handler is mirrored here. The kit ships no
# framework glue: INTEGRATION.md §3 lists what to pass (raw body, headers, socket address).
from __future__ import annotations

import dataclasses
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from boilpayment_core import Clock, PaymentProvider, Repo

from .receive import receive


@dataclass(kw_only=True, slots=True)
class HttpRequest:
    headers: dict[str, str]
    body: str


@dataclass(kw_only=True, slots=True)
class HttpResponse:
    status: int
    body: str


Handler = Callable[[HttpRequest], Awaitable[HttpResponse]]


def create_handler(*, provider: PaymentProvider, repo: Repo, clock: Clock) -> Handler:
    async def handler(req: HttpRequest) -> HttpResponse:
        result = await receive(
            provider=provider,
            headers=req.headers,
            raw_body=req.body,
            repo=repo,
            clock=clock,
        )
        return HttpResponse(
            status=result.status,
            body=json.dumps({k: v for k, v in dataclasses.asdict(result).items()}),
        )

    return handler
