"""[EC:B21] In-memory consume: a row key another operation holds is refused, not returned."""
from __future__ import annotations

import asyncio
from datetime import UTC, datetime

import pytest
from boilpayment_core import ConsumeInput, FixedClock, InMemoryLedger, LedgerReference, NewLedgerEntry, PaymentKitError, UuidIdGen


def test_ec_b21_memory_consume_key_collision_is_refused() -> None:
    async def run():
        clock = FixedClock(datetime(2026, 1, 1, tzinfo=UTC))
        ledger = InMemoryLedger(UuidIdGen(), clock)
        for key, amount in (("g", 100), ("k#0", 5)):
            await ledger.append(NewLedgerEntry(customer_id="c", pool="paid", kind="grant", amount=amount, source="topup",
                                               idempotency_key=key, actor="t", reference=LedgerReference()))
        with pytest.raises(PaymentKitError) as err:
            await ledger.consume(ConsumeInput(customer_id="c", pool_order=["paid"], amount=30, idempotency_key="k",
                                              meta=LedgerReference(), now=clock.now(), negative_balance="block", negative_floor=0))
        return err.value.code, (await ledger.balance("c", None, clock.now())).available

    assert asyncio.run(run()) == ("idempotency_key_conflict", 105)
