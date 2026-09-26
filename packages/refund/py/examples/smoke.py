"""Smoke test -- real code path (no mocks of our own modules), only a fake PaymentProvider
(no real PG in examples). Run: .venv/bin/python packages/refund/py/examples/smoke.py
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
from datetime import UTC, datetime

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
    PaymentKitError,
    Refund,
    SequentialIdGen,
)
from schift_payment_kit_refund import EvaluateInput, ExecuteInput, evaluate, execute


class FakeProvider:
    """refund() always succeeds; everything else is unused by this smoke test."""

    name = "stripe"

    def capabilities(self):
        return {
            "native_subscriptions": True,
            "partial_refund": True,
            "meters": False,
            "scheduling": "provider",
            "webhook_signature": True,
        }

    async def refund(self, *, payment_ref, amount, reason, idempotency_key, extra=None):
        # Mirrors the real provider adapters (Stripe/Polar/Toss/Portone): customer_id/rule_id are
        # unknown to the provider, id is the provider's own cancellation id -- execute() must
        # overwrite these.
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


class ReceiveAccountRequiredProvider(FakeProvider):
    """EC:D13 -- Toss virtual-account refund missing extra.refund_receive_account."""

    async def refund(self, *, payment_ref, amount, reason, idempotency_key, extra=None):
        raise PaymentKitError(
            "refundReceiveAccount required for Toss virtual account refunds",
            "refund_receive_account_required",
        )


def _to_dict(obj):
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return {f.name: _to_dict(getattr(obj, f.name)) for f in dataclasses.fields(obj)}
    if isinstance(obj, dict):
        return {k: _to_dict(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_to_dict(v) for v in obj]
    if isinstance(obj, datetime):
        return obj.isoformat()
    return obj


async def main() -> None:
    ids = SequentialIdGen("id_")
    clock = FixedClock(datetime(2026, 1, 1, tzinfo=UTC))
    ledger = InMemoryLedger(ids)
    repo = InMemoryRepo()
    provider = FakeProvider()
    policy = DEFAULT_POLICY

    customer_id = "cust_1"

    # -- Scenario 1: payment $10 -> 100 credits (unitPrice 10 minor) -> consume 40 -> evaluate at day 3 --
    payment1 = Payment(
        id="pay_1",
        customer_id=customer_id,
        provider="stripe",
        provider_ref="pi_1",
        subscription_id=None,
        amount=Money(amount_minor=1000, currency="USD"),
        status="succeeded",
        kind="topup",
        period=None,
        occurred_at=clock.now(),
        failure=None,
    )
    await repo.payments.put(payment1)

    append_result = await ledger.append(
        NewLedgerEntry(
            customer_id=customer_id,
            pool="paid",
            kind="grant",
            amount=100,
            unit_price_minor=10,
            currency="USD",
            source="topup",
            reference=LedgerReference(payment_id=payment1.id),
            idempotency_key=f"topup:{payment1.id}",
            actor="system",
        )
    )
    grant1 = append_result.entry
    print("grant1:", grant1.amount, "credits @ unitPrice", grant1.unit_price_minor)

    consume_result = await ledger.consume(
        ConsumeInput(
            customer_id=customer_id,
            pool_order=["paid"],
            amount=40,
            idempotency_key="consume:1",
            meta=LedgerReference(),
            now=clock.now(),
            negative_balance=policy.credits.negative_balance,
            negative_floor=policy.credits.negative_floor,
            reason="usage",
        )
    )
    balance = await ledger.balance(customer_id, "paid", clock.now())
    print("consume 40 ok:", consume_result.ok, "balance after:", balance.available)

    clock.advance(3 * 24 * 60 * 60 * 1000)  # day 3
    decision1 = await evaluate(
        EvaluateInput(
            payment=payment1, policy=policy, ledger=ledger, repo=repo, clock=clock
        )
    )
    print("\n[evaluate #1 @ day3]", json.dumps(_to_dict(decision1), indent=2))

    refund1 = await execute(
        ExecuteInput(
            decision=decision1,
            provider=provider,
            ledger=ledger,
            repo=repo,
            clock=clock,
            ids=ids,
        )
    )
    print("\n[execute #1]", json.dumps(_to_dict(refund1), indent=2))
    balance = await ledger.balance(customer_id, "paid", clock.now())
    print("balance after execute #1:", balance.available)

    # -- Scenario 2: fresh payment, unused_credits method, evaluate at day 20 --
    payment2 = Payment(
        id="pay_2",
        customer_id=customer_id,
        provider="stripe",
        provider_ref="pi_2",
        subscription_id=None,
        amount=Money(amount_minor=1000, currency="USD"),
        status="succeeded",
        kind="topup",
        period=None,
        occurred_at=clock.now(),
        failure=None,
    )
    await repo.payments.put(payment2)
    await ledger.append(
        NewLedgerEntry(
            customer_id=customer_id,
            pool="paid",
            kind="grant",
            amount=100,
            unit_price_minor=10,
            currency="USD",
            source="topup",
            reference=LedgerReference(payment_id=payment2.id),
            idempotency_key=f"topup:{payment2.id}",
            actor="system",
        )
    )
    await ledger.consume(
        ConsumeInput(
            customer_id=customer_id,
            pool_order=["paid"],
            amount=30,
            idempotency_key="consume:2",
            meta=LedgerReference(),
            now=clock.now(),
            negative_balance=policy.credits.negative_balance,
            negative_floor=policy.credits.negative_floor,
            reason="usage",
        )
    )

    clock.advance(20 * 24 * 60 * 60 * 1000)  # now 20 days after payment2.occurred_at
    decision2 = await evaluate(
        EvaluateInput(
            payment=payment2, policy=policy, ledger=ledger, repo=repo, clock=clock
        )
    )
    print(
        "\n[evaluate #2 @ day20, method=unused_credits]",
        json.dumps(_to_dict(decision2), indent=2),
    )

    # -- Scenario 3: EC:D13 -- Toss virtual-account refund missing refund_receive_account --
    payment3 = Payment(
        id="pay_3",
        customer_id=customer_id,
        provider="toss",
        provider_ref="pi_3",
        subscription_id=None,
        amount=Money(amount_minor=1000, currency="KRW"),
        status="succeeded",
        kind="topup",
        period=None,
        occurred_at=clock.now(),
        failure=None,
    )
    await repo.payments.put(payment3)
    await ledger.append(
        NewLedgerEntry(
            customer_id=customer_id,
            pool="paid",
            kind="grant",
            amount=100,
            unit_price_minor=10,
            currency="KRW",
            source="topup",
            reference=LedgerReference(payment_id=payment3.id),
            idempotency_key=f"topup:{payment3.id}",
            actor="system",
        )
    )
    decision3 = await evaluate(
        EvaluateInput(
            payment=payment3, policy=policy, ledger=ledger, repo=repo, clock=clock
        )
    )  # fresh payment -> D1
    balance_before_3 = (await ledger.balance(customer_id, "paid", clock.now())).available

    opened_refund_failed_case: dict | None = None

    class _CsStub:
        async def open_refund_failed_case(
            self, *, customer_id, reference_id, reason, needs=None
        ):
            nonlocal opened_refund_failed_case
            opened_refund_failed_case = {
                "customer_id": customer_id,
                "reference_id": reference_id,
                "reason": reason,
                "needs": needs,
            }

    refund3 = await execute(
        ExecuteInput(
            decision=decision3,
            provider=ReceiveAccountRequiredProvider(),
            ledger=ledger,
            repo=repo,
            clock=clock,
            ids=ids,
            cs=_CsStub(),
        )
    )
    balance_after_3 = (await ledger.balance(customer_id, "paid", clock.now())).available
    print(
        "\n[execute #3, EC:D13 missing refund_receive_account]",
        json.dumps(_to_dict(refund3), indent=2),
    )
    print("hold released, balance unchanged:", balance_before_3, "->", balance_after_3)
    print("cs.open_refund_failed_case received:", opened_refund_failed_case)

    print("\nsmoke: OK")


if __name__ == "__main__":
    asyncio.run(main())
