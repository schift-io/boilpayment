"""[EC:B20] In-memory ledger: idempotency keys are scoped to the customer."""
from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from boilpayment_core import ConsumeInput, InMemoryLedger, LedgerReference, NewLedgerEntry, SequentialIdGen

NOW = datetime(2026, 9, 27, tzinfo=UTC)


def _grant(cid: str, key: str) -> NewLedgerEntry:
    return NewLedgerEntry(customer_id=cid, pool="paid", kind="grant", amount=100, unit_price_minor=None, currency=None,
                          expires_at=None, source="manual", reference=LedgerReference(), idempotency_key=key, actor="test")


def _consume(cid: str, amount: int) -> ConsumeInput:
    return ConsumeInput(customer_id=cid, pool_order=["paid"], amount=amount, idempotency_key="req-1",
                        meta=LedgerReference(), now=NOW, negative_balance="block", negative_floor=0)


def test_ec_b20_other_customer_same_consume_key_is_charged() -> None:
    async def run():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        await ledger.append(_grant("A", "g-A"))
        await ledger.append(_grant("B", "g-B"))
        await ledger.consume(_consume("A", 30))
        b = await ledger.consume(_consume("B", 50))
        return (b.duplicated, all(e.customer_id == "B" for e in b.entries),
                (await ledger.balance("A", None, NOW)).available, (await ledger.balance("B", None, NOW)).available)

    assert asyncio.run(run()) == (False, True, 70, 50)


def test_ec_b20_append_scoped_and_same_customer_still_duplicate() -> None:
    async def run():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        a = await ledger.append(_grant("A", "same"))
        b = await ledger.append(_grant("B", "same"))
        again = await ledger.append(_grant("A", "same"))
        return b.duplicated, b.entry.customer_id, again.duplicated, again.entry.id == a.entry.id

    assert asyncio.run(run()) == (False, "B", True, True)
