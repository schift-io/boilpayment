"""spec: packages/credits/spec/credits.pseudo.md [EC:A4] [EC:B13]"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

import pytest
from boilpayment_core import (
    FixedClock,
    InMemoryLedger,
    InsufficientBalanceError,
    LedgerReference,
    NewLedgerEntry,
    SequentialIdGen,
    resolve_policy,
)
from boilpayment_credits import ClawbackInput, clawback

CLOCK = FixedClock(datetime(2024, 1, 1, tzinfo=UTC))


def run(coro):
    return asyncio.run(coro)


async def seed(amount: int) -> InMemoryLedger:
    ledger = InMemoryLedger(SequentialIdGen("led_"))
    await ledger.append(
        NewLedgerEntry(
            customer_id="cust_1",
            pool="paid",
            kind="grant",
            amount=amount,
            source="subscription",
            reference=LedgerReference(),
            idempotency_key="g1",
            actor="system",
        )
    )
    return ledger


def test_clamp_to_zero_revokes_only_available_reports_shortfall():
    async def scenario():
        ledger = await seed(20)
        res = await clawback(
            ClawbackInput(
                customer_id="cust_1",
                amount=200,
                policy=resolve_policy(),
                ledger=ledger,
                clock=CLOCK,
                reason="downgrade:plan_b->plan_a",
                reference=LedgerReference(),
                actor="system",
                idempotency_key="revoke:downgrade:sub_1:2024-01-01T00:00:00+00:00",
                shortfall="clamp_to_zero",
            )
        )
        assert res.revoked == 20
        assert res.shortfall == 180
        assert res.entry.source == "downgrade"
        bal = await ledger.balance("cust_1", "paid", CLOCK.now())
        assert bal.available == 0

    run(scenario())


def test_clamp_to_zero_revokes_in_full_when_amount_fits():
    async def scenario():
        ledger = await seed(100)
        res = await clawback(
            ClawbackInput(
                customer_id="cust_1",
                amount=40,
                policy=resolve_policy(),
                ledger=ledger,
                clock=CLOCK,
                reason="test",
                reference=LedgerReference(),
                actor="system",
                idempotency_key="revoke:manual:1",
                shortfall="clamp_to_zero",
            )
        )
        assert res.revoked == 40
        assert res.shortfall == 0

    run(scenario())


def test_allow_negative_revokes_full_amount_balance_goes_negative():
    async def scenario():
        ledger = await seed(20)
        res = await clawback(
            ClawbackInput(
                customer_id="cust_1",
                amount=200,
                policy=resolve_policy(),
                ledger=ledger,
                clock=CLOCK,
                reason="test",
                reference=LedgerReference(),
                actor="system",
                idempotency_key="revoke:manual:2",
                shortfall="allow_negative",
            )
        )
        assert res.revoked == 200
        assert res.shortfall == 0
        bal = await ledger.balance("cust_1", "paid", CLOCK.now())
        assert bal.available == -180

    run(scenario())


def test_deny_downgrade_raises_and_writes_nothing():
    async def scenario():
        ledger = await seed(20)
        with pytest.raises(InsufficientBalanceError):
            await clawback(
                ClawbackInput(
                    customer_id="cust_1",
                    amount=200,
                    policy=resolve_policy(),
                    ledger=ledger,
                    clock=CLOCK,
                    reason="test",
                    reference=LedgerReference(),
                    actor="system",
                    idempotency_key="revoke:manual:3",
                    shortfall="deny_downgrade",
                )
            )
        bal = await ledger.balance("cust_1", "paid", CLOCK.now())
        assert bal.available == 20

    run(scenario())


def test_deny_downgrade_succeeds_when_balance_covers_amount():
    async def scenario():
        ledger = await seed(200)
        res = await clawback(
            ClawbackInput(
                customer_id="cust_1",
                amount=50,
                policy=resolve_policy(),
                ledger=ledger,
                clock=CLOCK,
                reason="test",
                reference=LedgerReference(),
                actor="system",
                idempotency_key="revoke:manual:4",
                shortfall="deny_downgrade",
            )
        )
        assert res.revoked == 50
        assert res.shortfall == 0

    run(scenario())


def test_ec_b13_refund_prefix_infers_source_refund():
    async def scenario():
        ledger = await seed(100)
        res = await clawback(
            ClawbackInput(
                customer_id="cust_1",
                amount=30,
                policy=resolve_policy(),
                ledger=ledger,
                clock=CLOCK,
                reason="refund",
                reference=LedgerReference(refund_id="re_1"),
                actor="system",
                idempotency_key="revoke:refund:re_1",
                shortfall="clamp_to_zero",
            )
        )
        assert res.entry.source == "refund"

    run(scenario())


# ── EC:L5 correlationId propagation ──────────────────────────────────────────


def test_ec_l5_clawback_stamps_reference_correlation_id():
    async def scenario():
        ledger = await seed(100)
        res = await clawback(
            ClawbackInput(
                customer_id="cust_1",
                amount=30,
                policy=resolve_policy(),
                ledger=ledger,
                clock=CLOCK,
                reason="downgrade",
                reference=LedgerReference(),
                actor="system",
                idempotency_key="revoke:downgrade:1",
                shortfall="clamp_to_zero",
                correlation_id="corr_clawback_1",
            )
        )
        assert res.entry.reference.correlation_id == "corr_clawback_1"

    run(scenario())


def test_ec_l5_does_not_overwrite_correlation_id_already_set_on_reference():
    async def scenario():
        ledger = await seed(100)
        res = await clawback(
            ClawbackInput(
                customer_id="cust_1",
                amount=30,
                policy=resolve_policy(),
                ledger=ledger,
                clock=CLOCK,
                reason="downgrade",
                reference=LedgerReference(correlation_id="from_reference"),
                actor="system",
                idempotency_key="revoke:downgrade:2",
                shortfall="clamp_to_zero",
                correlation_id="from_param",
            )
        )
        assert res.entry.reference.correlation_id == "from_reference"

    run(scenario())
