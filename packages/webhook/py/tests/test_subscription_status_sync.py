"""[EC:A27] subscription.updated moves a local subscription into / out of paused and incomplete from
the provider's re-fetched status; other transitions stay with their own handlers."""
from __future__ import annotations

import asyncio
import dataclasses
import json
from datetime import UTC, datetime

from _helpers import FakeProvider, json_verify
from boilpayment_core import (
    DEFAULT_POLICY,
    CollectingNotifier,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    Period,
    SequentialIdGen,
    Subscription,
)
from boilpayment_webhook import default_handlers, process, receive


def _setup(local: str):
    clock = FixedClock(datetime(2026, 3, 1, 0, 5, tzinfo=UTC))
    repo = InMemoryRepo()
    sub = Subscription(id="sub_local", customer_id="cust_1", plan_id="plan_pro", provider="stripe", provider_ref="sub_123",
                       status=local, current_period=Period(start=datetime(2026, 2, 1, tzinfo=UTC), end=datetime(2026, 3, 1, tzinfo=UTC)),
                       anchor_day=1, cancel_at_period_end=False, grace_until=None, billing_key=None, scheduled_plan_id=None,
                       created_at=clock.now())
    remote = {"status": "active"}
    provider = FakeProvider(verify=json_verify("stripe"), get_subscription_impl=lambda ref: dataclasses.replace(sub, status=remote["status"]))
    handlers = default_handlers(policy=DEFAULT_POLICY, ledger=InMemoryLedger(SequentialIdGen("led_")), repo=repo,
                                notifier=CollectingNotifier(), clock=clock, ids=SequentialIdGen("pay_"))
    n = {"i": 0}

    async def deliver(status: str):
        remote["status"] = status
        n["i"] += 1
        raw = json.dumps({"id": f"evt_{n['i']}", "type": "subscription.updated", "occurredAt": clock.now().isoformat(),
                          "customerRef": "cus_1", "subscriptionRef": "sub_123", "paymentRef": None})
        r = await receive(provider=provider, headers={"x-sig": "ok"}, raw_body=raw, repo=repo, clock=clock)
        await process(event_id=r.event_id, providers={"stripe": provider}, handlers=handlers, repo=repo, clock=clock)
        s = await repo.subscriptions.get("sub_local")
        return s.status if s else None

    return repo, sub, deliver


def test_ec_a27_pause_and_resume() -> None:
    async def run():
        repo, sub, deliver = _setup("active")
        await repo.subscriptions.put(sub)
        return [await deliver("paused"), await deliver("active")]

    assert asyncio.run(run()) == ["paused", "active"]


def test_ec_a27_incomplete_to_active_and_past_due_left_alone() -> None:
    async def run():
        repo, sub, deliver = _setup("incomplete")
        await repo.subscriptions.put(sub)
        first = await deliver("active")
        repo2, sub2, deliver2 = _setup("past_due")
        await repo2.subscriptions.put(sub2)
        return first, await deliver2("active")

    assert asyncio.run(run()) == ("active", "past_due")


def test_ec_a27_unknown_subscription_noop() -> None:
    async def run():
        _, _, deliver = _setup("active")
        return await deliver("paused")

    assert asyncio.run(run()) is None
