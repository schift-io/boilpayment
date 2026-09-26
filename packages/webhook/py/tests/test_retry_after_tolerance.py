"""[EC:E17] A webhook received fresh and retried long after the provider's timestamp tolerance
still processes. The stored body is re-verified (a tampered row fails), freshness is judged at
received_at."""
from __future__ import annotations

import asyncio
import dataclasses
import json
from datetime import UTC, datetime

from boilpayment_core import FixedClock, InMemoryRepo, NormalizedEvent, WebhookSignatureError
from boilpayment_webhook import process, process_pending, receive


class TolerantProvider:
    name = "stripe"

    def __init__(self, clock: FixedClock) -> None:
        self._clock = clock

    def capabilities(self):  # noqa: ANN201 -- only the name matters here
        return None

    async def verify_webhook(self, *, headers, raw_body, received_at=None) -> NormalizedEvent:
        parsed = json.loads(raw_body)
        if headers.get("x-sig") != f"sig:{parsed['id']}:{parsed['amount']}":
            raise WebhookSignatureError("bad signature")
        ref = (received_at or self._clock.now()).timestamp() * 1000
        if abs(ref - int(headers["x-ts"])) > 300_000:
            raise WebhookSignatureError("webhook timestamp outside 5-minute tolerance")
        return NormalizedEvent(id=parsed["id"], provider="stripe", type="unknown", occurred_at=self._clock.now(),
                               customer_ref=None, subscription_ref=None, payment_ref=None, amount=None, raw=parsed)


def _setup():
    clock = FixedClock(datetime(2026, 9, 27, tzinfo=UTC))
    return clock, InMemoryRepo(), TolerantProvider(clock)


def test_ec_e17_retry_ten_minutes_later_processes() -> None:
    async def run():
        clock, repo, provider = _setup()
        ts = str(int(clock.now().timestamp() * 1000))
        r = await receive(provider=provider, headers={"x-sig": "sig:evt_1:100", "x-ts": ts},
                          raw_body=json.dumps({"id": "evt_1", "amount": 100}), repo=repo, clock=clock)
        calls = []

        async def fail(ctx):
            calls.append(1)
            raise RuntimeError("not yet")

        async def ok(ctx):
            calls.append(2)

        await process(event_id=r.event_id, providers={"stripe": provider}, handlers={"unknown": fail}, repo=repo, clock=clock)
        clock.advance(10 * 60_000)
        res = await process_pending(repo=repo, providers={"stripe": provider}, handlers={"unknown": ok}, clock=clock)
        rec = await repo.webhook_events.get(r.event_id)
        return rec.status, rec.error, res.processed, calls

    assert asyncio.run(run()) == ("processed", None, 1, [1, 2])


def test_ec_e17_tampered_stored_body_rejected() -> None:
    async def run():
        clock, repo, provider = _setup()
        ts = str(int(clock.now().timestamp() * 1000))
        r = await receive(provider=provider, headers={"x-sig": "sig:evt_2:100", "x-ts": ts},
                          raw_body=json.dumps({"id": "evt_2", "amount": 100}), repo=repo, clock=clock)
        rec = await repo.webhook_events.get(r.event_id)
        await repo.webhook_events.put(dataclasses.replace(rec, raw_body=json.dumps({"id": "evt_2", "amount": 999999})))
        clock.advance(10 * 60_000)
        calls = []

        async def ok(ctx):
            calls.append(1)

        await process(event_id=r.event_id, providers={"stripe": provider}, handlers={"unknown": ok}, repo=repo, clock=clock)
        after = await repo.webhook_events.get(r.event_id)
        return after.status, after.error, calls

    assert asyncio.run(run()) == ("failed", "bad signature", [])
