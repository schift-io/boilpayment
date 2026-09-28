"""Regression tests for InMemoryLedger.consume/append/balance.
spec: packages/core/spec/core.pseudo.md [EC:B3] [EC:B4] [EC:B5] [EC:B12] [EC:B14]
"""

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

NOW = datetime(2026, 1, 1, tzinfo=UTC)


def run(coro):
    return asyncio.run(coro)


def mk_grant(**kwargs) -> NewLedgerEntry:
    kwargs.setdefault("kind", "grant")
    kwargs.setdefault("source", "subscription")
    kwargs.setdefault("actor", "system")
    return NewLedgerEntry(**kwargs)


def mk_consume(**kwargs) -> ConsumeInput:
    kwargs.setdefault("meta", LedgerReference())
    kwargs.setdefault("negative_balance", "block")
    kwargs.setdefault("negative_floor", 0)
    return ConsumeInput(**kwargs)


# ── EC:B3 consume order ──────────────────────────────────────────────────────


def test_ec_b3_pool_order_paid_promo_trial_drains_paid_then_promo():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        await ledger.append(
            mk_grant(customer_id="c1", pool="paid", amount=10, idempotency_key="g_paid")
        )
        await ledger.append(
            mk_grant(
                customer_id="c1", pool="promo", amount=10, idempotency_key="g_promo"
            )
        )
        await ledger.append(
            mk_grant(
                customer_id="c1", pool="trial", amount=10, idempotency_key="g_trial"
            )
        )

        res = await ledger.consume(
            mk_consume(
                customer_id="c1",
                pool_order=["paid", "promo", "trial"],
                amount=15,
                idempotency_key="k1",
                now=NOW,
            )
        )
        assert res.ok is True
        assert [(e.pool, e.amount) for e in res.entries] == [
            ("paid", -10),
            ("promo", -5),
        ]

    run(scenario())


def test_ec_b3_pool_order_promo_trial_paid_drains_promo_then_trial():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        await ledger.append(
            mk_grant(customer_id="c1", pool="paid", amount=10, idempotency_key="g_paid")
        )
        await ledger.append(
            mk_grant(
                customer_id="c1", pool="promo", amount=10, idempotency_key="g_promo"
            )
        )
        await ledger.append(
            mk_grant(
                customer_id="c1", pool="trial", amount=10, idempotency_key="g_trial"
            )
        )

        res = await ledger.consume(
            mk_consume(
                customer_id="c1",
                pool_order=["promo", "trial", "paid"],
                amount=15,
                idempotency_key="k1",
                now=NOW,
            )
        )
        assert res.ok is True
        assert [(e.pool, e.amount) for e in res.entries] == [
            ("promo", -10),
            ("trial", -5),
        ]

    run(scenario())


def test_ec_b3_pool_order_paid_trial_promo_drains_paid_then_trial():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        await ledger.append(
            mk_grant(customer_id="c1", pool="paid", amount=10, idempotency_key="g_paid")
        )
        await ledger.append(
            mk_grant(
                customer_id="c1", pool="promo", amount=10, idempotency_key="g_promo"
            )
        )
        await ledger.append(
            mk_grant(
                customer_id="c1", pool="trial", amount=10, idempotency_key="g_trial"
            )
        )

        res = await ledger.consume(
            mk_consume(
                customer_id="c1",
                pool_order=["paid", "trial", "promo"],
                amount=15,
                idempotency_key="k1",
                now=NOW,
            )
        )
        assert res.ok is True
        assert [(e.pool, e.amount) for e in res.entries] == [
            ("paid", -10),
            ("trial", -5),
        ]

    run(scenario())


def test_ec_b3_within_pool_drains_soonest_expiry_first_null_last():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        soon = datetime(2026, 1, 10, tzinfo=UTC)
        later = datetime(2026, 1, 20, tzinfo=UTC)
        await ledger.append(
            mk_grant(
                customer_id="c1",
                pool="paid",
                amount=5,
                idempotency_key="g_null",
                expires_at=None,
            )
        )
        await ledger.append(
            mk_grant(
                customer_id="c1",
                pool="paid",
                amount=5,
                idempotency_key="g_later",
                expires_at=later,
            )
        )
        await ledger.append(
            mk_grant(
                customer_id="c1",
                pool="paid",
                amount=5,
                idempotency_key="g_soon",
                expires_at=soon,
            )
        )

        res = await ledger.consume(
            mk_consume(
                customer_id="c1",
                pool_order=["paid"],
                amount=12,
                idempotency_key="k1",
                now=NOW,
            )
        )
        assert res.ok is True
        assert [e.amount for e in res.entries] == [-5, -5, -2]

    run(scenario())


# ── EC:B14 expiry filter ─────────────────────────────────────────────────────


def test_sb_07_linked_grace_expiry_extends_dated_grant_but_null_stays_null():
    async def scenario():
        clock = FixedClock(NOW)
        ledger = InMemoryLedger(SequentialIdGen("led_"), clock)
        dated = (
            await ledger.append(
                mk_grant(
                    customer_id="c1",
                    pool="paid",
                    amount=10,
                    idempotency_key="g_dated",
                    expires_at=datetime(2025, 12, 31, tzinfo=UTC),
                )
            )
        ).entry
        unbounded = (
            await ledger.append(
                mk_grant(
                    customer_id="c1",
                    pool="paid",
                    amount=5,
                    idempotency_key="g_unbounded",
                    expires_at=None,
                )
            )
        ).entry
        grace_until = datetime(2026, 1, 8, tzinfo=UTC)
        for grant in (dated, unbounded):
            await ledger.append(
                NewLedgerEntry(
                    customer_id="c1",
                    pool="paid",
                    kind="adjust",
                    amount=0,
                    source="subscription",
                    reference=LedgerReference(grant_id=grant.id),
                    idempotency_key=f"extend:{grant.id}",
                    actor="system",
                    expires_at=grace_until,
                    reason="SB-07 grace_expiry_extension",
                )
            )
        await ledger.append(
            NewLedgerEntry(
                customer_id="c1",
                pool="paid",
                kind="adjust",
                amount=0,
                source="subscription",
                reference=LedgerReference(grant_id=unbounded.id),
                idempotency_key=f"end:{unbounded.id}",
                actor="system",
                expires_at=datetime(2026, 1, 4, tzinfo=UTC),
                reason="SB-08 grace_expiry_end",
            )
        )

        balance = await ledger.balance("c1", "paid", NOW)
        assert balance.available == 15
        assert [(item.expires_at, item.amount) for item in balance.expiring] == [
            (grace_until, 10)
        ]

    run(scenario())


def test_sb_08_first_grace_end_caps_extension_without_shortening_original():
    async def scenario():
        clock = FixedClock(NOW)
        ledger = InMemoryLedger(SequentialIdGen("led_"), clock)
        original_expiry = datetime(2026, 1, 2, tzinfo=UTC)
        grant = (
            await ledger.append(
                mk_grant(
                    customer_id="c1",
                    pool="paid",
                    amount=10,
                    idempotency_key="g_recovered",
                    expires_at=original_expiry,
                )
            )
        ).entry
        grace_until = datetime(2026, 1, 8, tzinfo=UTC)
        recovered_at = datetime(2026, 1, 4, tzinfo=UTC)
        duplicate_at = datetime(2026, 1, 5, tzinfo=UTC)
        for reason, expires_at, suffix in (
            ("SB-07 grace_expiry_extension", grace_until, "extension"),
            ("SB-08 grace_expiry_end", recovered_at, "first-end"),
            ("SB-08 grace_expiry_end", duplicate_at, "duplicate-end"),
        ):
            await ledger.append(
                NewLedgerEntry(
                    customer_id="c1",
                    pool="paid",
                    kind="adjust",
                    amount=0,
                    source="subscription",
                    reference=LedgerReference(grant_id=grant.id),
                    idempotency_key=f"{suffix}:{grant.id}",
                    actor="system",
                    expires_at=expires_at,
                    reason=reason,
                )
            )

        assert (
            await ledger.balance(
                "c1", "paid", datetime(2026, 1, 3, tzinfo=UTC)
            )
        ).available == 10
        assert (await ledger.balance("c1", "paid", recovered_at)).available == 0

    run(scenario())


def test_ec_b14_expired_grant_excluded_from_consume():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        past = datetime(2025, 12, 31, tzinfo=UTC)
        await ledger.append(
            mk_grant(
                customer_id="c1",
                pool="paid",
                amount=10,
                idempotency_key="g_expired",
                expires_at=past,
            )
        )
        await ledger.append(
            mk_grant(
                customer_id="c1",
                pool="paid",
                amount=5,
                idempotency_key="g_live",
                expires_at=None,
            )
        )

        res = await ledger.consume(
            mk_consume(
                customer_id="c1",
                pool_order=["paid"],
                amount=5,
                idempotency_key="k1",
                now=NOW,
            )
        )
        assert res.ok is True
        assert len(res.entries) == 1

        insufficient = await ledger.consume(
            mk_consume(
                customer_id="c1",
                pool_order=["paid"],
                amount=1,
                idempotency_key="k2",
                now=NOW,
            )
        )
        assert insufficient.ok is False

    run(scenario())


def test_ec_b14_balance_excludes_expired_buckets():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        past = datetime(2025, 12, 31, tzinfo=UTC)
        await ledger.append(
            mk_grant(
                customer_id="c1",
                pool="paid",
                amount=10,
                idempotency_key="g_expired",
                expires_at=past,
            )
        )
        await ledger.append(
            mk_grant(
                customer_id="c1",
                pool="paid",
                amount=5,
                idempotency_key="g_live",
                expires_at=None,
            )
        )

        bal = await ledger.balance("c1", None, NOW)
        assert bal.available == 5
        assert bal.expiring == []

    run(scenario())


# ── EC:B4 negative balance policy ────────────────────────────────────────────


def test_ec_b4_block_rejects_whole_request_no_entries():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        await ledger.append(
            mk_grant(customer_id="c1", pool="paid", amount=10, idempotency_key="g1")
        )
        res = await ledger.consume(
            mk_consume(
                customer_id="c1",
                pool_order=["paid"],
                amount=15,
                idempotency_key="k1",
                now=NOW,
                negative_balance="block",
            )
        )
        assert res.ok is False
        assert res.shortfall == 5
        assert res.entries == []
        bal = await ledger.balance("c1", None, NOW)
        assert bal.available == 10

    run(scenario())


def test_ec_b4_allow_to_floor_allows_down_to_floor_then_rejects_entirely():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        await ledger.append(
            mk_grant(customer_id="c1", pool="paid", amount=10, idempotency_key="g1")
        )

        res = await ledger.consume(
            mk_consume(
                customer_id="c1",
                pool_order=["paid"],
                amount=15,
                idempotency_key="k1",
                now=NOW,
                negative_balance="allow_to_floor",
                negative_floor=-5,
            )
        )
        assert res.ok is True
        assert [(e.pool, e.amount) for e in res.entries] == [
            ("paid", -10),
            ("paid", -5),
        ]
        assert res.entries[1].reference.grant_id is None
        bal = await ledger.balance("c1", None, NOW)
        assert bal.available == -5

        res2 = await ledger.consume(
            mk_consume(
                customer_id="c1",
                pool_order=["paid"],
                amount=1,
                idempotency_key="k2",
                now=NOW,
                negative_balance="allow_to_floor",
                negative_floor=-5,
            )
        )
        assert res2.ok is False
        assert res2.shortfall == 1

    run(scenario())


def test_ec_b4_allow_unbounded_always_succeeds():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        await ledger.append(
            mk_grant(customer_id="c1", pool="paid", amount=10, idempotency_key="g1")
        )
        res = await ledger.consume(
            mk_consume(
                customer_id="c1",
                pool_order=["paid"],
                amount=1000,
                idempotency_key="k1",
                now=NOW,
                negative_balance="allow_unbounded",
            )
        )
        assert res.ok is True
        assert res.shortfall == 0
        bal = await ledger.balance("c1", None, NOW)
        assert bal.available == 10 - 1000

    run(scenario())


# ── EC:B12 idempotency ────────────────────────────────────────────────────────


def test_ec_b12_append_dedup_returns_original_row():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        first = await ledger.append(
            mk_grant(customer_id="c1", pool="paid", amount=10, idempotency_key="dup")
        )
        assert first.duplicated is False
        second = await ledger.append(
            mk_grant(customer_id="c1", pool="paid", amount=999, idempotency_key="dup")
        )
        assert second.duplicated is True
        assert second.entry is first.entry
        bal = await ledger.balance("c1", None, NOW)
        assert bal.available == 10

    run(scenario())


def test_ec_b12_consume_dedup_does_not_double_consume():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        await ledger.append(
            mk_grant(customer_id="c1", pool="paid", amount=10, idempotency_key="g1")
        )
        first = await ledger.consume(
            mk_consume(
                customer_id="c1",
                pool_order=["paid"],
                amount=4,
                idempotency_key="req-1",
                now=NOW,
            )
        )
        assert first.duplicated is False
        second = await ledger.consume(
            mk_consume(
                customer_id="c1",
                pool_order=["paid"],
                amount=4,
                idempotency_key="req-1",
                now=NOW,
            )
        )
        assert second.duplicated is True
        assert second.ok == first.ok
        assert len(second.entries) == len(first.entries)
        bal = await ledger.balance("c1", None, NOW)
        assert bal.available == 6

    run(scenario())


# ── holds ─────────────────────────────────────────────────────────────────────


def test_hold_reduces_available_release_restores_it():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        await ledger.append(
            mk_grant(customer_id="c1", pool="paid", amount=100, idempotency_key="g1")
        )

        await ledger.append(
            NewLedgerEntry(
                customer_id="c1",
                pool="paid",
                kind="hold",
                amount=-20,
                source="refund",
                idempotency_key="hold_1",
                actor="system",
                reference=LedgerReference(),
                reason="refund_pending",
            )
        )
        bal = await ledger.balance("c1", None, NOW)
        assert bal.available == 80
        assert bal.held == 20

        await ledger.append(
            NewLedgerEntry(
                customer_id="c1",
                pool="paid",
                kind="release",
                amount=20,
                source="refund",
                idempotency_key="release_1",
                actor="system",
                reference=LedgerReference(),
                reason="refund_failed",
            )
        )
        bal = await ledger.balance("c1", None, NOW)
        assert bal.available == 100
        assert bal.held == 0

    run(scenario())


# EC:I9 finding (2026-09-09) -- append()'s created_at used to always be wall-clock time, ignoring
# the injected Clock (found 3x independently: refund.evaluate FINDINGS#1, a dispute regression
# test, cs.timeline). Fixed by an optional clock param on the constructor.
def test_append_stamps_created_at_from_injected_fixed_clock() -> None:
    async def scenario() -> None:
        fixed = FixedClock(datetime(2020, 1, 1, tzinfo=UTC))
        ledger = InMemoryLedger(SequentialIdGen("led_"), fixed)
        result = await ledger.append(
            mk_grant(
                customer_id="c1", pool="paid", amount=10, idempotency_key="g_clock_1"
            )
        )
        assert result.entry.created_at == datetime(2020, 1, 1, tzinfo=UTC)

        fixed.advance(60_000)
        result2 = await ledger.append(
            mk_grant(
                customer_id="c1", pool="paid", amount=5, idempotency_key="g_clock_2"
            )
        )
        assert result2.entry.created_at == datetime(2020, 1, 1, 0, 1, tzinfo=UTC)

    run(scenario())


def test_balance_honors_injected_clock_now_is_required_not_wall_clock() -> None:
    async def scenario() -> None:
        fixed = FixedClock(datetime(2020, 1, 1, tzinfo=UTC))
        ledger = InMemoryLedger(SequentialIdGen("led_"), fixed)
        await ledger.append(
            NewLedgerEntry(
                customer_id="c1",
                pool="paid",
                kind="grant",
                amount=10,
                source="subscription",
                idempotency_key="g_exp_1",
                actor="system",
                reference=LedgerReference(),
                expires_at=datetime(2020, 1, 1, 0, 0, 30, tzinfo=UTC),
            )
        )
        # Not yet expired per the fixed clock (still at 00:00:00).
        assert (await ledger.balance("c1", None, fixed.now())).available == 10
        fixed.advance(60_000)  # now 00:01:00 -- past the grant's 00:00:30 expiry
        assert (await ledger.balance("c1", None, fixed.now())).available == 0

    run(scenario())


def test_defaults_to_system_clock_when_no_clock_is_passed() -> None:
    async def scenario() -> None:
        import time

        ledger = InMemoryLedger(SequentialIdGen("led_"))
        before = time.time()
        result = await ledger.append(
            mk_grant(
                customer_id="c1",
                pool="paid",
                amount=10,
                idempotency_key="g_default_clock",
            )
        )
        after = time.time()
        assert before <= result.entry.created_at.timestamp() <= after

    run(scenario())


def test_l5_consume_keeps_every_caller_supplied_reference_field():
    """EC:L5 -- a field whitelist here silently dropped correlation_id."""

    async def run():
        ids = SequentialIdGen("l_")
        clock = FixedClock(datetime(2026, 1, 1, tzinfo=UTC))
        ledger = InMemoryLedger(ids, clock)
        await ledger.append(
            NewLedgerEntry(
                customer_id="c", pool="paid", kind="grant", amount=100, source="topup",
                idempotency_key="g1", actor="system", unit_price_minor=1, currency="USD",
            )
        )
        res = await ledger.consume(
            ConsumeInput(
                customer_id="c", pool_order=["paid"], amount=10, idempotency_key="c1",
                meta=LedgerReference(correlation_id="corr_abc", payment_id="p1", case_id="case_1"),
                now=clock.now(), negative_balance="block", negative_floor=0,
            )
        )
        ref = res.entries[0].reference
        assert ref.correlation_id == "corr_abc"
        assert ref.payment_id == "p1"
        assert ref.case_id == "case_1"
        assert ref.grant_id is not None  # consume() owns this one

    asyncio.run(run())
