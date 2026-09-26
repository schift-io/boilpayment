"""spec: packages/credits/spec/credits.pseudo.md [EC:B16]"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from boilpayment_core import (
    Customer,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    LedgerReference,
    NewLedgerEntry,
    NoopNotifier,
    SequentialIdGen,
    resolve_policy,
)
from boilpayment_credits import NotifyExpiringInput, notify_expiring


def run(coro):
    return asyncio.run(coro)


async def _grant(ledger, customer_id, amount, expires_at, key):
    await ledger.append(
        NewLedgerEntry(
            customer_id=customer_id,
            pool="paid",
            kind="grant",
            amount=amount,
            unit_price_minor=None,
            currency=None,
            expires_at=expires_at,
            source="subscription",
            reference=LedgerReference(),
            idempotency_key=key,
            actor="system",
            reason=None,
        )
    )


def test_ec_b16_expiry_notice_days_null_never_reports():
    async def scenario():
        clock = FixedClock(datetime(2024, 1, 1, tzinfo=UTC))
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        repo = InMemoryRepo()
        await _grant(ledger, "cust_1", 100, datetime(2024, 1, 2, tzinfo=UTC), "g1")
        policy = resolve_policy()

        res = await notify_expiring(
            NotifyExpiringInput(
                customer_id="cust_1",
                ledger=ledger,
                repo=repo,
                notifier=NoopNotifier(),
                policy=policy,
                clock=clock,
            )
        )
        assert res.pending == []

    run(scenario())


def test_ec_b16_bucket_expiring_exactly_at_window_end_is_included():
    async def scenario():
        clock = FixedClock(datetime(2024, 1, 1, tzinfo=UTC))
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        repo = InMemoryRepo()
        await _grant(
            ledger, "cust_1", 100, datetime(2024, 1, 8, tzinfo=UTC), "g1"
        )  # +7d
        policy = resolve_policy({"credits": {"expiryNoticeDays": 7}})

        res = await notify_expiring(
            NotifyExpiringInput(
                customer_id="cust_1",
                ledger=ledger,
                repo=repo,
                notifier=NoopNotifier(),
                policy=policy,
                clock=clock,
            )
        )
        assert len(res.pending) == 1
        assert res.pending[0].customer_id == "cust_1"
        assert res.pending[0].expires_at == datetime(2024, 1, 8, tzinfo=UTC)
        assert res.pending[0].amount == 100

    run(scenario())


def test_ec_b16_bucket_expiring_just_past_the_window_is_excluded():
    async def scenario():
        clock = FixedClock(datetime(2024, 1, 1, tzinfo=UTC))
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        repo = InMemoryRepo()
        await _grant(
            ledger, "cust_1", 100, datetime(2024, 1, 8, 0, 0, 0, 1000, tzinfo=UTC), "g1"
        )  # +7d + 1ms
        policy = resolve_policy({"credits": {"expiryNoticeDays": 7}})

        res = await notify_expiring(
            NotifyExpiringInput(
                customer_id="cust_1",
                ledger=ledger,
                repo=repo,
                notifier=NoopNotifier(),
                policy=policy,
                clock=clock,
            )
        )
        assert res.pending == []

    run(scenario())


def test_ec_b16_bucket_far_beyond_the_window_is_excluded():
    async def scenario():
        clock = FixedClock(datetime(2024, 1, 1, tzinfo=UTC))
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        repo = InMemoryRepo()
        await _grant(ledger, "cust_1", 100, datetime(2024, 1, 31, tzinfo=UTC), "g1")
        policy = resolve_policy({"credits": {"expiryNoticeDays": 7}})

        res = await notify_expiring(
            NotifyExpiringInput(
                customer_id="cust_1",
                ledger=ledger,
                repo=repo,
                notifier=NoopNotifier(),
                policy=policy,
                clock=clock,
            )
        )
        assert res.pending == []

    run(scenario())


def test_ec_b16_fully_consumed_bucket_not_reported():
    async def scenario():
        from boilpayment_core import ConsumeInput

        clock = FixedClock(datetime(2024, 1, 1, tzinfo=UTC))
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        repo = InMemoryRepo()
        expires_at = datetime(2024, 1, 5, tzinfo=UTC)
        await _grant(ledger, "cust_1", 100, expires_at, "g1")
        await ledger.consume(
            ConsumeInput(
                customer_id="cust_1",
                pool_order=["paid"],
                amount=100,
                idempotency_key="spend",
                meta=LedgerReference(),
                now=clock.now(),
                negative_balance="block",
                negative_floor=0,
            )
        )
        policy = resolve_policy({"credits": {"expiryNoticeDays": 7}})

        res = await notify_expiring(
            NotifyExpiringInput(
                customer_id="cust_1",
                ledger=ledger,
                repo=repo,
                notifier=NoopNotifier(),
                policy=policy,
                clock=clock,
            )
        )
        assert res.pending == []

    run(scenario())


def test_ec_b16_never_expiring_bucket_not_reported():
    async def scenario():
        clock = FixedClock(datetime(2024, 1, 1, tzinfo=UTC))
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        repo = InMemoryRepo()
        await _grant(ledger, "cust_1", 100, None, "g1")
        policy = resolve_policy({"credits": {"expiryNoticeDays": 7}})

        res = await notify_expiring(
            NotifyExpiringInput(
                customer_id="cust_1",
                ledger=ledger,
                repo=repo,
                notifier=NoopNotifier(),
                policy=policy,
                clock=clock,
            )
        )
        assert res.pending == []

    run(scenario())


def test_ec_b16_second_call_same_day_no_spam():
    async def scenario():
        clock = FixedClock(datetime(2024, 1, 1, tzinfo=UTC))
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        repo = InMemoryRepo()
        await _grant(ledger, "cust_1", 100, datetime(2024, 1, 5, tzinfo=UTC), "g1")
        policy = resolve_policy({"credits": {"expiryNoticeDays": 7}})

        first = await notify_expiring(
            NotifyExpiringInput(
                customer_id="cust_1",
                ledger=ledger,
                repo=repo,
                notifier=NoopNotifier(),
                policy=policy,
                clock=clock,
            )
        )
        assert len(first.pending) == 1

        second = await notify_expiring(
            NotifyExpiringInput(
                customer_id="cust_1",
                ledger=ledger,
                repo=repo,
                notifier=NoopNotifier(),
                policy=policy,
                clock=clock,
            )
        )
        assert second.pending == []

    run(scenario())


def test_ec_b16_next_day_reports_again_not_spam():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        repo = InMemoryRepo()
        day1 = FixedClock(datetime(2024, 1, 1, tzinfo=UTC))
        await _grant(ledger, "cust_1", 100, datetime(2024, 1, 5, tzinfo=UTC), "g1")
        policy = resolve_policy({"credits": {"expiryNoticeDays": 7}})

        await notify_expiring(
            NotifyExpiringInput(
                customer_id="cust_1",
                ledger=ledger,
                repo=repo,
                notifier=NoopNotifier(),
                policy=policy,
                clock=day1,
            )
        )

        day2 = FixedClock(datetime(2024, 1, 2, tzinfo=UTC))
        res = await notify_expiring(
            NotifyExpiringInput(
                customer_id="cust_1",
                ledger=ledger,
                repo=repo,
                notifier=NoopNotifier(),
                policy=policy,
                clock=day2,
            )
        )
        assert len(res.pending) == 1
        assert res.pending[0].expires_at == datetime(2024, 1, 5, tzinfo=UTC)

    run(scenario())


def test_ec_b16_customer_id_filters_to_one_customer():
    async def scenario():
        clock = FixedClock(datetime(2024, 1, 1, tzinfo=UTC))
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        repo = InMemoryRepo()
        await _grant(ledger, "cust_1", 100, datetime(2024, 1, 5, tzinfo=UTC), "g1")
        await _grant(ledger, "cust_2", 50, datetime(2024, 1, 5, tzinfo=UTC), "g2")
        policy = resolve_policy({"credits": {"expiryNoticeDays": 7}})

        res = await notify_expiring(
            NotifyExpiringInput(
                customer_id="cust_2",
                ledger=ledger,
                repo=repo,
                notifier=NoopNotifier(),
                policy=policy,
                clock=clock,
            )
        )
        assert len(res.pending) == 1
        assert res.pending[0].customer_id == "cust_2"
        assert res.pending[0].amount == 50

    run(scenario())


def test_ec_b16_no_customer_id_scans_repo_customers():
    async def scenario():
        clock = FixedClock(datetime(2024, 1, 1, tzinfo=UTC))
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        repo = InMemoryRepo()
        await repo.customers.put(
            Customer(
                id="cust_1",
                email=None,
                provider_refs=[],
                status="active",
                created_at=clock.now(),
            )
        )
        await repo.customers.put(
            Customer(
                id="cust_2",
                email=None,
                provider_refs=[],
                status="active",
                created_at=clock.now(),
            )
        )
        await _grant(ledger, "cust_1", 100, datetime(2024, 1, 5, tzinfo=UTC), "g1")
        await _grant(ledger, "cust_2", 50, datetime(2024, 1, 5, tzinfo=UTC), "g2")
        policy = resolve_policy({"credits": {"expiryNoticeDays": 7}})

        res = await notify_expiring(
            NotifyExpiringInput(
                ledger=ledger,
                repo=repo,
                notifier=NoopNotifier(),
                policy=policy,
                clock=clock,
            )
        )
        assert sorted(p.customer_id for p in res.pending) == ["cust_1", "cust_2"]

    run(scenario())
