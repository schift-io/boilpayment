"""[EC:B20] usage.record dedupes per customer: another customer's identical key is recorded."""
from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from boilpayment_core import FixedClock, InMemoryRepo, SequentialIdGen
from boilpayment_usage import UsageEventInput, record
from fixtures import BASE_POLICY, mk_sub


def test_ec_b20_two_customers_same_key() -> None:
    async def run():
        ids = SequentialIdGen("id_")
        clock = FixedClock(datetime(2026, 5, 15, tzinfo=UTC))
        repo = InMemoryRepo()
        sub_a = mk_sub(id="sub_A", customer_id="A")
        sub_b = mk_sub(id="sub_B", customer_id="B")

        def ev(cid: str, q: int) -> UsageEventInput:
            return UsageEventInput(customer_id=cid, meter="api_call", quantity=q, occurred_at=clock.now(), idempotency_key="evt-1")

        await record(event=ev("A", 3), sub=sub_a, policy=BASE_POLICY, repo=repo, clock=clock, ids=ids)
        b = await record(event=ev("B", 7), sub=sub_b, policy=BASE_POLICY, repo=repo, clock=clock, ids=ids)
        return b.duplicated, b.event.customer_id, b.event.quantity

    assert asyncio.run(run()) == (False, "B", 7)
