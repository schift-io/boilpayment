"""Durable usage billing: provider calls and persisted payment outcomes."""

from dataclasses import replace
from datetime import UTC, datetime

import anyio
import pytest
from boilpayment_core import (
    DEFAULT_POLICY,
    Customer,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    Money,
    Payment,
    Plan,
    PlanPrice,
    ProviderRef,
    SequentialIdGen,
    UsageEvent,
)
from boilpayment_usage import settle_period
from fixtures import FakeProvider, mk_sub


class BillingProvider(FakeProvider):
    def __init__(self) -> None:
        super().__init__()
        self.calls: list[tuple[Money, str, str]] = []
        self.charges: dict[str, Payment] = {}
        self.status = "succeeded"
        self.lose_response = False

    def capabilities(self):
        return replace(
            super().capabilities(),
            native_subscriptions=False,
            meters=False,
            scheduling="self",
        )

    async def charge_billing_key(
        self, *, billing_key, amount, order_id, customer_ref, idempotency_key
    ):
        self.calls.append((amount, idempotency_key, customer_ref))
        payment = self.charges.get(idempotency_key) or Payment(
            id="remote",
            customer_id="remote_customer",
            provider=self.name,
            provider_ref="remote_charge",
            subscription_id=None,
            amount=amount,
            status=self.status,
            kind="subscription",
            period=None,
            occurred_at=datetime(2026, 6, 1, tzinfo=UTC),
        )
        self.charges[idempotency_key] = payment
        if self.lose_response:
            self.lose_response = False
            raise RuntimeError("connection lost after charge")
        return payment

    async def get_payment(self, provider_ref):
        return replace(next(iter(self.charges.values())), status=self.status)


async def given():
    ids = SequentialIdGen("settle_")
    repo = InMemoryRepo()
    ledger = InMemoryLedger(ids)
    clock = FixedClock(datetime(2026, 6, 1, tzinfo=UTC))
    provider = BillingProvider()
    sub = mk_sub(billing_key="billing_key")
    policy = replace(
        DEFAULT_POLICY,
        usage=replace(
            DEFAULT_POLICY.usage,
            included_quantity=5,
            overage="bill_overage",
            overage_unit_price_minor=250,
        ),
    )
    await repo.customers.put(
        Customer(
            id=sub.customer_id,
            email=None,
            status="active",
            provider_refs=[
                ProviderRef(provider=provider.name, ref="provider_customer")
            ],
            created_at=clock.now(),
        )
    )
    await repo.plans.put(
        Plan(
            id=sub.plan_id,
            name="Pro",
            interval="month",
            credits_per_period=0,
            usage_included=5,
            trial_days=0,
            prices=[PlanPrice(currency="KRW", amount_minor=1000)],
        )
    )
    await repo.usage_events.put(
        UsageEvent(
            id="event",
            customer_id=sub.customer_id,
            meter="call",
            quantity=8,
            occurred_at=sub.current_period.start,
            received_at=clock.now(),
            period_start=sub.current_period.start,
            idempotency_key="event",
            meta=None,
        )
    )
    return {
        "sub": sub,
        "period": sub.current_period,
        "policy": policy,
        "repo": repo,
        "ledger": ledger,
        "clock": clock,
        "provider": provider,
    }


def test_closed_period_charged_once_and_payment_persisted():
    async def run():
        input = await given()
        first = await settle_period(**input)
        replay = await settle_period(**input)
        assert first.status == "charged"
        assert replay.status == "unchanged"
        calls = input["provider"].calls
        assert calls == [
            (Money(amount_minor=750, currency="KRW"), calls[0][1], "provider_customer")
        ]
        payments = await input["repo"].payments.list()
        assert len(payments) == 1
        assert payments[0].kind == "overage"
        assert payments[0].subscription_id == input["sub"].id
        assert payments[0].period == input["period"]

    anyio.run(run)


def test_never_charges_before_period_end():
    async def run():
        input = await given()
        input["clock"].advance(-1)
        assert (await settle_period(**input)).status == "not_due"
        assert not input["provider"].calls

    anyio.run(run)


def test_unknown_charge_retries_original_key_before_late_delta():
    async def run():
        input = await given()
        provider = input["provider"]
        provider.lose_response = True
        with pytest.raises(RuntimeError, match="connection lost"):
            await settle_period(**input)
        assert (await input["repo"].operations.list())[0].status == "in_progress"
        await input["repo"].usage_events.put(
            UsageEvent(
                id="late",
                customer_id=input["sub"].customer_id,
                meter="call",
                quantity=2,
                occurred_at=input["period"].start,
                received_at=input["clock"].now(),
                period_start=input["period"].start,
                idempotency_key="late",
                meta=None,
            )
        )
        input["clock"].advance(300000)
        assert (await settle_period(**input)).status == "charged"
        assert provider.calls[0] == provider.calls[1]
        assert (await settle_period(**input)).charged_amount == Money(
            amount_minor=500, currency="KRW"
        )
        assert len(provider.charges) == 2

    anyio.run(run)


@pytest.mark.parametrize("status", ["pending", "failed"])
def test_unpaid_provider_outcomes_do_not_claim_success(status):
    async def run():
        input = await given()
        provider = input["provider"]
        provider.status = status
        assert (await settle_period(**input)).status == status
        provider.status = "succeeded"
        input["clock"].advance(300000)
        result = await settle_period(**input)
        assert result.status == ("charged" if status == "pending" else "failed")
        assert len(provider.calls) == 1

    anyio.run(run)


def test_native_metered_usage_reported_without_claiming_payment():
    async def run():
        input = await given()
        provider = FakeProvider()
        input["provider"] = provider
        result = await settle_period(**input)
        assert result.status == "awaiting_provider_billing"
        assert result.charged_amount is None
        assert (await settle_period(**input)).status == "awaiting_provider_billing"
        assert provider.report_usage_calls == [
            {"customer_ref": "provider_customer", "meter": "call", "quantity": 8}
        ]
        assert not await input["repo"].payments.list()
        assert (await input["repo"].outbox.list())[0].status == "sent"

    anyio.run(run)


def test_native_delivery_failure_stays_pending():
    async def run():
        input = await given()
        input["provider"] = FakeProvider(always_fail=True)
        assert (await settle_period(**input)).status == "report_pending"
        assert not await input["repo"].payments.list()
        assert (await input["repo"].outbox.list())[0].status == "pending"

    anyio.run(run)
