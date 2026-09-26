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
