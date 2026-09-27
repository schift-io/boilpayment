"""Round-6 audit regressions (bp-audit6.md): A6-3 (EC:A50 row amount, A53 resolve), A6-4 (EC:A47 open
attempt), A6-5 (EC:A39 notice once), A6-7 (EC:A54 resume parked), I-1 (EC:A48 claim token).
Mirrors test/round6-lifecycle.test.ts."""

from __future__ import annotations

import dataclasses

import pytest
from boilpayment_core import (
    FixedClock,
    InMemoryRepo,
    Money,
    Payment,
    PaymentKitError,
    Period,
    PlanPrice,
)
from boilpayment_lifecycle import dunning, resolve_held_attempt, resume_parked
from boilpayment_lifecycle.charge_attempt import (
    attempt_payment_id,
    dunning_attempt_key,
    provider_order_id,
    renewal_attempt_key,
    with_attempt_lease,
)
from test_round5 import BASIC, T, d, mk_sub, retry_item, run

FEB = Period(start=d("2024-02-01T00:00:00Z"), end=d("2024-03-01T00:00:00Z"))
JAN = Period(start=d("2024-01-01T00:00:00Z"), end=d("2024-02-01T00:00:00Z"))


async def set_price(t: T, amount_minor: int) -> None:
    await t.repo.plans.put(
        dataclasses.replace(
            BASIC,
            prices=[
                PlanPrice(
                    currency="KRW", amount_minor=amount_minor, provider_price_refs={}
                )
            ],
        )
    )


def unsent_row(key: str, period: Period, amount_minor: int = 5000) -> Payment:
    """An attempt row written durably but never sent (the worker died before the provider call)."""
    return Payment(
        id=attempt_payment_id(key),
        customer_id="c1",
        provider="toss",
        provider_ref=provider_order_id(key),
        subscription_id="sub_1",
        amount=Money(amount_minor=amount_minor, currency="KRW"),
        status="pending",
        kind="subscription",
        period=period,
        occurred_at=period.start,
        failure=None,
        cash_receipt=None,
        raw={"boilpaymentAttemptKey": key},
    )


def _sub1():  # type: ignore[no-untyped-def]
    return mk_sub("2024-01-01T00:00:00Z", "2024-02-01T00:00:00Z")


def test_a6_3_price_raised_after_lost_answer_settles() -> None:
    async def body() -> None:
        t = await T(_sub1()).init()
        t.provider.lose_next_answer = True
        await t.tick("2024-02-01T01:00:00Z")
        await set_price(t, 6000)
        await t.tick("2024-02-01T01:10:00Z")
        assert t.moved("2024-02-01") == 1
        assert [
            f"{p.status}:{p.amount.amount_minor}" for p in await t.repo.payments.list()
        ] == ["succeeded:5000"]
        assert (await t.cur()).status == "active"
        assert await t.usable("2024-02-02T00:00:00Z") == 100
        assert t.notices("attempt_lookup_mismatch") == []

    run(body())


def test_a6_3_redrive_resends_the_row_amount() -> None:
    async def body() -> None:
        t = await T(_sub1()).init()
        key = renewal_attempt_key(_sub1(), FEB)
        await t.repo.payments.put(unsent_row(key, FEB))
        await set_price(t, 6000)
        await t.tick("2024-02-01T01:00:00Z")
        assert t.provider.last_charge is not None
        assert (
            t.provider.last_charge["amount_minor"],
            t.provider.last_charge["idempotency_key"],
        ) == (5000, key)

    run(body())


def test_a6_3_legacy_charge_of_another_amount_settles_with_notice() -> None:
    async def body() -> None:
        t = await T(
            mk_sub("2024-01-01T00:00:00Z", "2024-02-01T00:00:00Z", "past_due")
        ).init()
        await t.repo.outbox.put(
            retry_item(1, "sent", "2024-02-01T01:00:00Z", "2024-02-02T01:00:00Z")
        )
        await t.repo.outbox.put(
            retry_item(2, "pending", "2024-02-02T01:00:00Z", "2024-02-02T03:00:00Z")
        )
        t.provider.seed_order("dunning-retry:sub_1:1", "succeeded", 4000)
        assert await t.retries("2024-02-02T03:00:00Z") == ["recovered"]
        assert (await t.cur()).status == "active"
        assert await t.usable("2024-02-02T04:00:00Z") == 100
        assert len(t.notices("legacy_settled_at_provider_amount")) == 1
        assert t.notices("attempt_lookup_mismatch") == []
        assert t.provider.order_ids == []

    run(body())


def test_a53_settle_a_held_attempt() -> None:
    async def body() -> None:
        t = await T(_sub1()).init()
        t.provider.lose_next_answer = True
        await t.tick("2024-02-01T01:00:00Z")
        t.provider.lookup_override = lambda _id, found: (
            dataclasses.replace(found, amount=Money(amount_minor=4500, currency="KRW"))
            if found is not None
            else None
        )
        await t.tick("2024-02-01T01:10:00Z")
        (held,) = await t.repo.payments.list()
        assert len(t.notices("attempt_lookup_mismatch")) == 1
        r = await resolve_held_attempt(
            payment_id=held.id,
            decision="settle",
            actor="ops@x",
            provider=t.provider,
            policy=t.policy,
            ledger=t.ledger,
            repo=t.repo,
            clock=t.clk("2024-02-02T00:00:00Z"),
        )
        assert (r.payment.status, r.payment.amount.amount_minor) == ("succeeded", 4500)
        assert r.sub is not None and r.sub.status == "active"
        assert await t.usable("2024-02-02T01:00:00Z") == 100
        await t.tick("2024-02-02T02:00:00Z")
        assert t.moved("2024-02-01") == 1
        with pytest.raises(PaymentKitError) as err:
            await resolve_held_attempt(
                payment_id=held.id,
                decision="void",
                actor="x",
                provider=t.provider,
                policy=t.policy,
                ledger=t.ledger,
                repo=t.repo,
                clock=t.clk("2024-02-02T03:00:00Z"),
            )
        assert err.value.code == "attempt_not_held"

    run(body())


def test_a53_void_a_held_refunded_order() -> None:
    async def body() -> None:
        t = await T(_sub1()).init()
        t.provider.lose_next_answer = True
        await t.tick("2024-02-01T01:00:00Z")
        t.provider.lookup_override = lambda _id, found: (
            dataclasses.replace(found, status="refunded") if found is not None else None
        )
        await t.tick("2024-02-01T01:10:00Z")
        (held,) = await t.repo.payments.list()
        with pytest.raises(PaymentKitError) as err:
            await resolve_held_attempt(
                payment_id=held.id,
                decision="settle",
                actor="x",
                provider=t.provider,
                policy=t.policy,
                ledger=t.ledger,
                repo=t.repo,
                clock=t.clk("2024-02-02T00:00:00Z"),
            )
        assert err.value.code == "held_order_not_paid"
        r = await resolve_held_attempt(
            payment_id=held.id,
            decision="void",
            actor="x",
            provider=t.provider,
            policy=t.policy,
            ledger=t.ledger,
            repo=t.repo,
            notifier=t.notifier,
            clock=t.clk("2024-02-02T00:00:00Z"),
        )
        assert r.payment.status == "failed"
        assert r.sub is not None and r.sub.status == "past_due"
        assert await t.usable("2024-02-02T01:00:00Z") == 0
        due = await dunning.retry_due(
            dunning.RetryDueInput(repo=t.repo, clock=t.clk("2024-02-10T00:00:00Z"))
        )
        assert len(due) == 1

    run(body())


def test_a6_4_unsent_scheduler_attempt_then_cron_stopped() -> None:
    async def body() -> None:
        t = await T(_sub1()).init()
        key = renewal_attempt_key(_sub1(), FEB)
        await t.repo.payments.put(unsent_row(key, FEB))
        for at in (
            "2024-04-15T00:00:00Z",
            "2024-04-15T00:10:00Z",
            "2024-05-01T01:00:00Z",
        ):
            await t.tick(at)
        assert t.moved("2024-02-01") == 0
        assert t.moved("2024-04-01") == 1
        assert t.moved("2024-05-01") == 1
        closed = await t.repo.payments.get(attempt_payment_id(key))
        assert (
            closed is not None
            and closed.failure is not None
            and closed.failure.code == "order_not_found"
        )
        assert len(t.notices("missed_periods_skipped")) == 1

    run(body())


def test_a6_4_unsent_dunning_retry_then_retries_stopped() -> None:
    async def body() -> None:
        t = await T(
            mk_sub("2024-01-01T00:00:00Z", "2024-02-01T00:00:00Z", "past_due")
        ).init()
        key = dunning_attempt_key(_sub1(), FEB, 1)
        await t.repo.payments.put(unsent_row(key, FEB))
        await t.repo.outbox.put(
            retry_item(1, "pending", "2024-02-01T01:00:00Z", "2024-02-03T00:00:00Z")
        )
        assert await t.retries("2024-04-15T00:00:00Z") == ["recovered"]
        assert t.moved("2024-02-01") == 0
        assert t.moved("2024-04-01") == 1
        assert (await t.cur()).current_period.start == d("2024-04-01T00:00:00Z")

    run(body())


def test_a6_5_legacy_settlement_of_an_ended_subscription_is_told_once() -> None:
    async def body() -> None:
        t = await T(
            mk_sub("2023-12-01T00:00:00Z", "2024-01-01T00:00:00Z", "expired")
        ).init()
        await t.repo.outbox.put(
            retry_item(1, "sent", "2024-01-01T01:00:00Z", "2024-01-02T01:00:00Z")
        )
        await t.repo.outbox.put(
            retry_item(2, "sent", "2024-01-02T01:00:00Z", "2024-01-03T01:00:00Z")
        )
        t.provider.seed_order("dunning-retry:sub_1:1", "succeeded")
        await t.repo.payments.put(
            dataclasses.replace(
                unsent_row(dunning_attempt_key(_sub1(), JAN, 2), JAN), status="failed"
            )
        )
        for at in (
            "2024-02-06T01:00:00Z",
            "2024-02-06T01:10:00Z",
            "2024-02-06T01:20:00Z",
            "2024-02-07T01:00:00Z",
        ):
            await t.tick(at)
        assert len(t.notices("renewal_settled_after_end")) == 1
        assert await t.usable("2024-01-20T00:00:00Z") == 100

    run(body())


def test_a54_resume_a_parked_subscription() -> None:
    async def body() -> None:
        t = await T(_sub1(), missed="needs_human_only").init()
        await t.tick("2024-04-15T00:00:00Z")
        assert (await t.cur()).status == "past_due"
        with pytest.raises(PaymentKitError) as err:
            await resume_parked(
                subscription_id="nope",
                actor="x",
                policy=t.policy,
                repo=t.repo,
                clock=t.clk("2024-04-16T00:00:00Z"),
            )
        assert err.value.code == "not_parked"
        resumed = await resume_parked(
            subscription_id="sub_1",
            actor="ops@x",
            policy=t.policy,
            repo=t.repo,
            notifier=t.notifier,
            clock=t.clk("2024-04-16T00:00:00Z"),
        )
        assert resumed.status == "active"
        assert resumed.current_period.start == d("2024-03-01T00:00:00Z")
        await t.tick("2024-04-16T00:10:00Z")
        await t.tick("2024-04-16T00:20:00Z")
        assert len(t.provider.money_moved) == 1
        assert t.moved("2024-04-01") == 1
        assert (await t.cur()).status == "active"
        assert len(t.notices("missed_periods_parked")) == 1
        assert len(t.notices("missed_periods_resumed")) == 1

    run(body())


def test_a48_claim_writes_the_owner_token() -> None:
    async def body() -> None:
        repo = InMemoryRepo()
        clock = FixedClock(d("2024-02-01T00:00:00Z"))

        async def inside() -> None:
            row = await repo.operations.get("charge-lease:k")
            assert (
                row is not None
                and isinstance(row.result, dict)
                and row.result.get("token")
            )
            late = await repo.operations.compare_and_set(
                dataclasses.replace(row, result=None),
                dataclasses.replace(row, result={"unleasedSince": "x"}),
            )
            assert late is False

        held, _ = await with_attempt_lease(repo, clock, "k", inside)
        assert held

    run(body())


