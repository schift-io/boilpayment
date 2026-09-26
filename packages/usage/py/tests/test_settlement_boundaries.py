"""Original payment snapshots constrain settlement ownership, dates, and currency."""

from dataclasses import replace
from datetime import UTC, datetime

import anyio
import pytest
from boilpayment_core import Money, Payment, PaymentKitError, Period, PlanPrice
from boilpayment_usage import settle_due_periods, settle_period
from test_settle_period import given


def test_alternate_end_and_ambiguous_direct_owner_are_rejected():
    async def run():
        input = await given()
        period = input["period"]
        input["period"] = replace(period, end=datetime(2026, 5, 31, tzinfo=UTC))
        with pytest.raises(PaymentKitError) as error:
            await settle_period(**input)
        assert error.value.code == "invalid_usage_period"
        input["period"] = period
        await input["repo"].subscriptions.put(replace(input["sub"], id="other-sub"))
        with pytest.raises(PaymentKitError) as error:
            await settle_period(**input)
        assert error.value.code == "ambiguous_usage_subscription"
        assert not input["provider"].calls

    anyio.run(run)


def test_historical_usage_uses_original_invoice_currency():
    async def run():
        input = await given()
        await input["repo"].payments.put(
            Payment(
                id="invoice",
                customer_id=input["sub"].customer_id,
                provider="stripe",
                provider_ref="invoice_ref",
                subscription_id=input["sub"].id,
                amount=Money(amount_minor=1000, currency="KRW"),
                status="succeeded",
                kind="subscription",
                period=input["period"],
                occurred_at=input["period"].start,
            )
        )
        plan = await input["repo"].plans.get(input["sub"].plan_id)
        await input["repo"].plans.put(
            replace(
                plan,
                interval="year",
                prices=[PlanPrice(currency="USD", amount_minor=1000)],
            )
        )
        input["sub"] = replace(
            input["sub"],
            current_period=Period(
                start=input["period"].end, end=datetime(2027, 6, 1, tzinfo=UTC)
            ),
        )
        assert (await settle_period(**input)).charged_amount == Money(
            amount_minor=750, currency="KRW"
        )

    anyio.run(run)


def test_unproven_historical_period_is_not_guessed():
    async def run():
        input = await given()
        await input["repo"].subscriptions.put(
            replace(
                input["sub"],
                current_period=Period(
                    start=input["period"].end, end=datetime(2026, 7, 1, tzinfo=UTC)
                ),
            )
        )
        with pytest.raises(PaymentKitError) as error:
            await settle_due_periods(
                policy=input["policy"],
                repo=input["repo"],
                ledger=input["ledger"],
                providers={"stripe": input["provider"]},
                clock=input["clock"],
            )
        assert error.value.code == "invalid_usage_period"
        assert not input["provider"].calls

    anyio.run(run)
