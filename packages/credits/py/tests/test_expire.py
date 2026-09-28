"""spec: packages/credits/spec/credits.pseudo.md [EC:B14]"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from boilpayment_core import (
    ConsumeInput,
    FixedClock,
    InMemoryLedger,
    LedgerReference,
    NewLedgerEntry,
    SequentialIdGen,
)
from boilpayment_credits import ExpireDueInput, expire_due


def run(coro):
    return asyncio.run(coro)


def test_sb_07_does_not_expire_grant_before_linked_grace_extension_ends():
    async def scenario():
        clock = FixedClock(datetime(2024, 2, 2, tzinfo=UTC))
        ledger = InMemoryLedger(SequentialIdGen("led_"), clock)
        grant = (
            await ledger.append(
                NewLedgerEntry(
                    customer_id="cust_1",
                    pool="paid",
                    kind="grant",
                    amount=100,
                    source="subscription",
                    reference=LedgerReference(),
                    idempotency_key="g_sb07",
                    actor="system",
                    expires_at=datetime(2024, 2, 1, tzinfo=UTC),
                )
            )
        ).entry
        await ledger.append(
            NewLedgerEntry(
                customer_id="cust_1",
                pool="paid",
                kind="adjust",
                amount=0,
                source="subscription",
                reference=LedgerReference(grant_id=grant.id),
                idempotency_key="extend_sb07",
                actor="system",
                expires_at=datetime(2024, 2, 8, tzinfo=UTC),
                reason="SB-07 grace_expiry_extension",
            )
        )

        result = await expire_due(
            ExpireDueInput(ledger=ledger, clock=clock, customer_id="cust_1")
        )
        assert result.entries == []

    run(scenario())


def test_expire_due_bookkeeping_neutral_to_balance():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        clock = FixedClock(datetime(2024, 1, 1, tzinfo=UTC))
        expires_at = datetime(2024, 1, 15, tzinfo=UTC)
        await ledger.append(
            NewLedgerEntry(
                customer_id="cust_1",
                pool="paid",
                kind="grant",
                amount=100,
                source="subscription",
                reference=LedgerReference(),
                idempotency_key="g1",
                actor="system",
                expires_at=expires_at,
            )
        )
        await ledger.consume(
            ConsumeInput(
                customer_id="cust_1",
                pool_order=["paid"],
                amount=40,
                idempotency_key="consume_1",
                meta=LedgerReference(),
                now=clock.now(),
                negative_balance="block",
                negative_floor=0,
            )
        )  # 60 remaining on the grant

        clock.advance(20 * 86_400_000)  # past expires_at
        bal_before = await ledger.balance("cust_1", None, clock.now())
        assert bal_before.available == 0

        result = await expire_due(
            ExpireDueInput(ledger=ledger, clock=clock, customer_id="cust_1")
        )
        assert len(result.entries) == 1
        assert result.entries[0].amount == -60
        assert result.entries[0].kind == "expire"

        bal_after = await ledger.balance("cust_1", None, clock.now())
        assert bal_after.available == 0  # unchanged -- bookkeeping only

    run(scenario())


def test_expire_due_retry_is_idempotent_same_row_no_second_write():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        clock = FixedClock(datetime(2024, 1, 1, tzinfo=UTC))
        await ledger.append(
            NewLedgerEntry(
                customer_id="cust_1",
                pool="paid",
                kind="grant",
                amount=100,
                source="subscription",
                reference=LedgerReference(),
                idempotency_key="g1",
                actor="system",
                expires_at=datetime(2024, 1, 15, tzinfo=UTC),
            )
        )
        clock.advance(20 * 86_400_000)
        first = await expire_due(
            ExpireDueInput(ledger=ledger, clock=clock, customer_id="cust_1")
        )
        assert len(first.entries) == 1

        second = await expire_due(
            ExpireDueInput(ledger=ledger, clock=clock, customer_id="cust_1")
        )
        # expire:{grant_id} is idempotent at the ledger.append level: the second call returns the
        # same (deduplicated) row rather than a fresh one.
        assert len(second.entries) == 1
        assert second.entries[0].id == first.entries[0].id

        all_expire_entries = [
            e for e in await ledger.entries("cust_1") if e.kind == "expire"
        ]
        assert len(all_expire_entries) == 1

    run(scenario())


def test_fully_consumed_grant_produces_no_expire_entry():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        clock = FixedClock(datetime(2024, 1, 1, tzinfo=UTC))
        await ledger.append(
            NewLedgerEntry(
                customer_id="cust_1",
                pool="paid",
                kind="grant",
                amount=100,
                source="subscription",
                reference=LedgerReference(),
                idempotency_key="g1",
                actor="system",
                expires_at=datetime(2024, 1, 15, tzinfo=UTC),
            )
        )
        await ledger.consume(
            ConsumeInput(
                customer_id="cust_1",
                pool_order=["paid"],
                amount=100,
                idempotency_key="consume_1",
                meta=LedgerReference(),
                now=clock.now(),
                negative_balance="block",
                negative_floor=0,
            )
        )
        clock.advance(20 * 86_400_000)
        res = await expire_due(
            ExpireDueInput(ledger=ledger, clock=clock, customer_id="cust_1")
        )
        assert res.entries == []

    run(scenario())
