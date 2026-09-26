"""Phase 6 regression tests — packages/refund (py). Real code paths against the core in-memory
doubles; only PaymentProvider is faked. Mirrors packages/refund/ts/test/refund.test.ts (same
cases, same expected numbers). See docs/EDGE_CASES.md D1-D15/B13/B8, examples/e2e/FINDINGS.md.

pytest-asyncio is not installed here: every test wraps its async body with asyncio.run(...).
"""

from __future__ import annotations

import asyncio
import dataclasses
from datetime import UTC, datetime

import pytest
from boilpayment_core import (
    DEFAULT_POLICY,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    LedgerReference,
    Money,
    NewLedgerEntry,
    NormalizedEvent,
    Payment,
    PaymentKitError,
    Refund,
    SequentialIdGen,
    resolve_policy,
)
from boilpayment_refund import (
    EvaluateInput,
    ExecuteInput,
    OnExternalRefundInput,
    evaluate,
    execute,
    on_external_refund,
)

CUSTOMER_ID = "cust_1"
DAY_MS = 86_400_000


# ── shared fake provider (implements every PaymentProvider method used, throws if unexpected) ──


class FakeProvider:
    name = "stripe"

    def capabilities(self):
        return {
            "native_subscriptions": True,
            "partial_refund": True,
            "meters": False,
            "scheduling": "provider",
            "webhook_signature": True,
        }

    async def create_customer(self, **kwargs):
        raise NotImplementedError("unused: create_customer")

    async def create_checkout(self, *args, **kwargs):
        raise NotImplementedError("unused: create_checkout")

    async def get_payment(self, *args, **kwargs):
        raise NotImplementedError("unused: get_payment")

    async def list_payments(self, **kwargs):
        return []

    async def get_subscription(self, *args, **kwargs):
        raise NotImplementedError("unused: get_subscription")

    async def change_subscription(self, *args, **kwargs):
        raise NotImplementedError("unused: change_subscription")

    async def cancel_subscription(self, *args, **kwargs):
        raise NotImplementedError("unused: cancel_subscription")

    async def charge_billing_key(self, **kwargs):
        raise NotImplementedError("unused: charge_billing_key")

    async def refund(self, *, payment_ref, amount, reason, idempotency_key, extra=None):
        return Refund(
            id=f"cancel_{payment_ref}",
            payment_id="unused",
            customer_id="",
            amount=amount,
            status="succeeded",
            provider_ref=f"pref_{payment_ref}",
            credits_revoked=0,
            rule_id="",
            reason=None,
            failure=None,
            created_at=datetime.now(UTC),
        )

    async def report_usage(self, **kwargs):
        return None

    async def verify_webhook(self, **kwargs):
        raise NotImplementedError("unused: verify_webhook")


class ReceiveAccountRequiredProvider(FakeProvider):
    async def refund(self, *, payment_ref, amount, reason, idempotency_key, extra=None):
        raise PaymentKitError(
            "refundReceiveAccount required for Toss virtual account refunds",
            "refund_receive_account_required",
        )


class AlwaysFailProvider(FakeProvider):
    async def refund(self, *, payment_ref, amount, reason, idempotency_key, extra=None):
        return dataclasses.replace(await super().refund(
            payment_ref=payment_ref, amount=amount, reason=reason,
            idempotency_key=idempotency_key, extra=extra,
        ), status="failed")


class ProviderWithCashReceiptCancel(FakeProvider):
    """EC:K5 — duck-typed extra method, not part of PaymentProvider (mirrors TossProvider/PortoneProvider)."""

    def __init__(self) -> None:
        self.cash_receipt_cancel_calls: list[dict] = []

    async def cancel_cash_receipt(
        self, *, payment_ref, receipt_key=None, amount_minor=None
    ):
        self.cash_receipt_cancel_calls.append(
            {
                "payment_ref": payment_ref,
                "receipt_key": receipt_key,
                "amount_minor": amount_minor,
            }
        )
        return {"status": "canceled"}


class ProviderWithFailingCashReceiptCancel(FakeProvider):
    async def cancel_cash_receipt(
        self, *, payment_ref, receipt_key=None, amount_minor=None
    ):
        raise RuntimeError("toss cash receipt cancel failed")


class RecordingProvider(FakeProvider):
    """EC:L5 — mirrors providers/*'s real with_correlation_id (a shallow clone carrying an
    override), so this proves the SAME duck-typed contract refund/execute.py relies on."""

    def __init__(self) -> None:
        self.correlation_id_override: str | None = None
        self.received_correlation_ids: list[str | None] = []

    def with_correlation_id(self, correlation_id: str) -> RecordingProvider:
        clone = RecordingProvider()
        clone.received_correlation_ids = self.received_correlation_ids
        clone.correlation_id_override = correlation_id
        return clone

    async def refund(self, *, payment_ref, amount, reason, idempotency_key, extra=None):
        self.received_correlation_ids.append(self.correlation_id_override)
        return await super().refund(
            payment_ref=payment_ref,
            amount=amount,
            reason=reason,
            idempotency_key=idempotency_key,
            extra=extra,
        )


class FixedIdGen:
    """Always returns the same id — simulates a caller retrying execute() for the same refund."""

    def new_id(self) -> str:
        return "refund_fixed"


def make_env():
    clock = FixedClock(datetime(2026, 1, 1, tzinfo=UTC))
    ids = SequentialIdGen("id_")
    ledger = InMemoryLedger(ids)
    repo = InMemoryRepo()
    policy = DEFAULT_POLICY
    return clock, ids, ledger, repo, policy


async def make_topup(
    repo, clock, id_: str, amount_minor: int, currency: str = "USD"
) -> Payment:
    payment = Payment(
        id=id_,
        customer_id=CUSTOMER_ID,
        provider="stripe",
        provider_ref=f"pi_{id_}",
        subscription_id=None,
        amount=Money(amount_minor=amount_minor, currency=currency),
        status="succeeded",
        kind="topup",
        period=None,
        occurred_at=clock.now(),
        failure=None,
    )
    await repo.payments.put(payment)
    return payment


async def do_grant(
    ledger,
    payment_id: str,
    credits: int,
    unit_price_minor: int,
    currency: str = "USD",
    expires_at=None,
    key: str | None = None,
):
    result = await ledger.append(
        NewLedgerEntry(
            customer_id=CUSTOMER_ID,
            pool="paid",
            kind="grant",
            amount=credits,
            unit_price_minor=unit_price_minor,
            currency=currency,
            expires_at=expires_at,
            source="topup",
            reference=LedgerReference(payment_id=payment_id),
            idempotency_key=key or f"topup:{payment_id}",
            actor="system",
        )
    )
    return result.entry


async def do_consume(ledger, clock, policy, amount: int, key: str):
    from boilpayment_core import ConsumeInput

    return await ledger.consume(
        ConsumeInput(
            customer_id=CUSTOMER_ID,
            pool_order=["paid"],
            amount=amount,
            idempotency_key=key,
            meta=LedgerReference(),
            now=clock.now(),
            negative_balance=policy.credits.negative_balance,
            negative_floor=policy.credits.negative_floor,
            reason="usage",
        )
    )


# ═══════════════════════════════ refund.evaluate ═══════════════════════════════


def test_d1_full_refund_inside_no_questions_window():
    async def run():
        clock, _ids, ledger, repo, policy = make_env()
        p = await make_topup(repo, clock, "pay_d1", 1000)
        await do_grant(ledger, p.id, 100, 10)
        clock.advance(3 * DAY_MS)
        decision = await evaluate(
            EvaluateInput(
                payment=p, policy=policy, ledger=ledger, repo=repo, clock=clock
            )
        )
        assert decision.eligible is True
        assert decision.rule_id == "D1"
        assert decision.amount.amount_minor == 1000
        assert decision.credits_to_revoke == 100
        assert decision.needs_human is False

    asyncio.run(run())


def test_d1_b13_measured_smoke_scenario_clamp_and_reduce_refund():
    async def run():
        clock, _ids, ledger, repo, policy = make_env()
        p = await make_topup(repo, clock, "pay_1", 1000)
        await do_grant(ledger, p.id, 100, 10)
        c = await do_consume(ledger, clock, policy, 40, "consume:1")
        assert c.ok is True
        assert (await ledger.balance(CUSTOMER_ID, "paid", clock.now())).available == 60
        clock.advance(3 * DAY_MS)
        decision = await evaluate(
            EvaluateInput(
                payment=p, policy=policy, ledger=ledger, repo=repo, clock=clock
            )
        )
        assert decision.rule_id == "D1"
        assert decision.amount.amount_minor == 600
        assert decision.credits_to_revoke == 60
        assert "B13 clamp_and_reduce_refund" in decision.reason

    asyncio.run(run())


def test_d2_measured_smoke_scenario_unused_credits_outside_window():
    async def run():
        clock, _ids, ledger, repo, policy = make_env()
        p = await make_topup(repo, clock, "pay_2", 1000)
        await do_grant(ledger, p.id, 100, 10)
        await do_consume(ledger, clock, policy, 30, "consume:2")
        clock.advance(20 * DAY_MS)
        decision = await evaluate(
            EvaluateInput(
                payment=p, policy=policy, ledger=ledger, repo=repo, clock=clock
            )
        )
        assert decision.rule_id == "D2"
        assert decision.amount.amount_minor == 700
        assert decision.credits_to_revoke == 70
        assert "unused_credits" in decision.reason

    asyncio.run(run())


def test_d2_time_prorated_d3_within_elapsed_ratio_no_deny_floor_rounding():
    async def run():
        clock, _ids, ledger, repo, policy = make_env()
        pol = resolve_policy({"refund": {"method": "time_prorated"}})
        from boilpayment_core import Period

        period = Period(
            start=datetime(2026, 1, 1, tzinfo=UTC),
            end=datetime(2026, 1, 31, tzinfo=UTC),
        )
        p = Payment(
            id="pay_tp",
            customer_id=CUSTOMER_ID,
            provider="stripe",
            provider_ref="pi_tp",
            subscription_id="sub_1",
            amount=Money(amount_minor=3000, currency="USD"),
            status="succeeded",
            kind="subscription",
            period=period,
            occurred_at=period.start,
            failure=None,
        )
        await repo.payments.put(p)
        await do_grant(ledger, p.id, 100, 30)  # unitPrice 30 -> matches 3000/100
        await do_consume(
            ledger, clock, policy, 50, "consume:tp"
        )  # consumedRatio 0.5 <= elapsedRatio 2/3 @ day20
        clock.advance(
            20 * DAY_MS
        )  # remaining 10/30 -> ratio 1/3 -> amount round(3000/3)=1000
        decision = await evaluate(
            EvaluateInput(payment=p, policy=pol, ledger=ledger, repo=repo, clock=clock)
        )
        assert decision.eligible is True
        assert decision.rule_id == "D2"
        assert decision.amount.amount_minor == 1000
        assert decision.credits_to_revoke == 1000 // 30  # floor_credits default

    asyncio.run(run())


def test_d3_overuse_denies_time_prorated_when_deny_default():
    async def run():
        clock, _ids, ledger, repo, policy = make_env()
        pol = resolve_policy({"refund": {"method": "time_prorated"}})
        from boilpayment_core import Period

        period = Period(
            start=datetime(2026, 1, 1, tzinfo=UTC),
            end=datetime(2026, 1, 31, tzinfo=UTC),
        )
        p = Payment(
            id="pay_d3",
            customer_id=CUSTOMER_ID,
            provider="stripe",
            provider_ref="pi_d3",
            subscription_id="sub_1",
            amount=Money(amount_minor=3000, currency="USD"),
            status="succeeded",
            kind="subscription",
            period=period,
            occurred_at=period.start,
            failure=None,
        )
        await repo.payments.put(p)
        await do_grant(ledger, p.id, 100, 30)
        await do_consume(
            ledger, clock, policy, 80, "consume:d3"
        )  # consumedRatio 0.8 > elapsedRatio 2/3 @ day20
        clock.advance(20 * DAY_MS)
        decision = await evaluate(
            EvaluateInput(payment=p, policy=pol, ledger=ledger, repo=repo, clock=clock)
        )
        assert decision.eligible is False
        assert decision.rule_id == "D3"
        assert "overuse" in decision.reason

    asyncio.run(run())


def test_d3_refund_time_prorated_anyway_computes_refund_despite_overuse():
    async def run():
        clock, _ids, ledger, repo, policy = make_env()
        pol = resolve_policy(
            {
                "refund": {
                    "method": "time_prorated",
                    "overuse_behavior": "refund_time_prorated_anyway",
                }
            }
        )
        from boilpayment_core import Period

        period = Period(
            start=datetime(2026, 1, 1, tzinfo=UTC),
            end=datetime(2026, 1, 31, tzinfo=UTC),
        )
        p = Payment(
            id="pay_d3b",
            customer_id=CUSTOMER_ID,
            provider="stripe",
            provider_ref="pi_d3b",
            subscription_id="sub_1",
            amount=Money(amount_minor=3000, currency="USD"),
            status="succeeded",
            kind="subscription",
            period=period,
            occurred_at=period.start,
            failure=None,
        )
        await repo.payments.put(p)
        await do_grant(ledger, p.id, 100, 30)
        await do_consume(ledger, clock, policy, 80, "consume:d3b")
        clock.advance(20 * DAY_MS)
        decision = await evaluate(
            EvaluateInput(payment=p, policy=pol, ledger=ledger, repo=repo, clock=clock)
        )
        assert decision.eligible is True
        assert decision.rule_id == "D2"
        # time_prorated computes 1000 minor / 33 credits, but B13 clamp_and_reduce_refund (default) then
        # clamps against the post-overuse balance (100 granted - 80 consumed = 20 available):
        # ratio 20/33 -> floor(1000 * 20/33) = 606 minor, 20 credits revoked.
        assert decision.amount.amount_minor == 606
        assert decision.credits_to_revoke == 20
        assert "B13 clamp_and_reduce_refund" in decision.reason

    asyncio.run(run())


def test_d2_min_of_both_picks_unused_credits_when_smaller():
    async def run():
        clock, _ids, ledger, repo, policy = make_env()
        pol = resolve_policy({"refund": {"method": "min_of_both"}})
        from boilpayment_core import Period

        period = Period(
            start=datetime(2026, 1, 1, tzinfo=UTC),
            end=datetime(2026, 1, 31, tzinfo=UTC),
        )
        p = Payment(
            id="pay_mob1",
            customer_id=CUSTOMER_ID,
            provider="stripe",
            provider_ref="pi_mob1",
            subscription_id="sub_1",
            amount=Money(amount_minor=3000, currency="USD"),
            status="succeeded",
            kind="subscription",
            period=period,
            occurred_at=period.start,
            failure=None,
        )
        await repo.payments.put(p)
        await do_grant(ledger, p.id, 20, 30)  # total value 600 minor
        await do_consume(
            ledger, clock, policy, 1, "consume:mob1"
        )  # unused=19 -> 570 minor
        clock.advance(20 * DAY_MS)  # time_prorated amount = 1000 minor
        decision = await evaluate(
            EvaluateInput(payment=p, policy=pol, ledger=ledger, repo=repo, clock=clock)
        )
        assert decision.rule_id == "D2"
        assert "unused_credits" in decision.reason
        assert decision.amount.amount_minor == (19 * 30)

    asyncio.run(run())


def test_d2_min_of_both_picks_time_prorated_when_smaller():
    async def run():
        clock, _ids, ledger, repo, policy = make_env()
        pol = resolve_policy({"refund": {"method": "min_of_both"}})
        from boilpayment_core import Period

        period = Period(
            start=datetime(2026, 1, 1, tzinfo=UTC),
            end=datetime(2026, 1, 31, tzinfo=UTC),
        )
        p = Payment(
            id="pay_mob2",
            customer_id=CUSTOMER_ID,
            provider="stripe",
            provider_ref="pi_mob2",
            subscription_id="sub_1",
            amount=Money(amount_minor=3000, currency="USD"),
            status="succeeded",
            kind="subscription",
            period=period,
            occurred_at=period.start,
            failure=None,
        )
        await repo.payments.put(p)
        await do_grant(ledger, p.id, 100, 30)  # unused up to 3000 minor value
        await do_consume(
            ledger, clock, policy, 10, "consume:mob2"
        )  # consumedRatio 0.1, within elapsed ratio
        clock.advance(20 * DAY_MS)  # time_prorated = 1000 minor < unused (2700 minor)
        decision = await evaluate(
            EvaluateInput(payment=p, policy=pol, ledger=ledger, repo=repo, clock=clock)
        )
        assert decision.rule_id == "D2"
        assert "time_prorated" in decision.reason
        assert decision.amount.amount_minor == 1000

    asyncio.run(run())


def test_d2_deny_method_ineligible():
    async def run():
        clock, _ids, ledger, repo, _policy = make_env()
        pol = resolve_policy({"refund": {"method": "deny"}})
        p = await make_topup(repo, clock, "pay_deny", 1000)
        await do_grant(ledger, p.id, 100, 10)
        clock.advance(20 * DAY_MS)
        decision = await evaluate(
            EvaluateInput(payment=p, policy=pol, ledger=ledger, repo=repo, clock=clock)
        )
        assert decision.eligible is False
        assert decision.rule_id == "D2"

    asyncio.run(run())


def test_d10_velocity_guard_flips_needs_human():
    async def run():
        clock, _ids, ledger, repo, policy = make_env()
        p = await make_topup(repo, clock, "pay_d10", 1000)
        await do_grant(ledger, p.id, 100, 10)
        past = Refund(
            id="r_past_1",
            payment_id="other",
            customer_id=CUSTOMER_ID,
            amount=Money(amount_minor=100, currency="USD"),
            status="succeeded",
            provider_ref=None,
            credits_revoked=0,
            rule_id="D1",
            reason=None,
            failure=None,
            created_at=clock.now(),
        )
        await repo.refunds.put(past)
        await repo.refunds.put(
            Refund(
                id="r_past_2",
                payment_id="other",
                customer_id=CUSTOMER_ID,
                amount=Money(amount_minor=100, currency="USD"),
                status="succeeded",
                provider_ref=None,
                credits_revoked=0,
                rule_id="D1",
                reason=None,
                failure=None,
                created_at=clock.now(),
            )
        )
        clock.advance(3 * DAY_MS)
        decision = await evaluate(
            EvaluateInput(
                payment=p, policy=policy, ledger=ledger, repo=repo, clock=clock
            )
        )
        assert decision.needs_human is True
        assert decision.rule_id == "D10"
        assert "velocity" in decision.reason

    asyncio.run(run())


def test_i1_auto_approve_max_amount_minor():
    async def run():
        clock, _ids, ledger, repo, _policy = make_env()
        pol = resolve_policy(
            {"cs": {"auto_approve": {"max_amount_minor": 100, "max_credits": 10_000}}}
        )
        p = await make_topup(repo, clock, "pay_i1a", 1000)
        await do_grant(ledger, p.id, 100, 10)
        clock.advance(3 * DAY_MS)
        decision = await evaluate(
            EvaluateInput(payment=p, policy=pol, ledger=ledger, repo=repo, clock=clock)
        )
        assert decision.eligible is True
        assert decision.needs_human is True

    asyncio.run(run())


def test_i1_auto_approve_max_credits():
    async def run():
        clock, _ids, ledger, repo, _policy = make_env()
        pol = resolve_policy(
            {"cs": {"auto_approve": {"max_amount_minor": 1_000_000, "max_credits": 10}}}
        )
        p = await make_topup(repo, clock, "pay_i1b", 1000)
        await do_grant(ledger, p.id, 100, 10)
        clock.advance(3 * DAY_MS)
        decision = await evaluate(
            EvaluateInput(payment=p, policy=pol, ledger=ledger, repo=repo, clock=clock)
        )
        assert decision.eligible is True
        assert decision.needs_human is True

    asyncio.run(run())


def test_b13_clamp_to_zero_leaves_amount_unchanged():
    async def run():
        clock, _ids, ledger, repo, policy = make_env()
        pol = resolve_policy({"refund": {"revoke_shortfall": "clamp_to_zero"}})
        p = await make_topup(repo, clock, "pay_b13a", 1000)
        await do_grant(ledger, p.id, 100, 10)
        await do_consume(ledger, clock, policy, 40, "consume:b13a")
        clock.advance(3 * DAY_MS)
        decision = await evaluate(
            EvaluateInput(payment=p, policy=pol, ledger=ledger, repo=repo, clock=clock)
        )
        assert decision.amount.amount_minor == 1000
        assert decision.credits_to_revoke == 60
        assert "clamp_to_zero" in decision.reason

    asyncio.run(run())


def test_b13_allow_negative_leaves_original_target():
    async def run():
        clock, _ids, ledger, repo, policy = make_env()
        pol = resolve_policy({"refund": {"revoke_shortfall": "allow_negative"}})
        p = await make_topup(repo, clock, "pay_b13b", 1000)
        await do_grant(ledger, p.id, 100, 10)
        await do_consume(ledger, clock, policy, 40, "consume:b13b")
        clock.advance(3 * DAY_MS)
        decision = await evaluate(
            EvaluateInput(payment=p, policy=pol, ledger=ledger, repo=repo, clock=clock)
        )
        assert decision.amount.amount_minor == 1000
        assert decision.credits_to_revoke == 100
        assert "allow_negative" in decision.reason

    asyncio.run(run())


def test_findings1_regression_evaluate_uses_injected_clock_not_wall_time():
    async def run():
        # Real wall time is well past 2026-01 (system date 2026-09-09). A grant expiring 2026-06-01
        # is "not yet expired" under the FixedClock (now=2026-01-01) but WOULD look expired under
        # datetime.now(UTC). Before the fix, ledger.balance() was called without `now` and defaulted
        # to the real wall clock, making every grant look already-expired.
        clock, _ids, ledger, repo, policy = make_env()
        p = await make_topup(repo, clock, "pay_findings1", 1000)
        await do_grant(
            ledger, p.id, 100, 10, expires_at=datetime(2026, 6, 1, tzinfo=UTC)
        )
        clock.advance(3 * DAY_MS)  # day 3, still well before expiresAt under FixedClock
        decision = await evaluate(
            EvaluateInput(
                payment=p, policy=policy, ledger=ledger, repo=repo, clock=clock
            )
        )
        assert decision.eligible is True
        assert (
            decision.credits_to_revoke == 100
        )  # not 0 / not phantom-negative-balance-driven
        assert decision.amount.amount_minor == 1000

    asyncio.run(run())


def test_findings1_regression_b8_fallback_uses_injected_clock():
    async def run():
        # Second call site from FINDINGS.md #1: consumedFromGrants' B8 fallback (no attributed
        # consume entries at all -> approximate via ledger.balance()). Exercise the D2 branch (day
        # > no_questions_days) with zero consumption so the fallback formula alone decides the
        # outcome. Same wall-clock-vs-FixedClock trap as above.
        clock, _ids, ledger, repo, policy = make_env()
        p = await make_topup(repo, clock, "pay_findings1b", 1000)
        await do_grant(
            ledger, p.id, 100, 10, expires_at=datetime(2026, 6, 1, tzinfo=UTC)
        )
        clock.advance(
            20 * DAY_MS
        )  # day 20, outside the 7-day window -> unused_credits branch
        decision = await evaluate(
            EvaluateInput(
                payment=p, policy=policy, ledger=ledger, repo=repo, clock=clock
            )
        )
        assert decision.eligible is True
        assert decision.rule_id == "D2"
        # correct (FixedClock-aware): consumed=0 -> unused=100 -> amount=round(100*10)=1000, credits=100.
        # buggy (wall-clock): grant looks expired -> balance=0 -> consumed=100 -> unused=0 -> amount=0.
        assert decision.amount.amount_minor == 1000
        assert decision.credits_to_revoke == 100

    asyncio.run(run())


# ═══════════════════════════════ refund.execute ═══════════════════════════════


def test_d15_hold_revoke_release_ordering_attributed_to_grant():
    async def run():
        clock, ids, ledger, repo, policy = make_env()
        p = await make_topup(repo, clock, "pay_exec1", 1000)
        g = await do_grant(ledger, p.id, 100, 10)
        clock.advance(3 * DAY_MS)
        decision = await evaluate(
            EvaluateInput(
                payment=p, policy=policy, ledger=ledger, repo=repo, clock=clock
            )
        )
        provider = FakeProvider()
        refund = await execute(
            ExecuteInput(
                decision=decision,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )

        assert refund.status == "succeeded"
        assert refund.credits_revoked == 100

        entries = await ledger.entries(CUSTOMER_ID)
        kinds = [e.kind for e in entries if e.reference.refund_id == refund.id]
        assert kinds == ["hold", "revoke", "release"]

        revoke_entry = next(
            e
            for e in entries
            if e.kind == "revoke" and e.reference.refund_id == refund.id
        )
        assert revoke_entry.reference.grant_id == g.id
        assert revoke_entry.idempotency_key == f"revoke:refund:{refund.id}:{g.id}"

        hold_entry = next(
            e
            for e in entries
            if e.kind == "hold" and e.reference.refund_id == refund.id
        )
        assert hold_entry.idempotency_key == f"hold:refund:{refund.id}"
        release_entry = next(
            e
            for e in entries
            if e.kind == "release" and e.reference.refund_id == refund.id
        )
        assert release_entry.idempotency_key == f"release:refund:{refund.id}"

        assert (await ledger.balance(CUSTOMER_ID, "paid", clock.now())).available == 0

    asyncio.run(run())


def test_d15_b8_multi_grant_revoke_attribution_findings3_regression():
    async def run():
        # EC:D15/B8 — a refund spanning 2+ grants must write one revoke entry PER grant, each
        # carrying that grant's id (FINDINGS.md #3 regression: previously a single unattributed
        # revoke entry was written instead).
        clock, ids, ledger, repo, policy = make_env()
        p = await make_topup(repo, clock, "pay_multi", 2000)
        g_a = await do_grant(ledger, p.id, 60, 10)  # idempotencyKey `topup:pay_multi`
        g_b = await do_grant(
            ledger, p.id, 140, 10, key=f"topup:{p.id}:2"
        )  # second bucket, own key
        clock.advance(3 * DAY_MS)
        decision = await evaluate(
            EvaluateInput(
                payment=p, policy=policy, ledger=ledger, repo=repo, clock=clock
            )
        )
        assert (
            decision.credits_to_revoke == 200
        )  # 60 + 140, no consumption -> D1 full revoke

        refund = await execute(
            ExecuteInput(
                decision=decision,
                provider=FakeProvider(),
                ledger=ledger,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )
        assert refund.status == "succeeded"
        assert refund.credits_revoked == 200

        revoke_entries = [
            e
            for e in await ledger.entries(CUSTOMER_ID, kind="revoke")
            if e.reference.refund_id == refund.id
        ]
        assert (
            len(revoke_entries) == 2
        )  # one per grant bucket, not one unattributed lump entry

        by_grant = {e.reference.grant_id: e for e in revoke_entries}
        assert by_grant[g_a.id].amount == -60
        assert by_grant[g_a.id].idempotency_key == f"revoke:refund:{refund.id}:{g_a.id}"
        assert by_grant[g_b.id].amount == -140
        assert by_grant[g_b.id].idempotency_key == f"revoke:refund:{refund.id}:{g_b.id}"

        assert (await ledger.balance(CUSTOMER_ID, "paid", clock.now())).available == 0

    asyncio.run(run())


def test_d15_hold_reduces_balance_before_provider_call_resolves():
    async def run():
        clock, ids, ledger, repo, policy = make_env()
        p = await make_topup(repo, clock, "pay_hold", 1000)
        await do_grant(ledger, p.id, 100, 10)
        clock.advance(3 * DAY_MS)
        decision = await evaluate(
            EvaluateInput(
                payment=p, policy=policy, ledger=ledger, repo=repo, clock=clock
            )
        )

        gate = asyncio.Event()
        observed: dict = {}

        class DeferredProvider(FakeProvider):
            async def refund(
                self, *, payment_ref, amount, reason, idempotency_key, extra=None
            ):
                await gate.wait()
                return await super().refund(
                    payment_ref=payment_ref,
                    amount=amount,
                    reason=reason,
                    idempotency_key=idempotency_key,
                    extra=extra,
                )

        provider = DeferredProvider()
        task = asyncio.create_task(
            execute(
                ExecuteInput(
                    decision=decision,
                    provider=provider,
                    ledger=ledger,
                    repo=repo,
                    clock=clock,
                    ids=ids,
                )
            )
        )
        await asyncio.sleep(
            0
        )  # let execute() reach the hold append before the provider call blocks
        await asyncio.sleep(0)
        mid_flight = await ledger.balance(CUSTOMER_ID, "paid", clock.now())
        observed["mid_flight_available"] = mid_flight.available

        gate.set()
        refund = await task
        assert observed["mid_flight_available"] == 0  # 100 - 100 (held)
        assert refund.status == "succeeded"
        assert (await ledger.balance(CUSTOMER_ID, "paid", clock.now())).available == 0

    asyncio.run(run())


def test_d12_provider_refund_failure_releases_hold_no_permanent_revoke():
    async def run():
        clock, ids, ledger, repo, policy = make_env()
        p = await make_topup(repo, clock, "pay_d12", 1000)
        await do_grant(ledger, p.id, 100, 10)
        clock.advance(3 * DAY_MS)
        decision = await evaluate(
            EvaluateInput(
                payment=p, policy=policy, ledger=ledger, repo=repo, clock=clock
            )
        )
        before = (await ledger.balance(CUSTOMER_ID, "paid", clock.now())).available
        refund = await execute(
            ExecuteInput(
                decision=decision,
                provider=AlwaysFailProvider(),
                ledger=ledger,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )

        assert refund.status == "failed"
        assert refund.credits_revoked == 0
        after = (await ledger.balance(CUSTOMER_ID, "paid", clock.now())).available
        assert after == before

        entries = await ledger.entries(CUSTOMER_ID, kind="revoke")
        assert [e for e in entries if e.reference.refund_id == refund.id] == []

    asyncio.run(run())


def test_d13_toss_refund_receive_account_required():
    async def run():
        clock, ids, ledger, repo, policy = make_env()
        p = await make_topup(repo, clock, "pay_d13", 1000, "KRW")
        await do_grant(ledger, p.id, 100, 10, "KRW")
        decision = await evaluate(
            EvaluateInput(
                payment=p, policy=policy, ledger=ledger, repo=repo, clock=clock
            )
        )  # fresh -> D1
        before = (await ledger.balance(CUSTOMER_ID, "paid", clock.now())).available

        opened: dict | None = None

        class CsStub:
            async def open_refund_failed_case(
                self, *, customer_id, reference_id, reason, needs=None
            ):
                nonlocal opened
                opened = {
                    "customer_id": customer_id,
                    "reference_id": reference_id,
                    "reason": reason,
                    "needs": needs,
                }

        refund = await execute(
            ExecuteInput(
                decision=decision,
                provider=ReceiveAccountRequiredProvider(),
                ledger=ledger,
                repo=repo,
                clock=clock,
                ids=ids,
                cs=CsStub(),
            )
        )

        assert refund.status == "failed"
        assert refund.failure.code == "refund_receive_account_required"
        assert (
            await ledger.balance(CUSTOMER_ID, "paid", clock.now())
        ).available == before
        assert opened is not None
        assert opened["needs"] == "refund_receive_account"

    asyncio.run(run())


def _with_cancel_on_refund(policy, value: bool):
    return dataclasses.replace(
        policy,
        cash_receipt=dataclasses.replace(policy.cash_receipt, cancel_on_refund=value),
    )


def test_ec_k5_cancel_on_refund_true_calls_provider_cancel_cash_receipt():
    async def run():
        clock, ids, ledger, repo, policy = make_env()
        p = await make_topup(repo, clock, "pay_k5", 1000, "KRW")
        await do_grant(ledger, p.id, 100, 10, "KRW")
        decision = await evaluate(
            EvaluateInput(
                payment=p, policy=policy, ledger=ledger, repo=repo, clock=clock
            )
        )
        provider = ProviderWithCashReceiptCancel()
        pol = _with_cancel_on_refund(policy, True)

        refund = await execute(
            ExecuteInput(
                decision=decision,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
                ids=ids,
                policy=pol,
                extra={"cashReceiptKey": "receipt_123"},
            )
        )

        assert refund.status == "succeeded"
        assert len(provider.cash_receipt_cancel_calls) == 1
        assert provider.cash_receipt_cancel_calls[0]["payment_ref"] == "pi_pay_k5"
        assert provider.cash_receipt_cancel_calls[0]["receipt_key"] == "receipt_123"

    asyncio.run(run())


def test_ec_k5_cancel_on_refund_false_does_not_call_provider():
    async def run():
        clock, ids, ledger, repo, policy = make_env()
        p = await make_topup(repo, clock, "pay_k5b", 1000, "KRW")
        await do_grant(ledger, p.id, 100, 10, "KRW")
        decision = await evaluate(
            EvaluateInput(
                payment=p, policy=policy, ledger=ledger, repo=repo, clock=clock
            )
        )
        provider = ProviderWithCashReceiptCancel()
        pol = _with_cancel_on_refund(policy, False)

        await execute(
            ExecuteInput(
                decision=decision,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
                ids=ids,
                policy=pol,
                extra={"cashReceiptKey": "receipt_123"},
            )
        )

        assert len(provider.cash_receipt_cancel_calls) == 0

    asyncio.run(run())


def test_ec_k5_no_cash_receipt_key_does_not_call_provider():
    async def run():
        clock, ids, ledger, repo, policy = make_env()
        p = await make_topup(repo, clock, "pay_k5c", 1000, "KRW")
        await do_grant(ledger, p.id, 100, 10, "KRW")
        decision = await evaluate(
            EvaluateInput(
                payment=p, policy=policy, ledger=ledger, repo=repo, clock=clock
            )
        )
        provider = ProviderWithCashReceiptCancel()
        pol = _with_cancel_on_refund(policy, True)

        await execute(
            ExecuteInput(
                decision=decision,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
                ids=ids,
                policy=pol,
            )
        )

        assert len(provider.cash_receipt_cancel_calls) == 0

    asyncio.run(run())


def test_ec_k6_cash_receipt_cancel_failure_does_not_roll_back_refund():
    async def run():
        clock, ids, ledger, repo, policy = make_env()
        p = await make_topup(repo, clock, "pay_k6", 1000, "KRW")
        await do_grant(ledger, p.id, 100, 10, "KRW")
        decision = await evaluate(
            EvaluateInput(
                payment=p, policy=policy, ledger=ledger, repo=repo, clock=clock
            )
        )
        provider = ProviderWithFailingCashReceiptCancel()
        pol = _with_cancel_on_refund(policy, True)

        opened: dict | None = None

        class CsStub:
            async def open_refund_failed_case(
                self, *, customer_id, reference_id, reason, needs=None
            ):
                nonlocal opened
                opened = {
                    "customer_id": customer_id,
                    "reference_id": reference_id,
                    "reason": reason,
                    "needs": needs,
                }

        refund = await execute(
            ExecuteInput(
                decision=decision,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
                ids=ids,
                policy=pol,
                extra={"cashReceiptKey": "receipt_123"},
                cs=CsStub(),
            )
        )

        assert refund.status == "succeeded"  # K6 — refund success is never rolled back
        assert opened is not None
        assert opened["needs"] == "cash_receipt_cancel_failed"

    asyncio.run(run())


# ═══════════════════════════════ refund.on_external_refund ═══════════════════════════════


class ReconcileMismatchCsStub:
    def __init__(self):
        self.calls: list[dict] = []

    async def open_reconcile_mismatch_case(self, *, customer_id, reference_id, reason):
        self.calls.append(
            {"customer_id": customer_id, "reference_id": reference_id, "reason": reason}
        )


def test_d8_matched_payment_creates_revoke_idempotent_by_refund_reference():
    async def run():
        clock, ids, ledger, repo, _policy = make_env()
        cs = ReconcileMismatchCsStub()
        p = await make_topup(repo, clock, "pay_d8", 1000)
        await do_grant(ledger, p.id, 100, 10)
        event = NormalizedEvent(
            id="evt_ext_1",
            refund_ref="re_ext_1",
            provider="stripe",
            type="refund.created",
            occurred_at=clock.now(),
            customer_ref="cus_1",
            subscription_ref=None,
            payment_ref=p.provider_ref,
            amount=Money(amount_minor=1000, currency="USD"),
            raw={},
        )
        first = await on_external_refund(
            OnExternalRefundInput(
                event=event, ledger=ledger, repo=repo, cs=cs, clock=clock, ids=ids
            )
        )
        assert first.status == "succeeded"
        assert first.provider_ref == "re_ext_1"
        assert (await ledger.balance(CUSTOMER_ID, "paid", clock.now())).available == 0

        second = await on_external_refund(
            OnExternalRefundInput(
                event=event, ledger=ledger, repo=repo, cs=cs, clock=clock, ids=ids
            )
        )
        assert second.id == first.id  # no-op / same record, not a duplicate revoke
        assert (await ledger.balance(CUSTOMER_ID, "paid", clock.now())).available == 0

    asyncio.run(run())


def test_d8_unmatched_payment_opens_reconcile_mismatch_case():
    async def run():
        clock, ids, ledger, repo, _policy = make_env()
        cs = ReconcileMismatchCsStub()
        event = NormalizedEvent(
            id="evt_ext_unknown",
            refund_ref="re_ext_unknown",
            provider="stripe",
            type="refund.created",
            occurred_at=clock.now(),
            customer_ref="cus_unknown",
            subscription_ref=None,
            payment_ref="pi_does_not_exist",
            amount=Money(amount_minor=500, currency="USD"),
            raw={},
        )
        with pytest.raises(PaymentKitError):
            await on_external_refund(
                OnExternalRefundInput(
                    event=event, ledger=ledger, repo=repo, cs=cs, clock=clock, ids=ids
                )
            )
        assert await repo.refunds.list() == []
        assert len(cs.calls) == 1

    asyncio.run(run())


def test_d15_b8_retry_same_refund_id_is_idempotent():
    async def run():
        # EC:D15/B8 — retrying execute() with the SAME refund_id must not revoke twice.
        clock, _ids, ledger, repo, policy = make_env()
        p = await make_topup(repo, clock, "pay_retry", 2000)
        await do_grant(ledger, p.id, 60, 10)
        await do_grant(ledger, p.id, 140, 10, key=f"topup:{p.id}:2")
        clock.advance(3 * DAY_MS)
        decision = await evaluate(
            EvaluateInput(
                payment=p, policy=policy, ledger=ledger, repo=repo, clock=clock
            )
        )
        fixed = FixedIdGen()
        first = await execute(
            ExecuteInput(
                decision=decision,
                provider=FakeProvider(),
                ledger=ledger,
                repo=repo,
                clock=clock,
                ids=fixed,
            )
        )
        assert first.status == "succeeded"
        assert (await ledger.balance(CUSTOMER_ID, "paid", clock.now())).available == 0

        second = await execute(
            ExecuteInput(
                decision=decision,
                provider=FakeProvider(),
                ledger=ledger,
                repo=repo,
                clock=clock,
                ids=fixed,
            )
        )
        assert second.status == "succeeded"
        assert (
            await ledger.balance(CUSTOMER_ID, "paid", clock.now())
        ).available == 0  # was -200 before the fix
        revokes = [
            e
            for e in await ledger.entries(CUSTOMER_ID, kind="revoke")
            if e.reference.refund_id == "refund_fixed"
        ]
        assert sum(-e.amount for e in revokes) == 200

    asyncio.run(run())


# ═══════════════════════════════ EC:J1-J5 operation idempotency ═══════════════════════════════


class CountingProvider(FakeProvider):
    def __init__(self):
        self.calls = 0

    async def refund(self, *, payment_ref, amount, reason, idempotency_key, extra=None):
        self.calls += 1
        return await super().refund(
            payment_ref=payment_ref,
            amount=amount,
            reason=reason,
            idempotency_key=idempotency_key,
            extra=extra,
        )


def test_j1_retried_execute_with_default_key_replays_first_refund_without_calling_provider_again():
    async def run():
        clock, ids, ledger, repo, policy = make_env()
        p = await make_topup(repo, clock, "pay_j1", 1000)
        await do_grant(ledger, p.id, 100, 10)
        clock.advance(3 * DAY_MS)
        decision = await evaluate(
            EvaluateInput(
                payment=p, policy=policy, ledger=ledger, repo=repo, clock=clock
            )
        )
        provider = CountingProvider()

        first = await execute(
            ExecuteInput(
                decision=decision,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )
        second = await execute(
            ExecuteInput(
                decision=decision,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )

        assert second == first
        assert provider.calls == 1  # not re-charged/re-refunded at the provider
        assert (
            len(await ledger.entries(CUSTOMER_ID, kind="revoke")) == 1
        )  # not double-revoked

    asyncio.run(run())


def test_j2_retried_execute_with_same_key_but_different_decision_raises_idempotency_key_reused():
    async def run():
        clock, ids, ledger, repo, policy = make_env()
        p = await make_topup(repo, clock, "pay_j2", 1000)
        await do_grant(ledger, p.id, 100, 10)
        clock.advance(3 * DAY_MS)
        decision = await evaluate(
            EvaluateInput(
                payment=p, policy=policy, ledger=ledger, repo=repo, clock=clock
            )
        )
        provider = CountingProvider()
        from dataclasses import replace as dc_replace

        await execute(
            ExecuteInput(
                decision=decision,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
                ids=ids,
                idempotency_key="refund:fixed-key",
            )
        )

        other_decision = dc_replace(
            decision,
            amount=dc_replace(
                decision.amount, amount_minor=decision.amount.amount_minor + 1
            ),
        )
        try:
            await execute(
                ExecuteInput(
                    decision=other_decision,
                    provider=provider,
                    ledger=ledger,
                    repo=repo,
                    clock=clock,
                    ids=ids,
                    idempotency_key="refund:fixed-key",
                )
            )
            raise AssertionError("expected idempotency_key_reused")
        except PaymentKitError as err:
            assert err.code == "idempotency_key_reused"

    asyncio.run(run())


def test_j3_concurrent_duplicate_execute_raises_idempotency_in_progress():
    async def run():
        clock, ids, ledger, repo, policy = make_env()
        p = await make_topup(repo, clock, "pay_j3", 1000)
        await do_grant(ledger, p.id, 100, 10)
        clock.advance(3 * DAY_MS)
        decision = await evaluate(
            EvaluateInput(
                payment=p, policy=policy, ledger=ledger, repo=repo, clock=clock
            )
        )
        gate = asyncio.Event()

        class DeferredProvider(FakeProvider):
            async def refund(
                self, *, payment_ref, amount, reason, idempotency_key, extra=None
            ):
                await gate.wait()
                return await super().refund(
                    payment_ref=payment_ref,
                    amount=amount,
                    reason=reason,
                    idempotency_key=idempotency_key,
                    extra=extra,
                )

        provider = DeferredProvider()
        task = asyncio.create_task(
            execute(
                ExecuteInput(
                    decision=decision,
                    provider=provider,
                    ledger=ledger,
                    repo=repo,
                    clock=clock,
                    ids=ids,
                )
            )
        )
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        await asyncio.sleep(
            0
        )  # let the first call reach 'in_progress' before the second starts

        try:
            await execute(
                ExecuteInput(
                    decision=decision,
                    provider=provider,
                    ledger=ledger,
                    repo=repo,
                    clock=clock,
                    ids=ids,
                )
            )
            raise AssertionError("expected idempotency_in_progress")
        except PaymentKitError as err:
            assert err.code == "idempotency_in_progress"

        gate.set()
        await task

    asyncio.run(run())


def test_ec_l5_correlation_id_reaches_provider_and_stamps_hold_revoke_release():
    async def run():
        clock, ids, ledger, repo, policy = make_env()
        p = await make_topup(repo, clock, "pay_l5", 1000)
        g = await do_grant(ledger, p.id, 100, 10)
        clock.advance(3 * DAY_MS)
        decision = await evaluate(
            EvaluateInput(
                payment=p, policy=policy, ledger=ledger, repo=repo, clock=clock
            )
        )
        provider = RecordingProvider()

        refund = await execute(
            ExecuteInput(
                decision=decision,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
                ids=ids,
                correlation_id="corr_l5_1",
            )
        )
        assert refund.status == "succeeded"

        # provider.refund() was called through the scoped clone, not the bare provider.
        assert provider.received_correlation_ids == ["corr_l5_1"]

        entries = [
            e
            for e in await ledger.entries(CUSTOMER_ID)
            if e.reference.refund_id == refund.id
        ]
        by_kind = {e.kind: e for e in entries}
        assert by_kind["hold"].reference.correlation_id == "corr_l5_1"
        assert by_kind["revoke"].reference.correlation_id == "corr_l5_1"
        assert by_kind["revoke"].reference.grant_id == g.id
        assert by_kind["release"].reference.correlation_id == "corr_l5_1"

    asyncio.run(run())


def test_ec_l5_no_correlation_id_uses_bare_provider_and_leaves_entries_unstamped():
    async def run():
        clock, ids, ledger, repo, policy = make_env()
        p = await make_topup(repo, clock, "pay_l5_none", 1000)
        await do_grant(ledger, p.id, 100, 10)
        clock.advance(3 * DAY_MS)
        decision = await evaluate(
            EvaluateInput(
                payment=p, policy=policy, ledger=ledger, repo=repo, clock=clock
            )
        )
        provider = RecordingProvider()

        refund = await execute(
            ExecuteInput(
                decision=decision,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )
        assert refund.status == "succeeded"
        assert provider.received_correlation_ids == [None]

        entries = [
            e
            for e in await ledger.entries(CUSTOMER_ID)
            if e.reference.refund_id == refund.id
        ]
        for e in entries:
            assert e.reference.correlation_id is None

    asyncio.run(run())


def test_ec_l5_on_external_refund_stamps_the_revoke_entry():
    async def run():
        clock, ids, ledger, repo, _policy = make_env()
        cs = ReconcileMismatchCsStub()
        p = await make_topup(repo, clock, "pay_l5_ext", 1000)
        await do_grant(ledger, p.id, 100, 10)
        event = NormalizedEvent(
            id="evt_ext_l5",
            refund_ref="re_ext_l5",
            provider="stripe",
            type="refund.created",
            occurred_at=clock.now(),
            customer_ref="cus_1",
            subscription_ref=None,
            payment_ref=p.provider_ref,
            amount=Money(amount_minor=1000, currency="USD"),
            raw={},
        )
        refund = await on_external_refund(
            OnExternalRefundInput(
                event=event,
                ledger=ledger,
                repo=repo,
                cs=cs,
                clock=clock,
                ids=ids,
                correlation_id="corr_l5_ext",
            )
        )
        assert refund.status == "succeeded"

        revoke = next(
            e
            for e in await ledger.entries(CUSTOMER_ID, kind="revoke")
            if e.reference.refund_id == refund.id
        )
        assert revoke.reference.correlation_id == "corr_l5_ext"

    asyncio.run(run())


def test_execute_requires_explicit_approval_for_needs_human():
    async def go():
        clock, ids, ledger, repo, policy = make_env()
        payment = await make_topup(repo, clock, "approval", 1000)
        decision = await evaluate(
            EvaluateInput(
                payment=payment, policy=policy, ledger=ledger, repo=repo, clock=clock
            )
        )
        decision = dataclasses.replace(decision, needs_human=True)
        try:
            await execute(
                ExecuteInput(
                    decision=decision,
                    provider=FakeProvider(),
                    ledger=ledger,
                    repo=repo,
                    clock=clock,
                    ids=ids,
                )
            )
        except PaymentKitError as error:
            assert error.code == "refund_approval_required"
        else:
            raise AssertionError("unapproved refund executed")

    asyncio.run(go())


def test_unconfirmed_provider_results_do_not_revoke_or_mark_refunded():
    async def go(status):
        clock, ids, ledger, repo, policy = make_env()
        payment = await make_topup(repo, clock, "unconfirmed", 1000)
        await do_grant(ledger, payment.id, 100, 10)
        decision = await evaluate(
            EvaluateInput(
                payment=payment, policy=policy, ledger=ledger, repo=repo, clock=clock
            )
        )

        class UnconfirmedProvider(FakeProvider):
            async def refund(self, **kwargs):
                return dataclasses.replace(
                    await super().refund(**kwargs), status=status
                )

        refund = await execute(
            ExecuteInput(
                decision=decision,
                provider=UnconfirmedProvider(),
                ledger=ledger,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )
        assert refund.status == status
        assert refund.credits_revoked == 0
        assert (await repo.payments.get(payment.id)).status == "succeeded"
        assert await ledger.entries(CUSTOMER_ID, kind="revoke") == []

    for status in ("pending", "failed"):
        asyncio.run(go(status))


def test_pending_refund_settlement_requires_trusted_reference():
    async def go(event_type):
        clock, ids, ledger, repo, policy = make_env()
        payment = await make_topup(repo, clock, "pending-settle", 1000)
        await do_grant(ledger, payment.id, 100, 10)
        decision = await evaluate(
            EvaluateInput(
                payment=payment, policy=policy, ledger=ledger, repo=repo, clock=clock
            )
        )

        class PendingProvider(FakeProvider):
            async def refund(self, **kwargs):
                return dataclasses.replace(
                    await super().refund(**kwargs), status="pending"
                )

        class Cs:
            async def open_reconcile_mismatch_case(self, **kwargs):
                return None

        pending = await execute(
            ExecuteInput(
                decision=decision,
                provider=PendingProvider(),
                ledger=ledger,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )
        event = NormalizedEvent(
            id="settle-event",
            provider="stripe",
            type=event_type,
            occurred_at=clock.now(),
            customer_ref=CUSTOMER_ID,
            subscription_ref=None,
            payment_ref=payment.provider_ref,
            amount=payment.amount,
            raw={},
        )
        input = OnExternalRefundInput(
            event=event, ledger=ledger, repo=repo, cs=Cs(), clock=clock, ids=ids
        )
        unresolved = await on_external_refund(input)
        assert unresolved.status == "pending"
        assert len(await repo.refunds.list(payment_id=payment.id)) == 1
        event.refund_ref = pending.provider_ref
        settled = await on_external_refund(input)
        assert settled.id == pending.id
        assert settled.status == (
            "succeeded" if event_type == "refund.created" else "failed"
        )
        balance = await ledger.balance(CUSTOMER_ID, "paid", clock.now())
        assert balance.held == 0
        assert balance.available == (0 if event_type == "refund.created" else 100)
        replay = await on_external_refund(input)
        assert replay.id == pending.id
        assert len(await repo.refunds.list(payment_id=payment.id)) == 1

    for event_type in ("refund.created", "refund.failed"):
        asyncio.run(go(event_type))


def test_pending_settlement_preserves_approved_allow_negative_revocation():
    async def go():
        clock, ids, ledger, repo, _ = make_env()
        payment = await make_topup(repo, clock, "pending-negative", 1000)
        await do_grant(ledger, payment.id, 100, 10)
        await ledger.append(
            NewLedgerEntry(
                customer_id=CUSTOMER_ID,
                pool="paid",
                kind="consume",
                amount=-60,
                source="usage",
                reference=LedgerReference(),
                idempotency_key="pending-negative-use",
                actor="system",
            )
        )
        policy = resolve_policy({"refund": {"revoke_shortfall": "allow_negative"}})
        decision = await evaluate(
            EvaluateInput(
                payment=payment, policy=policy, ledger=ledger, repo=repo, clock=clock
            )
        )

        class PendingProvider(FakeProvider):
            async def refund(self, **kwargs):
                return dataclasses.replace(
                    await super().refund(**kwargs), status="pending"
                )

        class Cs:
            async def open_reconcile_mismatch_case(self, **kwargs):
                return None

        pending = await execute(
            ExecuteInput(
                decision=decision,
                provider=PendingProvider(),
                ledger=ledger,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )
        event = NormalizedEvent(
            id="negative-event",
            provider="stripe",
            type="refund.created",
            occurred_at=clock.now(),
            customer_ref=CUSTOMER_ID,
            subscription_ref=None,
            payment_ref=payment.provider_ref,
            amount=payment.amount,
            raw={},
        )
        settled = await on_external_refund(
            OnExternalRefundInput(
                event=event,
                refund_ref=pending.provider_ref,
                ledger=ledger,
                repo=repo,
                cs=Cs(),
                clock=clock,
                ids=ids,
            )
        )
        assert settled.credits_revoked == 100
        assert (await ledger.balance(CUSTOMER_ID, "paid", clock.now())).available == -60

    asyncio.run(go())


def test_external_refund_does_not_guess_missing_ref_or_amount():
    async def run(missing):
        # Given incomplete provider evidence for an otherwise valid payment.
        clock, ids, ledger, repo, _policy = make_env()
        payment = await make_topup(repo, clock, "incomplete", 1000)
        await do_grant(ledger, payment.id, 100, 10)
        event = NormalizedEvent(
            id="delivery-only", refund_ref=None if missing == "ref" else "actual-refund",
            provider="stripe", type="refund.created", occurred_at=clock.now(),
            customer_ref=CUSTOMER_ID, subscription_ref=None, payment_ref=payment.provider_ref,
            amount=None if missing == "amount" else payment.amount, raw={},
        )
        cs = ReconcileMismatchCsStub()
        # When incomplete evidence reaches reconciliation.
        with pytest.raises(PaymentKitError) as error:
            await on_external_refund(OnExternalRefundInput(event=event, ledger=ledger, repo=repo, cs=cs, clock=clock, ids=ids))
        # Then no refund or credit revocation is invented.
        assert error.value.code == "refund_reconciliation_required"
        assert len(cs.calls) == 1
        assert await repo.refunds.list() == []
        assert (await ledger.balance(CUSTOMER_ID, "paid", clock.now())).available == 100

    for missing in ("ref", "amount"):
        asyncio.run(run(missing))
