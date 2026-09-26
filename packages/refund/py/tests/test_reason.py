"""EC:D16 refund reason rules. Mirrors packages/refund/ts/test/reason.test.ts (same cases, same numbers).
pytest-asyncio is not installed -- every test wraps its async body with asyncio.run(...).
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

from boilpayment_core import (
    DEFAULT_POLICY,
    ConsumeInput,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    LedgerReference,
    Money,
    NewLedgerEntry,
    Payment,
    Period,
    SequentialIdGen,
    resolve_policy,
)
from boilpayment_refund import EvaluateInput, RefundReasonInput, evaluate

STRICT = resolve_policy(
    {"refund": {"reasons": {"technicalFailure": "full", "dissatisfied": "evidence_required", "userError": "deny"}}}
)


async def scenario(policy=DEFAULT_POLICY):
    clock = FixedClock(datetime(2026, 1, 1, tzinfo=UTC))
    ledger = InMemoryLedger(SequentialIdGen("r_"), clock)
    repo = InMemoryRepo()
    payment = Payment(
        id="pay", customer_id="customer", provider="stripe", provider_ref="pi_pay", subscription_id=None,
        amount=Money(amount_minor=1000, currency="USD"), status="succeeded", kind="subscription",
        period=Period(start=clock.now(), end=datetime(2026, 1, 31, tzinfo=UTC)), occurred_at=clock.now(), failure=None,
    )
    await ledger.append(
        NewLedgerEntry(
            customer_id="customer", pool="paid", kind="grant", amount=100, unit_price_minor=10, currency="USD",
            source="subscription", reference=LedgerReference(payment_id="pay"), idempotency_key="grant", actor="system",
        )
    )
    clock.advance(int(timedelta(days=10).total_seconds() * 1000))
    await ledger.consume(
        ConsumeInput(
            customer_id="customer", pool_order=["paid"], amount=60, idempotency_key="use", meta=LedgerReference(),
            now=clock.now(), negative_balance="block", negative_floor=0,
        )
    )
    return {"payment": payment, "policy": policy, "ledger": ledger, "repo": repo, "clock": clock}


def run(coro):
    return asyncio.run(coro)


def test_defaults_change_nothing():
    async def body():
        base = await evaluate(EvaluateInput(**await scenario()))
        for category in ("technical_failure", "dissatisfied", "user_error", "other"):
            d = await evaluate(EvaluateInput(**await scenario(), reason=RefundReasonInput(category=category)))
            assert d == base
        assert (base.eligible, base.rule_id, base.amount.amount_minor, base.credits_to_revoke) == (True, "D2", 400, 40)

    run(body())


def test_technical_failure_full_outside_window_revokes_only_what_is_left():
    async def body():
        d = await evaluate(EvaluateInput(**await scenario(STRICT), reason=RefundReasonInput(category="technical_failure")))
        assert (d.eligible, d.rule_id, d.amount.amount_minor, d.credits_to_revoke) == (True, "D16", 1000, 40)

    run(body())


def test_technical_failure_full_ignores_method_deny():
    async def body():
        policy = resolve_policy({"refund": {"method": "deny", "reasons": {"technicalFailure": "full"}}})
        d = await evaluate(EvaluateInput(**await scenario(policy), reason=RefundReasonInput(category="technical_failure")))
        assert (d.eligible, d.rule_id, d.amount.amount_minor) == (True, "D16", 1000)

    run(body())


def test_user_error_deny():
    async def body():
        d = await evaluate(EvaluateInput(**await scenario(STRICT), reason=RefundReasonInput(category="user_error")))
        assert (d.eligible, d.rule_id, d.credits_to_revoke) == (False, "D16", 0)

    run(body())


def test_dissatisfied_evidence_required():
    async def body():
        without = await evaluate(EvaluateInput(**await scenario(STRICT), reason=RefundReasonInput(category="dissatisfied")))
        assert (without.eligible, without.needs_human, without.amount.amount_minor) == (True, True, 400)
        assert "D16: dissatisfied without evidenceRef" in without.reason
        with_ev = await evaluate(
            EvaluateInput(**await scenario(STRICT), reason=RefundReasonInput(category="dissatisfied", evidence_ref="job_42"))
        )
        assert (with_ev.eligible, with_ev.needs_human, with_ev.amount.amount_minor) == (True, False, 400)

    run(body())


def test_dissatisfied_needs_human():
    async def body():
        policy = resolve_policy({"refund": {"reasons": {"dissatisfied": "needs_human"}}})
        d = await evaluate(
            EvaluateInput(**await scenario(policy), reason=RefundReasonInput(category="dissatisfied", evidence_ref="x"))
        )
        assert (d.eligible, d.needs_human) == (True, True)

    run(body())


def test_other_gets_amount_rules():
    async def body():
        d = await evaluate(EvaluateInput(**await scenario(STRICT), reason=RefundReasonInput(category="other")))
        assert (d.eligible, d.rule_id, d.needs_human, d.amount.amount_minor) == (True, "D2", False, 400)

    run(body())
