"""Round-6 audit A6-2 / A6-8 (bp-audit6.md): canonical UTC time in keys (EC:J11), DST rule (EC:J12).

A payment period that reaches Python with a +09:00 tzinfo (psycopg under a non-UTC session) and the
same instant in UTC must be one grant; a grant written under an old ``isoformat()`` key is recognised.
Mirrors test/round6-keys.test.ts."""
from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta, timezone

from boilpayment_core import (
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    LedgerReference,
    Money,
    NewLedgerEntry,
    Payment,
    Period,
    Plan,
    PlanPrice,
    SequentialIdGen,
    Subscription,
    next_period,
    resolve_policy,
)
from boilpayment_lifecycle import OnRenewalPaidInput, on_renewal_paid

KST = timezone(timedelta(hours=9))
PLAN = Plan(id="p", name="P", interval="month", credits_per_period=100, usage_included=0, trial_days=0,
            prices=[PlanPrice(currency="KRW", amount_minor=5000)])
JAN = Period(start=datetime(2024, 1, 1, tzinfo=UTC), end=datetime(2024, 2, 1, tzinfo=UTC))
FEB_UTC = Period(start=datetime(2024, 2, 1, tzinfo=UTC), end=datetime(2024, 3, 1, tzinfo=UTC))
FEB_KST = Period(start=datetime(2024, 2, 1, 9, tzinfo=KST), end=datetime(2024, 3, 1, 9, tzinfo=KST))


def sub() -> Subscription:
    return Subscription(id="s1", customer_id="c1", plan_id="p", provider="toss", provider_ref=None, status="active",
                        current_period=JAN, anchor_day=1, cancel_at_period_end=False, grace_until=None,
                        billing_key="bk", scheduled_plan_id=None, created_at=JAN.start, currency="KRW")


def pay(pid: str, period: Period) -> Payment:
    return Payment(id=pid, customer_id="c1", provider="toss", provider_ref="pk_" + pid, subscription_id="s1",
                   amount=Money(amount_minor=5000, currency="KRW"), status="succeeded", kind="subscription",
                   period=period, occurred_at=FEB_UTC.start, failure=None)


async def _renew(repo, ledger, payment):  # type: ignore[no-untyped-def]
    s = await repo.subscriptions.get("s1")
    return await on_renewal_paid(OnRenewalPaidInput(sub=s, payment=payment, policy=resolve_policy(), ledger=ledger,
                                                    repo=repo, clock=FixedClock(FEB_UTC.start)))


async def _setup():  # type: ignore[no-untyped-def]
    repo, ledger = InMemoryRepo(), InMemoryLedger(SequentialIdGen("l_"))
    await repo.plans.put(PLAN)
    await repo.subscriptions.put(sub())
    return repo, ledger


def test_same_period_in_two_tz_forms_is_one_grant() -> None:
    async def go() -> None:
        repo, ledger = await _setup()
        await _renew(repo, ledger, pay("a", FEB_KST))
        await _renew(repo, ledger, pay("b", FEB_UTC))
        grants = await ledger.entries("c1", kind="grant", source="subscription")
        assert [g.idempotency_key for g in grants] == ["grant:s1:2024-02-01T00:00:00.000Z"]
    asyncio.run(go())


def test_grant_under_old_isoformat_key_is_recognised() -> None:
    async def go() -> None:
        repo, ledger = await _setup()
        await ledger.append(NewLedgerEntry(customer_id="c1", pool="paid", kind="grant", amount=100, unit_price_minor=50,
                                           currency="KRW", expires_at=FEB_UTC.end, source="subscription",
                                           reference=LedgerReference(subscription_id="s1"),
                                           idempotency_key="grant:s1:2024-02-01T09:00:00+09:00", actor="system", reason=None))
        r = await _renew(repo, ledger, pay("b", FEB_UTC))
        assert r.duplicated
        assert len(await ledger.entries("c1", kind="grant", source="subscription")) == 1
    asyncio.run(go())


def test_next_period_start_is_utc_whatever_the_input_tz() -> None:
    p = next_period(FEB_KST, "month", 1, "UTC", "clamp_keep_original_day")
    assert p.start.utcoffset() == timedelta(0)
    assert p.start == FEB_UTC.end
