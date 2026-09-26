"""A real PostgreSQL rollback must not erase an already issued usage charge request."""

from dataclasses import replace
from datetime import UTC, datetime

import anyio
import pytest
from boilpayment_core import (
    DEFAULT_POLICY,
    Customer,
    FixedClock,
    Money,
    Payment,
    Period,
    Plan,
    PlanPrice,
    ProviderCapabilities,
    ProviderRef,
    Subscription,
    UsageEvent,
)
from boilpayment_schema_postgres import PostgresLedgerStore, PostgresRepo
from boilpayment_usage import settle_period
from db_helper import create_test_db, drop_test_db


class BillingProvider:
    name = "stripe"

    def __init__(self):
        self.calls = []
        self.charges = {}
        self.lose_response = True

    def capabilities(self):
        return ProviderCapabilities(
            native_subscriptions=False,
            partial_refund=True,
            meters=False,
            scheduling="self",
            webhook_signature=True,
        )

    async def charge_billing_key(
        self, *, billing_key, amount, order_id, customer_ref, idempotency_key
    ):
        self.calls.append((amount, idempotency_key, customer_ref))
        payment = self.charges.get(idempotency_key) or Payment(
            id="remote",
            customer_id="remote",
            provider="stripe",
            provider_ref=f"remote_{idempotency_key}",
            subscription_id=None,
            amount=amount,
            status="succeeded",
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
        return next(
            payment
            for payment in self.charges.values()
            if payment.provider_ref == provider_ref
        )


def test_unknown_usage_intent_survives_real_transaction_failure():
    async def run():
        db = await create_test_db("py_usage_intent")
        try:
            repo = PostgresRepo(db.dsn)
            ledger = PostgresLedgerStore(db.dsn)
            clock = FixedClock(datetime(2026, 6, 1, tzinfo=UTC))
            period = Period(start=datetime(2026, 5, 1, tzinfo=UTC), end=clock.now())
            sub = Subscription(
                id="sub",
                customer_id="customer",
                plan_id="plan",
                provider="stripe",
                provider_ref="remote_sub",
                status="active",
                current_period=period,
                anchor_day=1,
                cancel_at_period_end=False,
                grace_until=None,
                billing_key="key",
                scheduled_plan_id=None,
                created_at=period.start,
            )
            await repo.customers.put(
                Customer(
                    id=sub.customer_id,
                    email=None,
                    status="active",
                    provider_refs=[
                        ProviderRef(provider="stripe", ref="provider_customer")
                    ],
                    created_at=period.start,
                )
            )
            await repo.plans.put(
                Plan(
                    id="plan",
                    name="Pro",
                    interval="month",
                    credits_per_period=0,
                    usage_included=5,
                    trial_days=0,
                    prices=[PlanPrice(currency="KRW", amount_minor=1000)],
                )
            )
            await repo.subscriptions.put(sub)
            await repo.usage_events.put(
                UsageEvent(
                    id="event",
                    customer_id=sub.customer_id,
                    meter="call",
                    quantity=8,
                    occurred_at=period.start,
                    received_at=clock.now(),
                    period_start=period.start,
                    idempotency_key="event",
                    meta=None,
                )
            )
            policy = replace(
                DEFAULT_POLICY,
                usage=replace(
                    DEFAULT_POLICY.usage,
                    included_quantity=5,
                    overage="bill_overage",
                    overage_unit_price_minor=250,
                ),
            )
            provider = BillingProvider()
            with pytest.raises(RuntimeError, match="connection lost"):
                await settle_period(
                    sub=sub,
                    period=period,
                    repo=repo,
                    ledger=ledger,
                    policy=policy,
                    provider=provider,
                    clock=clock,
                )
            assert (await repo.operations.list())[0].status == "in_progress"
            assert (await repo.outbox.list(kind="usage.charge"))[0].status == "pending"
            await repo.usage_events.put(
                UsageEvent(
                    id="late",
                    customer_id=sub.customer_id,
                    meter="call",
                    quantity=2,
                    occurred_at=period.start,
                    received_at=clock.now(),
                    period_start=period.start,
                    idempotency_key="late",
                    meta=None,
                )
            )
            assert (
                await settle_period(
                    sub=sub,
                    period=period,
                    repo=repo,
                    ledger=ledger,
                    policy=policy,
                    provider=provider,
                    clock=clock,
                )
            ).status == "pending"
            clock.advance(300000)
            assert (
                await settle_period(
                    sub=sub,
                    period=period,
                    repo=repo,
                    ledger=ledger,
                    policy=policy,
                    provider=provider,
                    clock=clock,
                )
            ).status == "charged"
            assert provider.calls[0] == provider.calls[1]
            delta = await settle_period(
                sub=sub,
                period=period,
                repo=repo,
                ledger=ledger,
                policy=policy,
                provider=provider,
                clock=clock,
            )
            assert delta.charged_amount == Money(amount_minor=500, currency="KRW")
            assert len(provider.charges) == 2
            assert sorted(
                payment.amount.amount_minor
                for payment in await repo.payments.list(kind="overage")
            ) == [500, 750]
        finally:
            await drop_test_db(db)

    anyio.run(run)
