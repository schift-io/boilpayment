"""spec: packages/credits/spec/credits.pseudo.md [EC:A15] [EC:B1] [EC:B7] [EC:B9] [EC:B10]"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest
from boilpayment_core import (
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    LedgerReference,
    Money,
    Payment,
    PaymentKitError,
    Period,
    Plan,
    PlanPrice,
    SequentialIdGen,
    Subscription,
    resolve_policy,
)
from boilpayment_credits import (
    ClawbackInput,
    ConsumeCreditsInput,
    GrantForPeriodInput,
    GrantPoolInput,
    ManualAdjustInput,
    TopupInput,
    clawback,
    consume,
    grant_for_period,
    grant_promo,
    grant_trial,
    manual_grant,
    manual_revoke,
    topup,
)

CLOCK = FixedClock(datetime(2024, 1, 1, tzinfo=UTC))
PLAN = Plan(
    id="plan_a",
    name="Plan A",
    interval="month",
    credits_per_period=100,
    usage_included=0,
    trial_days=0,
    prices=[PlanPrice(currency="USD", amount_minor=1000)],
)
PERIOD = Period(
    start=datetime(2024, 1, 1, tzinfo=UTC), end=datetime(2024, 2, 1, tzinfo=UTC)
)


def run(coro):
    return asyncio.run(coro)


def mk_sub(**overrides) -> Subscription:
    base = {
        "id": "sub_1",
        "customer_id": "cust_1",
        "plan_id": PLAN.id,
        "provider": "stripe",
        "provider_ref": "stripe_sub_1",
        "status": "active",
        "current_period": PERIOD,
        "anchor_day": 1,
        "cancel_at_period_end": False,
        "grace_until": None,
        "billing_key": None,
        "scheduled_plan_id": None,
        "created_at": CLOCK.now(),
    }
    base.update(overrides)
    return Subscription(**base)


def mk_payment(**overrides) -> Payment:
    base = {
        "id": "pay_1",
        "customer_id": "cust_1",
        "provider": "stripe",
        "provider_ref": "pi_1",
        "subscription_id": "sub_1",
        "amount": Money(amount_minor=1000, currency="USD"),
        "status": "succeeded",
        "kind": "subscription",
        "period": PERIOD,
        "occurred_at": CLOCK.now(),
        "failure": None,
    }
    base.update(overrides)
    return Payment(**base)


# ── EC:A15 defer during grace ────────────────────────────────────────────────


def test_ec_a15_past_due_defer_until_paid_default_defers_writes_nothing():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        policy = resolve_policy()
        sub = mk_sub(status="past_due")
        res = await grant_for_period(
            GrantForPeriodInput(
                sub=sub,
                plan=PLAN,
                period=PERIOD,
                payment=mk_payment(),
                policy=policy,
                ledger=ledger,
                clock=CLOCK,
            )
        )
        assert res.entry is None
        assert res.duplicated is False
        assert res.deferred is True
        bal = await ledger.balance("cust_1", None, CLOCK.now())
        assert bal.available == 0

    run(scenario())


def test_ec_a15_past_due_grant_anyway_grants_normally():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        policy = resolve_policy({"dunning": {"grantDuringGrace": "grant_anyway"}})
        sub = mk_sub(status="past_due")
        res = await grant_for_period(
            GrantForPeriodInput(
                sub=sub,
                plan=PLAN,
                period=PERIOD,
                payment=mk_payment(),
                policy=policy,
                ledger=ledger,
                clock=CLOCK,
            )
        )
        assert res.deferred is False
        assert res.entry.amount == 100
        bal = await ledger.balance("cust_1", None, CLOCK.now())
        assert bal.available == 100

    run(scenario())


def test_grant_for_period_active_sub_computes_unit_price_no_remainder():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        policy = resolve_policy()
        res = await grant_for_period(
            GrantForPeriodInput(
                sub=mk_sub(),
                plan=PLAN,
                period=PERIOD,
                payment=mk_payment(),
                policy=policy,
                ledger=ledger,
                clock=CLOCK,
            )
        )
        assert res.entry.amount == 100
        assert res.entry.unit_price_minor == 10
        assert res.entry.reason is None

    run(scenario())


def test_grant_for_period_records_leftover_remainder_in_reason():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        policy = resolve_policy()
        payment = mk_payment(amount=Money(amount_minor=1005, currency="USD"))
        res = await grant_for_period(
            GrantForPeriodInput(
                sub=mk_sub(),
                plan=PLAN,
                period=PERIOD,
                payment=payment,
                policy=policy,
                ledger=ledger,
                clock=CLOCK,
            )
        )
        assert res.entry.unit_price_minor == 10
        assert res.entry.reason == "remainder_minor:5"

    run(scenario())


# ── EC:B10 topup expiry ──────────────────────────────────────────────────────


def test_topup_expiry_days_none_never_expires():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        policy = resolve_policy()
        payment = mk_payment(
            id="pay_topup", amount=Money(amount_minor=500, currency="USD")
        )
        res = await topup(
            TopupInput(
                customer_id="cust_1",
                payment=payment,
                credits=50,
                policy=policy,
                ledger=ledger,
                clock=CLOCK,
            )
        )
        assert res.entry.expires_at is None

    run(scenario())


def test_topup_expiry_days_n_expires_n_days_from_now():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        policy = resolve_policy({"credits": {"topupExpiryDays": 30}})
        payment = mk_payment(
            id="pay_topup", amount=Money(amount_minor=500, currency="USD")
        )
        res = await topup(
            TopupInput(
                customer_id="cust_1",
                payment=payment,
                credits=50,
                policy=policy,
                ledger=ledger,
                clock=CLOCK,
            )
        )
        assert res.entry.expires_at == CLOCK.now() + timedelta(days=30)

    run(scenario())


# ── EC:J1-J5 topup operation idempotency (only when repo is provided) ────────


def test_j1_without_repo_topup_keeps_pre_existing_behavior_ledger_dedup_only():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        policy = resolve_policy()
        payment = mk_payment(
            id="pay_topup_norepo", amount=Money(amount_minor=500, currency="USD")
        )
        first = await topup(
            TopupInput(
                customer_id="cust_1",
                payment=payment,
                credits=50,
                policy=policy,
                ledger=ledger,
                clock=CLOCK,
            )
        )
        second = await topup(
            TopupInput(
                customer_id="cust_1",
                payment=payment,
                credits=50,
                policy=policy,
                ledger=ledger,
                clock=CLOCK,
            )
        )
        assert (
            second.duplicated is True
        )  # ledger.append's own idempotency_key UNIQUE dedup
        assert first.entry.id == second.entry.id
        bal = await ledger.balance("cust_1", "paid", CLOCK.now())
        assert bal.available == 50  # granted exactly once

    run(scenario())


def test_j1_with_repo_a_retried_topup_with_default_key_replays_first_grant_result():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        repo = InMemoryRepo()
        policy = resolve_policy()
        payment = mk_payment(
            id="pay_topup_repo", amount=Money(amount_minor=500, currency="USD")
        )
        first = await topup(
            TopupInput(
                customer_id="cust_1",
                payment=payment,
                credits=50,
                policy=policy,
                ledger=ledger,
                clock=CLOCK,
                repo=repo,
            )
        )
        second = await topup(
            TopupInput(
                customer_id="cust_1",
                payment=payment,
                credits=50,
                policy=policy,
                ledger=ledger,
                clock=CLOCK,
                repo=repo,
            )
        )
        assert second == first
        bal = await ledger.balance("cust_1", "paid", CLOCK.now())
        assert bal.available == 50  # granted exactly once

    run(scenario())


def test_j2_with_repo_same_key_different_payload_raises_idempotency_key_reused():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        repo = InMemoryRepo()
        policy = resolve_policy()
        payment = mk_payment(
            id="pay_topup_j2", amount=Money(amount_minor=500, currency="USD")
        )
        await topup(
            TopupInput(
                customer_id="cust_1",
                payment=payment,
                credits=50,
                policy=policy,
                ledger=ledger,
                clock=CLOCK,
                repo=repo,
            )
        )
        try:
            await topup(
                TopupInput(
                    customer_id="cust_1",
                    payment=payment,
                    credits=99,
                    policy=policy,
                    ledger=ledger,
                    clock=CLOCK,
                    repo=repo,
                )
            )
            raise AssertionError("expected idempotency_key_reused")
        except PaymentKitError as err:
            assert err.code == "idempotency_key_reused"

    run(scenario())


# ── EC:B7 pools separate ─────────────────────────────────────────────────────


def test_ec_b7_clawback_on_paid_leaves_promo_trial_untouched():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        policy = resolve_policy()
        await grant_for_period(
            GrantForPeriodInput(
                sub=mk_sub(),
                plan=PLAN,
                period=PERIOD,
                payment=mk_payment(),
                policy=policy,
                ledger=ledger,
                clock=CLOCK,
            )
        )
        await grant_promo(
            GrantPoolInput(
                customer_id="cust_1",
                amount=30,
                ledger=ledger,
                clock=CLOCK,
                idempotency_key="promo_1",
            )
        )
        await grant_trial(
            GrantPoolInput(
                customer_id="cust_1",
                amount=20,
                ledger=ledger,
                clock=CLOCK,
                idempotency_key="trial_1",
            )
        )

        await clawback(
            ClawbackInput(
                customer_id="cust_1",
                amount=40,
                policy=policy,
                ledger=ledger,
                clock=CLOCK,
                reason="test",
                reference=LedgerReference(),
                actor="system",
                idempotency_key="revoke:manual:1",
                shortfall="clamp_to_zero",
            )
        )

        paid_bal = await ledger.balance("cust_1", "paid", CLOCK.now())
        promo_bal = await ledger.balance("cust_1", "promo", CLOCK.now())
        trial_bal = await ledger.balance("cust_1", "trial", CLOCK.now())
        assert paid_bal.available == 60
        assert promo_bal.available == 30
        assert trial_bal.available == 20

    run(scenario())


# ── EC:B9 manual grant/revoke — reason and actor mandatory ──────────────────


def test_manual_grant_without_reason_raises():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        with pytest.raises(Exception):  # noqa: B017 -- fake raises a bare Exception on purpose
            await manual_grant(
                ManualAdjustInput(
                    customer_id="cust_1",
                    pool="paid",
                    amount=5,
                    reason="",
                    actor="admin",
                    ledger=ledger,
                    clock=CLOCK,
                    idempotency_key="k1",
                )
            )

    run(scenario())


def test_manual_revoke_without_actor_raises():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        with pytest.raises(Exception):  # noqa: B017 -- fake raises a bare Exception on purpose
            await manual_revoke(
                ManualAdjustInput(
                    customer_id="cust_1",
                    pool="paid",
                    amount=5,
                    reason="abuse",
                    actor="",
                    ledger=ledger,
                    clock=CLOCK,
                    idempotency_key="k1",
                )
            )

    run(scenario())


def test_manual_grant_revoke_with_reason_and_actor_succeed_source_manual():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        g = await manual_grant(
            ManualAdjustInput(
                customer_id="cust_1",
                pool="paid",
                amount=5,
                reason="goodwill",
                actor="admin",
                ledger=ledger,
                clock=CLOCK,
                idempotency_key="k1",
            )
        )
        assert g.entry.source == "manual"
        assert g.entry.amount == 5

    run(scenario())


# ── EC:B17 negative_offset — a negative balance settled against the next grant ──────────────


async def _seed_debt(ledger, amount: int):
    # manual_revoke writes exactly -amount regardless of current balance -- the simplest way to
    # land an unbucketed negative balance (the same shape EC:A4 allow_negative / EC:B4
    # allow_to_floor|allow_unbounded produce in practice).
    return await manual_revoke(
        ManualAdjustInput(
            customer_id="cust_1",
            pool="paid",
            amount=amount,
            reason="chargeback",
            actor="admin",
            ledger=ledger,
            clock=CLOCK,
            idempotency_key="debt_1",
        )
    )


def test_ec_b17_offset_next_grant_default_settles_debt_first_then_remainder_spendable():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        policy = (
            resolve_policy()
        )  # credits.negative_offset defaults to 'offset_next_grant'
        await _seed_debt(ledger, 30)
        assert (await ledger.balance("cust_1", "paid", CLOCK.now())).available == -30

        # PLAN.credits_per_period = 100 -- "80 granted, 30 applied, 50 available" scaled to 100/30/70.
        res = await grant_for_period(
            GrantForPeriodInput(
                sub=mk_sub(),
                plan=PLAN,
                period=PERIOD,
                payment=mk_payment(),
                policy=policy,
                ledger=ledger,
                clock=CLOCK,
            )
        )
        assert (
            res.entry.amount == 100
        )  # full grant amount still recorded ("100 granted")
        assert res.offset == 30  # "30 applied to the negative balance"
        assert len(res.offset_entries) == 2
        assert all(e.kind == "adjust" for e in res.offset_entries)
        assert sorted(e.amount for e in res.offset_entries) == [-30, 30]

        bal = await ledger.balance("cust_1", "paid", CLOCK.now())
        assert bal.available == 70  # "70 available"

    run(scenario())


def test_ec_b17_offset_caps_the_new_grants_bucket_consume_cannot_overdraw():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        policy = resolve_policy()
        await _seed_debt(ledger, 30)
        await grant_for_period(
            GrantForPeriodInput(
                sub=mk_sub(),
                plan=PLAN,
                period=PERIOD,
                payment=mk_payment(),
                policy=policy,
                ledger=ledger,
                clock=CLOCK,
            )
        )  # grants 100, offsets 30 -> 70 spendable

        # Without the bucket cap, a request for the full 100 would draw entirely from the fresh
        # bucket (which structurally has 100 remaining) even though only 70 is truly available.
        with pytest.raises(PaymentKitError) as exc_info:
            await consume(
                ConsumeCreditsInput(
                    customer_id="cust_1",
                    amount=100,
                    policy=policy,
                    ledger=ledger,
                    clock=CLOCK,
                    idempotency_key="spend_1",
                )
            )
        assert exc_info.value.code == "insufficient_balance"
        assert exc_info.value.shortfall == 30

        res = await consume(
            ConsumeCreditsInput(
                customer_id="cust_1",
                amount=70,
                policy=policy,
                ledger=ledger,
                clock=CLOCK,
                idempotency_key="spend_2",
            )
        )
        assert res.ok is True
        assert (await ledger.balance("cust_1", "paid", CLOCK.now())).available == 0

    run(scenario())


def test_ec_b17_negative_offset_never_leaves_debt_outstanding_bucket_not_capped():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        policy = resolve_policy({"credits": {"negativeOffset": "never"}})
        await _seed_debt(ledger, 30)

        res = await grant_for_period(
            GrantForPeriodInput(
                sub=mk_sub(),
                plan=PLAN,
                period=PERIOD,
                payment=mk_payment(),
                policy=policy,
                ledger=ledger,
                clock=CLOCK,
            )
        )
        assert res.offset == 0
        assert res.offset_entries == []

        # the fresh bucket is NOT capped: the full grant amount can still be drawn in one request...
        spend = await consume(
            ConsumeCreditsInput(
                customer_id="cust_1",
                amount=100,
                policy=policy,
                ledger=ledger,
                clock=CLOCK,
                idempotency_key="spend_never",
            )
        )
        assert spend.ok is True
        # ...which leaves the pre-existing debt sitting there, uncollected, as documented.
        assert (await ledger.balance("cust_1", "paid", CLOCK.now())).available == -30

    run(scenario())


def test_ec_b17_duplicated_grant_does_not_re_offset():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        policy = resolve_policy()
        await _seed_debt(ledger, 30)
        first = await grant_for_period(
            GrantForPeriodInput(
                sub=mk_sub(),
                plan=PLAN,
                period=PERIOD,
                payment=mk_payment(),
                policy=policy,
                ledger=ledger,
                clock=CLOCK,
            )
        )
        assert first.offset == 30

        second = await grant_for_period(
            GrantForPeriodInput(
                sub=mk_sub(),
                plan=PLAN,
                period=PERIOD,
                payment=mk_payment(),
                policy=policy,
                ledger=ledger,
                clock=CLOCK,
            )
        )
        assert second.duplicated is True
        assert second.offset == 0
        assert second.offset_entries == []
        assert (
            await ledger.balance("cust_1", "paid", CLOCK.now())
        ).available == 70  # unchanged

    run(scenario())


def test_ec_b17_no_debt_offset_is_a_no_op_even_under_offset_next_grant():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        policy = resolve_policy()
        res = await grant_for_period(
            GrantForPeriodInput(
                sub=mk_sub(),
                plan=PLAN,
                period=PERIOD,
                payment=mk_payment(),
                policy=policy,
                ledger=ledger,
                clock=CLOCK,
            )
        )
        assert res.offset == 0
        assert res.offset_entries == []
        assert (await ledger.balance("cust_1", "paid", CLOCK.now())).available == 100

    run(scenario())


def test_ec_b17_topup_also_settles_a_negative_balance():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        policy = resolve_policy()
        await _seed_debt(ledger, 20)
        payment = mk_payment(
            id="pay_topup_offset", amount=Money(amount_minor=500, currency="USD")
        )
        res = await topup(
            TopupInput(
                customer_id="cust_1",
                payment=payment,
                credits=50,
                policy=policy,
                ledger=ledger,
                clock=CLOCK,
            )
        )
        assert res.offset == 20
        assert len(res.offset_entries) == 2
        assert (
            await ledger.balance("cust_1", "paid", CLOCK.now())
        ).available == 30  # -20 + 50

    run(scenario())


# ── EC:L5 correlationId propagation ──────────────────────────────────────────


def test_ec_l5_grant_for_period_stamps_reference_correlation_id():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        policy = resolve_policy()
        res = await grant_for_period(
            GrantForPeriodInput(
                sub=mk_sub(),
                plan=PLAN,
                period=PERIOD,
                payment=mk_payment(),
                policy=policy,
                ledger=ledger,
                clock=CLOCK,
                correlation_id="corr_grant_1",
            )
        )
        assert res.entry.reference.correlation_id == "corr_grant_1"

    run(scenario())


def test_ec_l5_topup_stamps_reference_correlation_id():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        policy = resolve_policy()
        payment = mk_payment(
            id="pay_topup_corr", amount=Money(amount_minor=500, currency="USD")
        )
        res = await topup(
            TopupInput(
                customer_id="cust_1",
                payment=payment,
                credits=50,
                policy=policy,
                ledger=ledger,
                clock=CLOCK,
                correlation_id="corr_topup_1",
            )
        )
        assert res.entry.reference.correlation_id == "corr_topup_1"

    run(scenario())


def test_ec_l5_no_correlation_id_leaves_reference_correlation_id_none():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        policy = resolve_policy()
        res = await grant_for_period(
            GrantForPeriodInput(
                sub=mk_sub(),
                plan=PLAN,
                period=PERIOD,
                payment=mk_payment(),
                policy=policy,
                ledger=ledger,
                clock=CLOCK,
            )
        )
        assert res.entry.reference.correlation_id is None

    run(scenario())
