"""Notification delivery isolates child failures without leaking unawaited coroutines."""

from __future__ import annotations

import asyncio

from boilpayment_core import CollectingNotifier, Notification
from boilpayment_notify import composite

NOTIFICATION = Notification(
    type="usage.soft_cap",
    customer_id="cust_1",
    payload={"meter": "api_call", "overage": 2, "included": 5},
)


class RejectingAsyncNotifier:
    """A conforming (async def) notifier whose coroutine raises when awaited -- the shape a real
    adapter would never produce (adapters never raise), but which asyncio.gather is meant to
    defend against."""

    def __init__(self, message: str) -> None:
        self._message = message

    async def send(self, n: Notification) -> None:
        raise RuntimeError(self._message)


class SyncRaisingNotifier:
    """NOT an async def: raises immediately when .send() is called, before returning a
    coroutine/awaitable at all."""

    def __init__(self, message: str) -> None:
        self._message = message

    def send(self, n: Notification):
        raise RuntimeError(self._message)


def test_notify_composite_swallows_child_throw_rejecting_coroutines_never_block_delivery():
    async def run():
        collecting = CollectingNotifier()
        fan_out = composite(
            [
                collecting,
                RejectingAsyncNotifier("boom-a"),
                RejectingAsyncNotifier("boom-b"),
            ]
        )
        await fan_out.send(NOTIFICATION)
        return collecting

    collecting = asyncio.run(run())
    assert collecting.sent == [NOTIFICATION]


def test_notify_composite_swallows_child_throw_non_raising_children_still_receive_notification():
    async def run():
        first = CollectingNotifier()
        second = CollectingNotifier()
        fan_out = composite([first, RejectingAsyncNotifier("boom"), second])
        await fan_out.send(NOTIFICATION)
        return first, second

    first, second = asyncio.run(run())
    assert first.sent == [NOTIFICATION]
    assert second.sent == [NOTIFICATION]


def test_notify_composite_isolates_synchronous_failure_after_healthy_child():
    async def run():
        collecting = CollectingNotifier()
        fan_out = composite([collecting, SyncRaisingNotifier("sync-raise")])
        await fan_out.send(NOTIFICATION)
        return collecting

    collecting = asyncio.run(run())
    assert collecting.sent == [NOTIFICATION]


def test_notify_composite_delivers_after_synchronous_failure():
    async def run():
        collecting = CollectingNotifier()
        fan_out = composite([SyncRaisingNotifier("sync-raise"), collecting])
        await fan_out.send(NOTIFICATION)
        return collecting

    collecting = asyncio.run(run())
    assert collecting.sent == [NOTIFICATION]
