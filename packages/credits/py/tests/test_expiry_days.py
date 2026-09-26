"""EC:B19 per-source default expiry. Mirrors ts/test/expiryDays.test.ts (same cases, same numbers)."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest
from boilpayment_core import (
    DEFAULT_POLICY,
    FixedClock,
    InMemoryLedger,
    PolicyValidationError,
    SequentialIdGen,
    resolve_policy,
)
from boilpayment_credits import (
    GrantPoolInput,
    ManualAdjustInput,
    default_expiry,
    grant_promo,
    grant_trial,
    manual_grant,
)

NOW = datetime(2026, 5, 15, tzinfo=UTC)
POLICY = resolve_policy({"credits": {"expiryDays": {"promo": 30, "trial": 14, "manual": 90, "regrant": 365}}})


def harness():
    clock = FixedClock(NOW)
    return clock, InMemoryLedger(SequentialIdGen("x_"), clock)


def test_defaults_are_null():
    for s in ("promo", "trial", "manual", "regrant"):
        assert default_expiry(DEFAULT_POLICY, s, NOW) is None


def test_source_defaults_apply_with_policy_and_no_expiry():
    async def body():
        clock, ledger = harness()
        p = await grant_promo(GrantPoolInput(customer_id="c", amount=10, ledger=ledger, clock=clock, idempotency_key="p", policy=POLICY))
        t = await grant_trial(GrantPoolInput(customer_id="c", amount=10, ledger=ledger, clock=clock, idempotency_key="t", policy=POLICY))
        m = await manual_grant(
            ManualAdjustInput(
                customer_id="c", pool="paid", amount=10, reason="goodwill", actor="ops", ledger=ledger, clock=clock,
                idempotency_key="m", policy=POLICY,
            )
        )
        assert p.entry.expires_at == NOW + timedelta(days=30)
        assert t.entry.expires_at == NOW + timedelta(days=14)
        assert m.entry.expires_at == NOW + timedelta(days=90)

    asyncio.run(body())


def test_explicit_expiry_wins_and_no_policy_changes_nothing():
    async def body():
        clock, ledger = harness()
        explicit = NOW + timedelta(days=1)
        a = await grant_promo(
            GrantPoolInput(customer_id="c", amount=10, ledger=ledger, clock=clock, idempotency_key="a", policy=POLICY, expires_at=explicit)
        )
        b = await grant_promo(GrantPoolInput(customer_id="c", amount=10, ledger=ledger, clock=clock, idempotency_key="b"))
        assert a.entry.expires_at == explicit
        assert b.entry.expires_at is None

    asyncio.run(body())


def test_expired_defaults_drop_out_of_balance():
    async def body():
        clock, ledger = harness()
        await grant_promo(GrantPoolInput(customer_id="c", amount=10, ledger=ledger, clock=clock, idempotency_key="p", policy=POLICY))
        await manual_grant(
            ManualAdjustInput(
                customer_id="c", pool="promo", amount=5, reason="r", actor="ops", ledger=ledger, clock=clock,
                idempotency_key="m", policy=POLICY,
            )
        )
        clock.advance(31 * 86_400_000)
        assert (await ledger.balance("c", "promo", clock.now())).available == 5

    asyncio.run(body())


def test_rejects_zero_days():
    with pytest.raises(PolicyValidationError, match="credits.expiry_days.promo"):
        resolve_policy({"credits": {"expiryDays": {"promo": 0}}})
