"""[EC:A27] paused / incomplete subscriptions are not entitled: usage.check refuses them."""
from __future__ import annotations

import asyncio
import dataclasses
from datetime import UTC, datetime

import pytest
from boilpayment_core import FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen
from boilpayment_usage import check
from fixtures import BASE_POLICY, mk_sub


@pytest.mark.parametrize("status", ["paused", "incomplete"])
def test_ec_a27_inactive_refused(status: str) -> None:
    async def run():
        ids = SequentialIdGen("id_")
        sub = dataclasses.replace(mk_sub(), status=status)
        r = await check(customer_id=sub.customer_id, meter="api_call", quantity=1, sub=sub, policy=BASE_POLICY,
                        repo=InMemoryRepo(), ledger=InMemoryLedger(ids), clock=FixedClock(datetime(2026, 5, 15, tzinfo=UTC)))
        return r.allow, r.reason

    assert asyncio.run(run()) == (False, "subscription_inactive")


@pytest.mark.parametrize("status", ["canceled", "expired"])
def test_ec_c11_ended_refused(status: str) -> None:
    async def run():
        ids = SequentialIdGen("id_")
        sub = dataclasses.replace(mk_sub(), status=status)
        r = await check(customer_id=sub.customer_id, meter="api_call", quantity=1, sub=sub, policy=BASE_POLICY,
                        repo=InMemoryRepo(), ledger=InMemoryLedger(ids), clock=FixedClock(datetime(2026, 5, 15, tzinfo=UTC)))
        return r.allow, r.reason

    assert asyncio.run(run()) == (False, "subscription_inactive")


@pytest.mark.parametrize("status", ["paused", "incomplete", "canceled", "expired"])
def test_ec_c11_reserve_refused_before_hold(status: str) -> None:
    from boilpayment_core import LedgerReference, NewLedgerEntry
    from boilpayment_usage import reserve

    async def run():
        clock = FixedClock(datetime(2026, 5, 15, tzinfo=UTC))
        ledger = InMemoryLedger(SequentialIdGen("l_"), clock)
        await ledger.append(NewLedgerEntry(customer_id="cust_1", pool="trial", kind="grant", amount=100, source="trial",
                                           idempotency_key="g", actor="t", reference=LedgerReference()))
        sub = dataclasses.replace(mk_sub(), status=status)
        r = await reserve(customer_id="cust_1", job_id="job", amount=10, policy=BASE_POLICY, ledger=ledger, clock=clock, sub=sub)
        return r.ok, r.reason, await ledger.entries("cust_1", kind="hold")

    assert asyncio.run(run()) == (False, "subscription_inactive", [])
