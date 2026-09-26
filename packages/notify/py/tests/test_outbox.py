"""Phase 6 regression tests -- with_outbox() enqueue + flush_notify_outbox() delivery/retry.
Ground truth measured this session via packages/notify/py/examples/smoke.py:
  [with_outbox] enqueued: 1 collecting.sent still: 1   (one with_outbox.send() enqueues a
    pending row; it does NOT call the wrapped notifier directly -- collecting.sent is
    unaffected by the with_outbox call itself)
  [flush_notify_outbox] {"sent": 1, "failed": 0, "retried": 0}
  [with_outbox] pending after flush: 0 collecting.sent now: 2   (flush delivers the queued
    item to the real notifier, moving collecting.sent from 1 -> 2, and the outbox has 0
    pending afterward)

pytest-asyncio is not installed: every async body runs via asyncio.run() inside a sync
`def test_...():` function.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from schift_payment_kit_core import (
    CollectingNotifier,
    FixedClock,
    InMemoryRepo,
    Notification,
)
from schift_payment_kit_notify import flush_notify_outbox, with_outbox

NOTIFICATION = Notification(
    type="usage.soft_cap",
    customer_id="cust_1",
    payload={"meter": "api_call", "overage": 2, "included": 5},
)


class FailingNotifier:
    """Defense-in-depth path in flush_notify_outbox is only reachable via a non-conforming
    notifier (real adapters here never raise, per spec/notify.pseudo.md). This double exists
    purely to exercise that retry/attempts logic, which is otherwise dead code against
    conforming notifiers."""

    def __init__(self) -> None:
        self.calls = 0

    async def send(self, n: Notification) -> None:
        self.calls += 1
        raise RuntimeError("notifier failure (test double)")


def test_notify_outbox_enqueue_flush_send_enqueues_pending_row_without_calling_wrapped_notifier():
    async def run():
        repo = InMemoryRepo()
        collecting = CollectingNotifier()
        durable = with_outbox(collecting, repo)
        await durable.send(NOTIFICATION)
        pending = await repo.outbox.list(kind="notify", status="pending")
        return collecting, pending

    collecting, pending = asyncio.run(run())

    assert collecting.sent == []  # not delivered directly
    assert len(pending) == 1
    row = pending[0]
    assert row.kind == "notify"
    assert row.status == "pending"
    assert row.attempts == 0
    assert row.payload == {"notification": NOTIFICATION}
    assert isinstance(row.id, str) and len(row.id) > 0
    assert isinstance(row.created_at, datetime)
    assert isinstance(row.next_attempt_at, datetime)


def test_notify_outbox_enqueue_flush_delivers_queued_item_pending_to_sent_clears_pending():
    async def run():
        repo = InMemoryRepo()
        collecting = CollectingNotifier()
        durable = with_outbox(collecting, repo)
        clock = FixedClock(datetime(2027, 1, 1, tzinfo=UTC))

        await durable.send(NOTIFICATION)
        result = await flush_notify_outbox(repo=repo, notifier=collecting, clock=clock)
        pending_after = await repo.outbox.list(kind="notify", status="pending")
        sent_rows = await repo.outbox.list(kind="notify", status="sent")
        return collecting, result, pending_after, sent_rows

    collecting, result, pending_after, sent_rows = asyncio.run(run())

    assert (result.sent, result.failed, result.retried) == (1, 0, 0)
    assert collecting.sent == [NOTIFICATION]
    assert pending_after == []
    assert len(sent_rows) == 1
    assert sent_rows[0].attempts == 0  # success path never increments attempts


def test_notify_outbox_enqueue_flush_direct_send_and_outbox_send_are_independent_until_flush():
    async def run():
        repo = InMemoryRepo()
        collecting = CollectingNotifier()
        durable = with_outbox(collecting, repo)
        clock = FixedClock(datetime(2027, 1, 1, tzinfo=UTC))

        await durable.send(NOTIFICATION)  # enqueues only
        await collecting.send(NOTIFICATION)  # direct call, bypasses outbox
        after_direct = len(collecting.sent)
        pending_before = await repo.outbox.list(kind="notify", status="pending")

        await flush_notify_outbox(repo=repo, notifier=collecting, clock=clock)
        after_flush = len(collecting.sent)
        return after_direct, pending_before, after_flush

    after_direct, pending_before, after_flush = asyncio.run(run())

    assert after_direct == 1  # only the direct call landed so far
    assert len(pending_before) == 1
    assert after_flush == 2  # flush delivered the queued item too


def test_notify_outbox_enqueue_flush_failure_leaves_row_retryable_pending_attempts_incremented():
    async def run():
        repo = InMemoryRepo()
        collecting = CollectingNotifier()
        durable = with_outbox(collecting, repo)
        clock = FixedClock(datetime(2027, 1, 1, tzinfo=UTC))
        failing = FailingNotifier()

        await durable.send(NOTIFICATION)
        result = await flush_notify_outbox(
            repo=repo, notifier=failing, clock=clock, max_attempts=8
        )
        pending = await repo.outbox.list(kind="notify", status="pending")

        # A flush before next_attempt_at is reached must not retry the row again.
        result_too_soon = await flush_notify_outbox(
            repo=repo, notifier=failing, clock=clock, max_attempts=8
        )

        return failing, result, pending, result_too_soon, clock

    failing, result, pending, result_too_soon, clock = asyncio.run(run())

    assert (result.sent, result.failed, result.retried) == (0, 0, 1)
    assert failing.calls == 1
    assert len(pending) == 1
    assert pending[0].attempts == 1
    assert pending[0].next_attempt_at > clock.now()

    assert (result_too_soon.sent, result_too_soon.failed, result_too_soon.retried) == (
        0,
        0,
        0,
    )
    assert failing.calls == 1


def test_notify_outbox_enqueue_flush_row_exhausting_max_attempts_is_marked_failed():
    async def run():
        repo = InMemoryRepo()
        collecting = CollectingNotifier()
        durable = with_outbox(collecting, repo)
        failing = FailingNotifier()
        clock = FixedClock(datetime(2027, 1, 1, tzinfo=UTC))

        await durable.send(NOTIFICATION)

        # max_attempts=1 -> the very first failed attempt reaches the limit and is marked failed.
        result = await flush_notify_outbox(
            repo=repo, notifier=failing, clock=clock, max_attempts=1
        )
        failed_rows = await repo.outbox.list(kind="notify", status="failed")
        pending = await repo.outbox.list(kind="notify", status="pending")

        # Once failed, the row is not picked up by list(status="pending") again -> no further retry.
        second_flush = await flush_notify_outbox(
            repo=repo, notifier=failing, clock=clock, max_attempts=1
        )

        return failing, result, failed_rows, pending, second_flush

    failing, result, failed_rows, pending, second_flush = asyncio.run(run())

    assert (result.sent, result.failed, result.retried) == (0, 1, 0)
    assert len(failed_rows) == 1
    assert failed_rows[0].attempts == 1
    assert pending == []
    assert (second_flush.sent, second_flush.failed, second_flush.retried) == (0, 0, 0)
    assert failing.calls == 1
