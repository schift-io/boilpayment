"""Separate repository clients must acquire only one persisted execution."""
from __future__ import annotations

import asyncio
from datetime import UTC, datetime

import pytest
from db_helper import create_test_db, drop_test_db
from schift_payment_kit_core import (
    FixedClock,
    Operation,
    PaymentKitError,
    hash_payload,
    run_idempotent,
)
from schift_payment_kit_schema_postgres import PostgresRepo


@pytest.mark.parametrize("retry", [False, True])
def test_persisted_operation_claim_and_execution(retry):
    async def scenario():
        db = await create_test_db("py_operation_claim")
        try:
            first, second = PostgresRepo(db.dsn), PostgresRepo(db.dsn)
            clock = FixedClock(datetime(2026, 1, 1, tzinfo=UTC))
            if retry:
                await first.operations.put(Operation(id="race", key="race", kind="test", payload_hash=hash_payload({}), status="failed", created_at=clock.now(), attempts=1))
            calls = 0
            gate = asyncio.Event()

            async def fn():
                nonlocal calls
                calls += 1
                await gate.wait()
                return "done"

            async def run(repo):
                try:
                    return await run_idempotent(repo=repo, clock=clock, key="race", kind="test", payload={}, fn=fn)
                except PaymentKitError as error:
                    return error

            tasks = [asyncio.create_task(run(first)), asyncio.create_task(run(second))]
            try:
                completed, _ = await asyncio.wait(tasks, timeout=5, return_when=asyncio.FIRST_COMPLETED)
                assert len(completed) == 1
                loser = next(iter(completed)).result()
                assert isinstance(loser, PaymentKitError)
                assert loser.code == "idempotency_in_progress"
            finally:
                gate.set()
                await asyncio.gather(*tasks)
            assert calls == 1
            assert (await first.operations.get("race")).attempts == (2 if retry else 1)
            assert (await run(first)).replayed
            assert calls == 1
        finally:
            await drop_test_db(db)

    asyncio.run(scenario())


def test_operation_result_serializes_nested_decision_dates():
    async def scenario():
        db = await create_test_db("py_operation_result")
        try:
            repo = PostgresRepo(db.dsn)
            now = datetime(2026, 1, 1, tzinfo=UTC)
            result = {"case": {"decision": {"refund": {"created_at": now}}}}
            await repo.operations.put(Operation(id="result", key="result", kind="cs.refund", payload_hash="hash", status="done", result=result, created_at=now))
            stored = await repo.operations.get("result")
            assert stored.result["case"]["decision"]["refund"]["created_at"] == now.isoformat()
        finally:
            await drop_test_db(db)
    asyncio.run(scenario())
