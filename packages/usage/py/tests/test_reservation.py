"""EC:C10 usage reservations. spec: packages/usage/spec/usage.pseudo.md
Mirrors packages/usage/ts/test/reservation.test.ts (same cases, same numbers).
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

import pytest
from boilpayment_core import (
    DEFAULT_POLICY,
    Customer,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    NewLedgerEntry,
    PaymentKitError,
    SequentialIdGen,
)
from boilpayment_usage import (
    commit,
    list_reservations,
    release,
    reserve,
    sweep_reservations,
)

C = "cust_1"
TTL_MS = (DEFAULT_POLICY.usage.reservation_ttl_minutes + 1) * 60_000


async def harness(credits: int = 100):
    clock = FixedClock(datetime(2026, 5, 15, tzinfo=UTC))
    ledger = InMemoryLedger(SequentialIdGen("id_"), clock)
    repo = InMemoryRepo()
    await repo.customers.put(Customer(id=C, email=None, provider_refs=[], status="active", created_at=clock.now()))
    await ledger.append(
        NewLedgerEntry(
            customer_id=C, pool="paid", kind="grant", amount=credits, source="manual",
            idempotency_key="seed", actor="test", reason="seed",
        )
    )
    deps = {"customer_id": C, "policy": DEFAULT_POLICY, "ledger": ledger, "clock": clock}
    return clock, ledger, repo, deps


async def available(ledger: InMemoryLedger, clock: FixedClock) -> int:
    return (await ledger.balance(C, None, clock.now())).available


def test_reserve_holds_budget_and_second_job_gets_structured_shortfall():
    async def body():
        clock, ledger, _, deps = await harness(100)
        a = await reserve(**deps, job_id="job_a", amount=70)
        assert a.ok and not a.duplicated and a.reservation.status == "held" and a.reservation.amount == 70
        assert await available(ledger, clock) == 30
        b = await reserve(**deps, job_id="job_b", amount=40)
        assert (b.ok, b.reason, b.need, b.available) == (False, "insufficient", 40, 30)
        assert await available(ledger, clock) == 30

    asyncio.run(body())


def test_reserve_is_idempotent_per_job():
    async def body():
        clock, ledger, _, deps = await harness(100)
        await reserve(**deps, job_id="job_a", amount=70)
        again = await reserve(**deps, job_id="job_a", amount=70)
        assert again.ok and again.duplicated
        assert await available(ledger, clock) == 30

    asyncio.run(body())


def test_commit_charges_actual_and_returns_rest_repeat_is_noop():
    async def body():
        clock, ledger, _, deps = await harness(100)
        await reserve(**deps, job_id="job_a", amount=70)
        done = await commit(**deps, job_id="job_a", amount=45)
        assert not done.duplicated and done.reservation.status == "committed" and done.reservation.committed_amount == 45
        assert await available(ledger, clock) == 55
        again = await commit(**deps, job_id="job_a", amount=45)
        assert again.duplicated
        assert await available(ledger, clock) == 55
        consumed = sum(-e.amount for e in await ledger.entries(C, kind="consume"))
        assert consumed == 45

    asyncio.run(body())


def test_commit_above_reservation_refused_hold_stays():
    async def body():
        clock, ledger, _, deps = await harness(100)
        await reserve(**deps, job_id="job_a", amount=20)
        with pytest.raises(PaymentKitError) as e:
            await commit(**deps, job_id="job_a", amount=21)
        assert e.value.code == "reservation_exceeded"
        assert await available(ledger, clock) == 80

    asyncio.run(body())


def test_release_charges_nothing_commit_after_release_refused():
    async def body():
        clock, ledger, _, deps = await harness(100)
        await reserve(**deps, job_id="job_a", amount=70)
        assert (await release(**deps, job_id="job_a")).reservation.status == "released"
        assert await available(ledger, clock) == 100
        with pytest.raises(PaymentKitError) as e:
            await commit(**deps, job_id="job_a", amount=10)
        assert e.value.code == "reservation_closed"
        assert (await release(**deps, job_id="job_a")).duplicated

    asyncio.run(body())


def test_commit_of_zero_records_zero_charge():
    async def body():
        clock, ledger, _, deps = await harness(100)
        await reserve(**deps, job_id="job_a", amount=30)
        r = await commit(**deps, job_id="job_a", amount=0)
        assert r.reservation.status == "committed" and r.reservation.committed_amount == 0
        assert await available(ledger, clock) == 100

    asyncio.run(body())


def test_sweep_releases_expired_and_commit_refused():
    async def body():
        clock, ledger, repo, deps = await harness(100)
        await reserve(**deps, job_id="job_a", amount=70)
        clock.advance(TTL_MS)
        assert await sweep_reservations(repo=repo, ledger=ledger, clock=clock) == {"expired": 1}
        assert await available(ledger, clock) == 100
        with pytest.raises(PaymentKitError) as e:
            await commit(**deps, job_id="job_a", amount=10)
        assert e.value.code == "reservation_closed"
        assert (await list_reservations(customer_id=C, ledger=ledger))[0].status == "expired"
        assert await sweep_reservations(repo=repo, ledger=ledger, clock=clock) == {"expired": 0}

    asyncio.run(body())


def test_expired_unswept_hold_refused_at_commit_and_stops_blocking():
    async def body():
        clock, ledger, _, deps = await harness(100)
        await reserve(**deps, job_id="job_a", amount=90)
        clock.advance(TTL_MS)
        with pytest.raises(PaymentKitError) as e:
            await commit(**deps, job_id="job_a", amount=10)
        assert e.value.code == "reservation_expired"
        assert (await reserve(**deps, job_id="job_b", amount=90)).ok
        assert await available(ledger, clock) == 10

    asyncio.run(body())


def test_concurrent_reserves_for_last_budget_exactly_one_wins():
    async def body():
        clock, ledger, _, deps = await harness(100)
        results = await asyncio.gather(*(reserve(**deps, job_id=f"job_{i}", amount=60) for i in range(5)))
        assert sum(1 for r in results if r.ok) == 1
        assert await available(ledger, clock) == 40

    asyncio.run(body())


def test_bad_input_rejected():
    async def body():
        _, _, _, deps = await harness(100)
        for kwargs, code in (
            ({"job_id": "job_a", "amount": 0}, "reservation_invalid"),
            ({"job_id": "", "amount": 1}, "reservation_invalid"),
        ):
            with pytest.raises(PaymentKitError) as e:
                await reserve(**deps, **kwargs)
            assert e.value.code == code
        with pytest.raises(PaymentKitError) as e:
            await commit(**deps, job_id="nope", amount=1)
        assert e.value.code == "reservation_not_found"

    asyncio.run(body())
