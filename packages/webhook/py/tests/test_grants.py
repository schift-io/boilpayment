"""Phase 6 regression tests -- packages/webhook/py/src/boilpayment_webhook/grants.py (EC:E13)"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from boilpayment_core import (
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    LedgerReference,
    Money,
    NewLedgerEntry,
    Payment,
    SequentialIdGen,
)
from boilpayment_webhook import get_grants_for_checkout


def test_ec_e13_not_ready_when_no_payment_matches_checkout_or_payment_ref():
    async def run():
        repo = InMemoryRepo()
        ledger = InMemoryLedger(SequentialIdGen("led_"))

        result = await get_grants_for_checkout(
            checkout_id_or_payment_ref="does_not_exist", repo=repo, ledger=ledger
        )

        assert result.ready is False
        assert result.customer_id is None
        assert result.entries is None

    asyncio.run(run())


def test_ec_e13_not_ready_when_matching_payment_has_not_succeeded_yet():
    async def run():
        clock = FixedClock(datetime(2026, 2, 2, tzinfo=UTC))
        repo = InMemoryRepo()
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        payment = Payment(
            id="pay_pending",
            customer_id="cust_1",
            provider="stripe",
            provider_ref="pi_pending",
            subscription_id=None,
            amount=Money(amount_minor=1000, currency="USD"),
            status="pending",
            kind="topup",
            period=None,
            occurred_at=clock.now(),
            failure=None,
        )
        await repo.payments.put(payment)

        result = await get_grants_for_checkout(
            checkout_id_or_payment_ref="pi_pending", repo=repo, ledger=ledger
        )

        assert result.ready is False
        assert result.customer_id is None
        assert result.entries is None

    asyncio.run(run())


def test_ec_e13_ready_true_with_customer_id_and_matching_grant_entries():
    async def run():
        clock = FixedClock(datetime(2026, 2, 2, tzinfo=UTC))
        repo = InMemoryRepo()
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        payment = Payment(
            id="pay_done",
            customer_id="cust_1",
            provider="stripe",
            provider_ref="pi_done",
            subscription_id=None,
            amount=Money(amount_minor=2000, currency="USD"),
            status="succeeded",
            kind="topup",
            period=None,
            occurred_at=clock.now(),
            failure=None,
        )
        await repo.payments.put(payment)

        appended = await ledger.append(
            NewLedgerEntry(
                customer_id="cust_1",
                pool="paid",
                kind="grant",
                amount=200,
                source="topup",
                idempotency_key=f"topup:{payment.id}",
                actor="system",
                reference=LedgerReference(payment_id=payment.id),
            )
        )
        grant_entry = appended.entry
        # an entry for a different payment on the same customer must be excluded from the result.
        await ledger.append(
            NewLedgerEntry(
                customer_id="cust_1",
                pool="paid",
                kind="grant",
                amount=50,
                source="subscription",
                idempotency_key="other:1",
                actor="system",
                reference=LedgerReference(payment_id="pay_other"),
            )
        )

        result = await get_grants_for_checkout(
            checkout_id_or_payment_ref="pi_done", repo=repo, ledger=ledger
        )

        assert result.ready is True
        assert result.customer_id == "cust_1"
        assert result.entries is not None
        assert len(result.entries) == 1
        assert result.entries[0].id == grant_entry.id
        assert result.entries[0].amount == 200
        assert result.entries[0].reference.payment_id == payment.id

    asyncio.run(run())
