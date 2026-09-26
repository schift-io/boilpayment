"""Recovery and batch discovery exercise actual persisted settlement state."""

from dataclasses import replace
from datetime import UTC, datetime

import anyio
import pytest
from fixtures import FakeProvider
from schift_payment_kit_core import Money, OutboxItem, Payment, PaymentKitError, Period
from schift_payment_kit_usage import settle_due_periods, settle_period
from test_settle_period import given


def test_concurrent_cron_attempts_create_one_charge():
    async def run():
        input = await given()
        results = []

        async def attempt():
            results.append((await settle_period(**input)).status)

        async with anyio.create_task_group() as group:
            group.start_soon(attempt)
            group.start_soon(attempt)
        assert results.count("charged") == 1
        assert all(status in {"charged", "unchanged", "pending"} for status in results)
        assert len(input["provider"].calls) == 1

    anyio.run(run)


def test_recovers_when_paid_checkpoint_could_not_be_saved():
    async def run():
        input = await given()
        put = input["repo"].operations.put
        fail_once = True

        async def save(row):
            nonlocal fail_once
            if fail_once and row.status == "done":
                fail_once = False
                raise RuntimeError("checkpoint unavailable")
            return await put(row)

        input["repo"].operations.put = save
        with pytest.raises(RuntimeError, match="checkpoint unavailable"):
            await settle_period(**input)
        assert (await input["repo"].payments.list())[0].status == "succeeded"
        input["clock"].advance(300000)
        assert (await settle_period(**input)).status == "charged"
        assert len(input["provider"].calls) == 1

    anyio.run(run)


def test_batch_discovers_original_period_after_renewal():
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
        await input["repo"].subscriptions.put(
            replace(
                input["sub"],
                current_period=Period(
                    start=input["period"].end, end=datetime(2026, 7, 1, tzinfo=UTC)
                ),
            )
        )
        results = await settle_due_periods(
            policy=input["policy"],
            repo=input["repo"],
            ledger=input["ledger"],
            providers={"stripe": input["provider"]},
            clock=input["clock"],
        )
        assert results[0].subscription_id == input["sub"].id
        assert results[0].period == input["period"]
        assert results[0].result.status == "charged"
        results = await settle_due_periods(
            policy=input["policy"],
            repo=input["repo"],
            ledger=input["ledger"],
            providers={"stripe": input["provider"]},
            clock=input["clock"],
        )
        assert results[0].result.status == "unchanged"
        assert len(input["provider"].calls) == 1

    anyio.run(run)


def test_changed_rules_cannot_replace_unresolved_charge():
    async def run():
        input = await given()
        input["provider"].lose_response = True
        with pytest.raises(RuntimeError, match="connection lost"):
            await settle_period(**input)
        input["policy"] = replace(
            input["policy"],
            usage=replace(input["policy"].usage, overage_unit_price_minor=500),
        )
        with pytest.raises(PaymentKitError) as error:
            await settle_period(**input)
        assert error.value.code == "usage_billing_policy_changed"
        assert len(input["provider"].calls) == 1

    anyio.run(run)


def test_direct_billing_refuses_already_reported_usage():
    async def run():
        input = await given()
        await input["repo"].outbox.put(
            OutboxItem(
                id="report",
                kind="usage.report",
                payload={"eventId": "event"},
                status="sent",
                attempts=1,
                next_attempt_at=input["clock"].now(),
                created_at=input["clock"].now(),
            )
        )
        with pytest.raises(PaymentKitError) as error:
            await settle_period(**input)
        assert error.value.code == "unsupported_usage_billing"
        assert not input["provider"].calls

    anyio.run(run)


def test_json_report_timestamps_restored_for_provider():
    class DateCheckingProvider(FakeProvider):
        async def report_usage(self, **input):
            assert isinstance(input["occurred_at"], datetime)
            await super().report_usage(**input)

    async def run():
        input = await given()
        input["provider"] = DateCheckingProvider()
        await input["repo"].outbox.put(
            OutboxItem(
                id="persisted",
                kind="usage.report",
                payload={
                    "eventId": "event",
                    "customerId": input["sub"].customer_id,
                    "meter": "call",
                    "quantity": 8,
                    "occurredAt": input["period"].start.isoformat(),
                    "provider": "stripe",
                },
                status="pending",
                attempts=0,
                next_attempt_at=input["clock"].now(),
                created_at=input["clock"].now(),
            )
        )
        assert (await settle_period(**input)).status == "awaiting_provider_billing"

    anyio.run(run)
