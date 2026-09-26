"""EC:I10 settlement report. Mirrors ts/test/settlementReport.test.ts (same cases, same numbers)."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest
from boilpayment_core import (
    ConsumeInput,
    Customer,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    LedgerReference,
    Money,
    NewLedgerEntry,
    Payment,
    Refund,
    SequentialIdGen,
)
from boilpayment_cs import (
    CreditLine,
    NetLine,
    PaymentLine,
    RefundLine,
    settlement_report,
)

JAN = datetime(2026, 1, 1, tzinfo=UTC)
FEB = datetime(2026, 2, 1, tzinfo=UTC)


def pay(pid, at, amount, currency, kind, status="succeeded"):
    return Payment(
        id=pid, customer_id="c1", provider="stripe", provider_ref=f"pi_{pid}", subscription_id=None,
        amount=Money(amount_minor=amount, currency=currency), status=status, kind=kind, period=None,
        occurred_at=at, failure=None,
    )


def refund(rid, at, amount, currency, status="succeeded"):
    return Refund(
        id=rid, payment_id="p1", customer_id="c1", amount=Money(amount_minor=amount, currency=currency), status=status,
        provider_ref=f"re_{rid}", credits_revoked=0, rule_id="D2", reason=None, failure=None, created_at=at,
    )


def grant(key, amount, source):
    return NewLedgerEntry(
        customer_id="c1", pool="paid", kind="grant", amount=amount, source=source, idempotency_key=key, actor="s"
    )


def test_groups_inside_window_per_currency_and_source():
    async def body():
        clock = FixedClock(datetime(2026, 1, 10, tzinfo=UTC))
        ledger = InMemoryLedger(SequentialIdGen("l_"), clock)
        repo = InMemoryRepo()
        await repo.customers.put(Customer(id="c1", email=None, provider_refs=[], status="active", created_at=clock.now()))
        for p in (
            pay("p1", datetime(2026, 1, 5, tzinfo=UTC), 1000, "USD", "subscription"),
            pay("p2", datetime(2026, 1, 20, tzinfo=UTC), 500, "USD", "topup"),
            pay("p3", datetime(2026, 1, 21, tzinfo=UTC), 9900, "KRW", "topup"),
            pay("p4", datetime(2026, 1, 22, tzinfo=UTC), 700, "USD", "topup", "failed"),
            pay("p5", FEB, 999, "USD", "topup"),
        ):
            await repo.payments.put(p)
        await repo.refunds.put(refund("r1", datetime(2026, 1, 25, tzinfo=UTC), 300, "USD"))
        await repo.refunds.put(refund("r2", datetime(2026, 1, 26, tzinfo=UTC), 100, "USD", "failed"))
        await ledger.append(grant("g1", 100, "subscription"))
        await ledger.append(grant("g2", 50, "topup"))
        await ledger.consume(
            ConsumeInput(
                customer_id="c1", pool_order=["paid"], amount=30, idempotency_key="u1", meta=LedgerReference(),
                now=clock.now(), negative_balance="block", negative_floor=0,
            )
        )
        clock.advance(int(timedelta(days=40).total_seconds() * 1000))
        await ledger.append(grant("g3", 7, "manual"))

        r = await settlement_report(repo=repo, ledger=ledger, start=JAN, end=FEB)
        assert r.payments == [
            PaymentLine(currency="KRW", kind="topup", status="succeeded", count=1, amount_minor=9900),
            PaymentLine(currency="USD", kind="subscription", status="succeeded", count=1, amount_minor=1000),
            PaymentLine(currency="USD", kind="topup", status="failed", count=1, amount_minor=700),
            PaymentLine(currency="USD", kind="topup", status="succeeded", count=1, amount_minor=500),
        ]
        assert r.refunds == [RefundLine(currency="USD", count=1, amount_minor=300)]
        assert r.net == [NetLine(currency="KRW", amount_minor=9900), NetLine(currency="USD", amount_minor=1200)]
        assert r.credits == [
            CreditLine(kind="consume", source="usage", count=1, amount=-30),
            CreditLine(kind="grant", source="subscription", count=1, amount=100),
            CreditLine(kind="grant", source="topup", count=1, amount=50),
        ]

    asyncio.run(body())


def test_writes_nothing_and_refuses_empty_window():
    async def body():
        repo, ledger = InMemoryRepo(), InMemoryLedger(SequentialIdGen("l_"))
        with pytest.raises(ValueError, match="start must be before end"):
            await settlement_report(repo=repo, ledger=ledger, start=FEB, end=JAN)
        r = await settlement_report(repo=repo, ledger=ledger, start=JAN, end=FEB)
        assert (r.payments, r.refunds, r.net, r.credits) == ([], [], [], [])
        assert await repo.payments.list() == []

    asyncio.run(body())
