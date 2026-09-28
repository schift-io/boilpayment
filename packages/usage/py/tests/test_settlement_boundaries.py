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
        assert error.value.code == "usage_settlement_errors"
        assert [e["code"] for e in error.value.details["errors"]] == ["invalid_usage_period"]
        assert not input["provider"].calls

    anyio.run(run)


def test_a75_billing_customer_ref_is_sent():
    async def run():
        input = await given()
        input["sub"] = replace(input["sub"], billing_customer_ref="billing_customer_key")
        await input["repo"].subscriptions.put(input["sub"])
        await settle_period(**input)
        assert [c[2] for c in input["provider"].calls] == ["billing_customer_key"]

    anyio.run(run)


def test_a75_one_failure_does_not_stop_the_others():
    async def run():
        input = await given()
        await input["repo"].subscriptions.put(input["sub"])
        other = replace(input["sub"], id="sub_other", customer_id="cust_other",
                        current_period=Period(start=input["period"].end, end=datetime(2026, 7, 1, tzinfo=UTC)))
        await input["repo"].subscriptions.put(other)
        events = await input["repo"].usage_events.list(customer_id=input["sub"].customer_id)
        await input["repo"].usage_events.put(replace(events[0], id="event_other", customer_id="cust_other", idempotency_key="event_other"))
        with pytest.raises(PaymentKitError) as error:
            await settle_due_periods(policy=input["policy"], repo=input["repo"], ledger=input["ledger"],
                                     providers={"stripe": input["provider"]}, clock=input["clock"])
        assert error.value.code == "usage_settlement_errors"
        assert [(e["subscription_id"], e["code"]) for e in error.value.details["errors"]] == [("sub_other", "invalid_usage_period")]
        assert len(input["provider"].calls) == 1

    anyio.run(run)


def test_a83_unsettled_overage_charge_is_reported_every_run():
    async def run():
        input = await given()
        await input["repo"].subscriptions.put(input["sub"])
        input["provider"].status = "pending"
        for _ in range(2):
            with pytest.raises(PaymentKitError) as error:
                await settle_due_periods(policy=input["policy"], repo=input["repo"], ledger=input["ledger"],
                                         providers={"stripe": input["provider"]}, clock=input["clock"])
            assert [(e["subscription_id"], e["code"]) for e in error.value.details["errors"]] == [
                (input["sub"].id, "overage_charge_pending")]
            input["clock"].advance(300_000)
        assert len(input["provider"].calls) == 1

    anyio.run(run)
