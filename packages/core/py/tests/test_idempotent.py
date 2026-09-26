"""Regression tests for run_idempotent / hash_payload.
spec: packages/core/spec/core.pseudo.md [EC:J1 J2 J3 J4 J5]

pytest-asyncio is not installed here: every test wraps its async body with asyncio.run(...).
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from schift_payment_kit_core import (
    FixedClock,
    InMemoryRepo,
    PaymentKitError,
    hash_payload,
    run_idempotent,
    stable_stringify,
)


def env():
    repo = InMemoryRepo()
    clock = FixedClock(datetime(2026, 1, 1, tzinfo=UTC))
    return repo, clock


def test_hash_payload_insensitive_to_key_order():
    assert hash_payload({"a": 1, "b": 2}) == hash_payload({"b": 2, "a": 1})


def test_hash_payload_sensitive_to_value_changes():
    assert hash_payload({"a": 1}) != hash_payload({"a": 2})


def test_stable_stringify_converts_datetime_to_iso():
    assert (
        stable_stringify(datetime(2026, 1, 1, tzinfo=UTC))
        == '"2026-01-01T00:00:00+00:00"'
    )


def test_j1_same_key_same_payload_retry_replays_first_result_without_rerunning_fn():
    async def run():
        repo, clock = env()
        calls = 0

        async def fn():
            nonlocal calls
            calls += 1
            return {"n": calls}

        async def do_run():
            return await run_idempotent(
                repo=repo,
                clock=clock,
                key="op:1",
                kind="test.op",
                payload={"a": 1},
                fn=fn,
            )

        first = await do_run()
        second = await do_run()

        assert first.result == {"n": 1}
        assert first.replayed is False
        assert second.result == {"n": 1}  # replayed, not a fresh execution
        assert second.replayed is True
        assert calls == 1

    asyncio.run(run())


def test_j2_same_key_different_payload_raises_idempotency_key_reused():
    async def run():
        repo, clock = env()
        await run_idempotent(
            repo=repo,
            clock=clock,
            key="op:2",
            kind="test.op",
            payload={"a": 1},
            fn=lambda: _const("x"),
        )
        try:
            await run_idempotent(
                repo=repo,
                clock=clock,
                key="op:2",
                kind="test.op",
                payload={"a": 2},
                fn=lambda: _const("y"),
            )
            raise AssertionError("expected idempotency_key_reused")
        except PaymentKitError as err:
            assert err.code == "idempotency_key_reused"

    asyncio.run(run())


def test_j3_second_call_while_first_in_progress_raises_idempotency_in_progress():
    async def run():
        repo, clock = env()
        gate = asyncio.Event()

        async def slow_fn():
            await gate.wait()
            return "done"

        task = asyncio.create_task(
            run_idempotent(
                repo=repo,
                clock=clock,
                key="op:3",
                kind="test.op",
                payload={},
                fn=slow_fn,
            )
        )
        # let the first call get past repo.operations.put(in_progress) before racing the second
        await asyncio.sleep(0)
        await asyncio.sleep(0)

        try:
            await run_idempotent(
                repo=repo,
                clock=clock,
                key="op:3",
                kind="test.op",
                payload={},
                fn=lambda: _const("other"),
            )
            raise AssertionError("expected idempotency_in_progress")
        except PaymentKitError as err:
            assert err.code == "idempotency_in_progress"

        gate.set()
        result = await task
        assert result.result == "done"

    asyncio.run(run())


def test_failed_status_allows_rerun_and_can_then_succeed_and_be_replayed():
    async def run():
        repo, clock = env()
        attempt = 0

        async def fn():
            nonlocal attempt
            attempt += 1
            if attempt == 1:
                raise RuntimeError("boom")
            return {"attempt": attempt}

        async def do_run():
            return await run_idempotent(
                repo=repo,
                clock=clock,
                key="op:4",
                kind="test.op",
                payload={"a": 1},
                fn=fn,
            )

        try:
            await do_run()
            raise AssertionError("expected boom")
        except RuntimeError as err:
            assert str(err) == "boom"

        second = await do_run()  # failed -> re-run allowed
        assert second.result == {"attempt": 2}
        assert second.replayed is False

        third = await do_run()  # now done -> replayed
        assert third.result == {"attempt": 2}
        assert third.replayed is True
        assert attempt == 2

    asyncio.run(run())


def test_serialize_deserialize_round_trips_a_custom_result_shape_datetime_fields_survive():
    async def run():
        repo, clock = env()
        when = datetime(2026, 2, 2, tzinfo=UTC)

        async def do_run():
            return await run_idempotent(
                repo=repo,
                clock=clock,
                key="op:5",
                kind="test.op",
                payload={},
                serialize=lambda r: {"when": r["when"].isoformat()},
                deserialize=lambda v: {"when": datetime.fromisoformat(v["when"])},
                fn=lambda: _const({"when": when}),
            )

        await do_run()
        second = await do_run()
        assert isinstance(second.result["when"], datetime)
        assert second.result["when"] == when

    asyncio.run(run())


async def _const(value):
    return value


# EC:I9 finding (2026-09-09, cs.timeline) -- a replay used to leave the stored Operation row
# untouched, so an operation retried 5 times (all replays) and one executed exactly once looked
# identical in storage.
def test_attempts_starts_at_1_on_first_execution_and_increments_on_every_replay():
    async def run():
        repo, clock = env()

        async def do_run():
            return await run_idempotent(
                repo=repo,
                clock=clock,
                key="op:attempts",
                kind="test.op",
                payload={"a": 1},
                fn=lambda: _const({"ok": True}),
            )

        first = await do_run()
        assert first.replayed is False
        stored = await repo.operations.get("op:attempts")
        assert stored.attempts == 1

        await do_run()
        await do_run()
        third = await do_run()
        assert third.replayed is True
        stored = await repo.operations.get("op:attempts")
        assert stored.attempts == 4  # 1 execution + 3 replays

    asyncio.run(run())


def test_attempts_also_increments_across_a_failed_retried_succeeded_sequence():
    async def run():
        repo, clock = env()
        attempt = 0

        async def fn():
            nonlocal attempt
            attempt += 1
            if attempt == 1:
                raise RuntimeError("boom")
            return {"attempt": attempt}

        async def do_run():
            return await run_idempotent(
                repo=repo,
                clock=clock,
                key="op:attempts-retry",
                kind="test.op",
                payload={"a": 1},
                fn=fn,
            )

        try:
            await do_run()
            raise AssertionError("expected boom")
        except RuntimeError:
            pass
        stored = await repo.operations.get("op:attempts-retry")
        assert stored.attempts == 1

        await do_run()  # failed -> re-run, a genuine second attempt
        stored = await repo.operations.get("op:attempts-retry")
        assert stored.attempts == 2

        await do_run()  # now done -> replay, a third attempt
        stored = await repo.operations.get("op:attempts-retry")
        assert stored.attempts == 3

    asyncio.run(run())
