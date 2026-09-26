"""Regression coverage for seller-configured usage billing rules."""

from dataclasses import replace
from datetime import UTC, datetime

import anyio
import pytest
from fixtures import mk_sub
from schift_payment_kit_core import (
    DEFAULT_POLICY,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    LedgerReference,
    NewLedgerEntry,
    PaymentKitError,
    SequentialIdGen,
)
from schift_payment_kit_core.types import CreditConversion
from schift_payment_kit_usage import (
    UsageEventInput,
    check,
    close_period,
    record,
    resettle_period,
)


def test_conversion_obeys_promotional_first_rule() -> None:
    async def run() -> None:
        # Given funded pools and the seller's promotional-first rule.
        ids = SequentialIdGen("policy_")
        clock = FixedClock(datetime(2026, 5, 20, tzinfo=UTC))
        repo = InMemoryRepo()
        ledger = InMemoryLedger(ids)
        sub = mk_sub()
        policy = replace(
            DEFAULT_POLICY,
            credits=replace(
                DEFAULT_POLICY.credits, consume_order="promo_first_then_expiring"
            ),
            usage=replace(
                DEFAULT_POLICY.usage,
                credit_conversion=CreditConversion(unit="call", credits_per_unit=10),
            ),
        )
        for pool in ("paid", "promo"):
            await ledger.append(
                NewLedgerEntry(
                    customer_id=sub.customer_id,
                    pool=pool,
                    kind="grant",
                    amount=50,
                    currency=None,
                    source="promo",
                    reference=LedgerReference(),
                    idempotency_key=pool,
                    actor="test",
                )
            )
        # When three units are used.
        result = await check(
            customer_id=sub.customer_id,
            meter="call",
            quantity=3,
            sub=sub,
            policy=policy,
            repo=repo,
            ledger=ledger,
            clock=clock,
            idempotency_key="usage",
        )
        # Then paid credits remain untouched.
        assert result.allow
        assert (
            await ledger.balance(sub.customer_id, pool="paid", now=clock.now())
        ).available == 50
        assert (
            await ledger.balance(sub.customer_id, pool="promo", now=clock.now())
        ).available == 20

    anyio.run(run)


@pytest.mark.parametrize("operation", ["close", "resettle"])
def test_settlement_requires_known_billing_currency(operation: str) -> None:
    async def run() -> None:
        # Given billable usage without a plan or selected billing currency.
        ids = SequentialIdGen("currency_")
        clock = FixedClock(datetime(2026, 5, 20, tzinfo=UTC))
        repo = InMemoryRepo()
        sub = mk_sub()
        policy = replace(
            DEFAULT_POLICY,
            usage=replace(
                DEFAULT_POLICY.usage,
                included_quantity=0,
                overage="bill_overage",
                overage_unit_price_minor=250,
            ),
        )
        await record(
            event=UsageEventInput(
                customer_id=sub.customer_id,
                meter="call",
                quantity=3,
                occurred_at=clock.now(),
                idempotency_key="usage",
            ),
            sub=sub,
            policy=policy,
            repo=repo,
            clock=clock,
            ids=ids,
        )
        # When settled, then the missing rule is explicit.
        with pytest.raises(PaymentKitError) as error:
            if operation == "close":
                await close_period(
                    sub=sub, policy=policy, repo=repo, clock=clock, ids=ids
                )
            else:
                await resettle_period(
                    sub=sub,
                    period_start=sub.current_period.start,
                    policy=policy,
                    repo=repo,
                    clock=clock,
                    settled_total=0,
                )
        assert error.value.code == "billing_currency_required"

    anyio.run(run)
