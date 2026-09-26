from datetime import UTC, datetime

import anyio
import pytest
from schift_payment_kit_core import (
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
    Policy,
    Refund,
    SequentialIdGen,
    resolve_policy,
)
from schift_payment_kit_refund import EvaluateInput, evaluate


async def scenario(policy: Policy = DEFAULT_POLICY) -> EvaluateInput:
    clock = FixedClock(datetime(2026, 1, 1, tzinfo=UTC))
    ledger = InMemoryLedger(SequentialIdGen("eval_"))
    repo = InMemoryRepo()
    payment = Payment(
        id="pay",
        customer_id="customer",
        provider="stripe",
        provider_ref="pi_pay",
        subscription_id=None,
        amount=Money(amount_minor=1000, currency="USD"),
        status="succeeded",
        kind="subscription",
        period=Period(start=clock.now(), end=datetime(2026, 1, 31, tzinfo=UTC)),
        occurred_at=clock.now(),
        failure=None,
    )
    await ledger.append(
        NewLedgerEntry(
            customer_id="customer",
            pool="paid",
            kind="grant",
            amount=100,
            unit_price_minor=10,
            currency="USD",
            expires_at=None,
            source="subscription",
            reference=LedgerReference(payment_id="pay"),
            idempotency_key="grant",
            actor="system",
            reason=None,
        )
    )
    return EvaluateInput(
        payment=payment, policy=policy, ledger=ledger, repo=repo, clock=clock
    )


@pytest.mark.parametrize("amount_minor", [-1, 0, 1.5, float("nan"), float("inf"), True])
def test_invalid_requested_amount_is_denied(amount_minor: float) -> None:
    async def run() -> None:
        inputs = await scenario()
        inputs.requested_amount = {"amount_minor": amount_minor, "currency": "USD"}
        decision = await evaluate(inputs)
        assert not decision.eligible
        assert decision.rule_id == "D-request"
        assert decision.credits_to_revoke == 0

    anyio.run(run)


def test_mismatched_requested_currency_is_denied() -> None:
    async def run() -> None:
        inputs = await scenario()
        inputs.requested_amount = {"amount_minor": 100, "currency": "KRW"}
        decision = await evaluate(inputs)
        assert not decision.eligible
        assert decision.rule_id == "D-request"

    anyio.run(run)


@pytest.mark.parametrize("method", ["unused_credits", "time_prorated", "min_of_both"])
def test_each_method_caps_refund_at_remaining_payment(method: str) -> None:
    async def run() -> None:
        inputs = await scenario(resolve_policy({"refund": {"method": method}}))
        inputs.clock.advance(10 * 86_400_000)
        await inputs.repo.refunds.put(
            Refund(
                id="past",
                payment_id="pay",
                customer_id="customer",
                amount=Money(amount_minor=800, currency="USD"),
                status="succeeded",
                provider_ref="re_past",
                credits_revoked=0,
                rule_id="D1",
                reason=None,
                failure=None,
                created_at=inputs.clock.now(),
            )
        )
        decision = await evaluate(inputs)
        assert decision.amount.amount_minor == 200
        assert decision.credits_to_revoke <= 20

    anyio.run(run)


def test_min_of_both_honors_overuse_denial() -> None:
    async def run() -> None:
        inputs = await scenario(
            resolve_policy(
                {"refund": {"method": "min_of_both", "overuse_behavior": "deny"}}
            )
        )
        inputs.clock.advance(10 * 86_400_000)
        await inputs.ledger.consume(
            ConsumeInput(
                customer_id="customer",
                pool_order=["paid"],
                amount=60,
                idempotency_key="consume",
                meta=LedgerReference(),
                reason="usage",
                now=inputs.clock.now(),
                negative_balance="block",
                negative_floor=0,
            )
        )
        decision = await evaluate(inputs)
        assert not decision.eligible
        assert decision.rule_id == "D3"

    anyio.run(run)


@pytest.mark.parametrize(
    "revoke_shortfall", ["clamp_and_reduce_refund", "clamp_to_zero"]
)
def test_debt_means_zero_revocable_credits(revoke_shortfall: str) -> None:
    async def run() -> None:
        inputs = await scenario(
            resolve_policy({"refund": {"revoke_shortfall": revoke_shortfall}})
        )
        await inputs.ledger.consume(
            ConsumeInput(
                customer_id="customer",
                pool_order=["paid"],
                amount=150,
                idempotency_key="debt",
                meta=LedgerReference(),
                reason="usage",
                now=inputs.clock.now(),
                negative_balance="allow_unbounded",
                negative_floor=0,
            )
        )
        decision = await evaluate(inputs)
        assert decision.credits_to_revoke == 0
        assert decision.amount.amount_minor == (
            1000 if revoke_shortfall == "clamp_to_zero" else 0
        )
        assert decision.eligible == (revoke_shortfall == "clamp_to_zero")
        if revoke_shortfall == "clamp_and_reduce_refund":
            assert decision.rule_id == "D-zero"

    anyio.run(run)
