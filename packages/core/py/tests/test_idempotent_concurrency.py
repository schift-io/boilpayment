"""Concurrent initial and failed retries may execute the operation only once."""
from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from boilpayment_core import (
    FixedClock,
    InMemoryRepo,
    PaymentKitError,
    hash_payload,
    run_idempotent,
)


def env():
    return InMemoryRepo(), FixedClock(datetime(2026, 1, 1, tzinfo=UTC))


def test_atomic_initial_and_failed_retry_claims():
    from boilpayment_core import Operation

    async def scenario(retry):
        repo, clock = env()
        key = f"race:{retry}"
        if retry:
            await repo.operations.put(Operation(id=key, key=key, kind="test", payload_hash=hash_payload({}), status="failed", result=None, error="retry", created_at=clock.now(), completed_at=clock.now(), attempts=1))
        original_get = repo.operations.get

        async def overlapping_get(key):
            snapshot = await original_get(key)
            await asyncio.sleep(0)
            return snapshot

        repo.operations.get = overlapping_get
        calls = 0
        gate = asyncio.Event()

        async def fn():
            nonlocal calls
            calls += 1
            await gate.wait()
            return "done"

        async def run():
            try:
                return await run_idempotent(repo=repo, clock=clock, key=key, kind="test", payload={}, fn=fn)
            except PaymentKitError as error:
                return error

        first, second = asyncio.create_task(run()), asyncio.create_task(run())
        for _ in range(10):
            await asyncio.sleep(0)
        gate.set()
        results = await asyncio.gather(first, second)
        assert calls == 1
        assert sum(isinstance(result, PaymentKitError) and result.code == "idempotency_in_progress" for result in results) == 1
        assert (await original_get(key)).attempts == (2 if retry else 1)

    asyncio.run(scenario(False))
    asyncio.run(scenario(True))
