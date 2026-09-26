"""PostgresRepo CRUD roundtrip for every table it exposes, plus cs_cases-specific behavior:
policy_snapshot dedup and [EC:I7] partial-unique-index dedup.

pytest-asyncio is not installed -> every test wraps its async body with asyncio.run().
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import psycopg
import pytest
from boilpayment_core import (
    DEFAULT_POLICY,
    CsCase,
    Customer,
    Money,
    OutboxItem,
    Payment,
    Period,
    Plan,
    PlanPrice,
    ProviderRef,
    Refund,
    Subscription,
    UsageEvent,
    WebhookEventRecord,
)
from boilpayment_schema_postgres import PostgresRepo
from db_helper import create_test_db, drop_test_db


def test_customers_roundtrip():
    async def run():
        db = await create_test_db("py_repo_customers")
        try:
            repo = PostgresRepo(db.dsn)
            now = datetime.now(UTC)
            c = Customer(
                id="cust_repo_1",
                email="repo1@test.example",
                provider_refs=[ProviderRef(provider="stripe", ref="cus_x1")],
                status="active",
                created_at=now,
            )
            await repo.customers.put(c)
            back = await repo.customers.get(c.id)
            assert back is not None
            assert back.email == "repo1@test.example"
            assert back.provider_refs == [ProviderRef(provider="stripe", ref="cus_x1")]
            assert back.status == "active"
        finally:
            await drop_test_db(db)

    asyncio.run(run())


def test_plans_roundtrip_with_plan_prices():
    async def run():
        db = await create_test_db("py_repo_plans")
        try:
            repo = PostgresRepo(db.dsn)
            plan = Plan(
                id="plan_repo_1",
                name="Repo Pro",
                interval="month",
                credits_per_period=500,
                usage_included=100,
                trial_days=14,
                prices=[
                    PlanPrice(currency="USD", amount_minor=2900),
                    PlanPrice(
                        currency="KRW",
                        amount_minor=39000,
                        provider_price_refs={"stripe": "price_krw_1"},
                    ),
                ],
            )
            await repo.plans.put(plan)
            back = await repo.plans.get(plan.id)
            assert back is not None
            assert back.name == "Repo Pro"
            assert len(back.prices) == 2
            krw = next(p for p in back.prices if p.currency == "KRW")
            assert krw.provider_price_refs == {"stripe": "price_krw_1"}
        finally:
            await drop_test_db(db)

    asyncio.run(run())


def test_subscriptions_roundtrip():
    async def run():
        db = await create_test_db("py_repo_subs")
        try:
            repo = PostgresRepo(db.dsn)
            now = datetime.now(UTC)
            end = now + timedelta(days=30)
            await repo.customers.put(
                Customer(
                    id="cust_repo_sub",
                    email=None,
                    provider_refs=[],
                    status="active",
                    created_at=now,
                )
            )
            await repo.plans.put(
                Plan(
                    id="plan_repo_sub",
                    name="Sub plan",
                    interval="month",
                    credits_per_period=100,
                    usage_included=0,
                    trial_days=0,
                    prices=[],
                )
            )
            sub = Subscription(
                id="sub_repo_1",
                customer_id="cust_repo_sub",
                plan_id="plan_repo_sub",
                provider="stripe",
                provider_ref="sub_ref_1",
                status="active",
                current_period=Period(start=now, end=end),
                anchor_day=1,
                cancel_at_period_end=False,
                grace_until=None,
                billing_key=None,
                scheduled_plan_id=None,
                created_at=now,
            )
            await repo.subscriptions.put(sub)
            back = await repo.subscriptions.get(sub.id)
            assert back is not None
            assert back.current_period.start == now
            assert back.current_period.end == end
            assert back.status == "active"
        finally:
            await drop_test_db(db)

    asyncio.run(run())


def test_payments_roundtrip():
    async def run():
        db = await create_test_db("py_repo_payments")
        try:
            repo = PostgresRepo(db.dsn)
            now = datetime.now(UTC)
            await repo.customers.put(
                Customer(
                    id="cust_repo_pay",
                    email=None,
                    provider_refs=[],
                    status="active",
                    created_at=now,
                )
            )
            payment = Payment(
                id="pay_repo_1",
                customer_id="cust_repo_pay",
                provider="stripe",
                provider_ref="pi_1",
                subscription_id=None,
                amount=Money(amount_minor=2900, currency="USD"),
                status="succeeded",
                kind="topup",
                period=None,
                occurred_at=now,
                failure=None,
                raw={"foo": "bar"},
            )
            await repo.payments.put(payment)
            back = await repo.payments.get(payment.id)
            assert back is not None
            assert back.amount == Money(amount_minor=2900, currency="USD")
            assert back.status == "succeeded"
            assert back.raw == {"foo": "bar"}
        finally:
            await drop_test_db(db)

    asyncio.run(run())


def test_usage_events_roundtrip():
    async def run():
        db = await create_test_db("py_repo_usage")
        try:
            repo = PostgresRepo(db.dsn)
            now = datetime.now(UTC)
            await repo.customers.put(
                Customer(
                    id="cust_repo_usage",
                    email=None,
                    provider_refs=[],
                    status="active",
                    created_at=now,
                )
            )
            ev = UsageEvent(
                id="usage_repo_1",
                customer_id="cust_repo_usage",
                meter="api_calls",
                quantity=42,
                occurred_at=now,
                received_at=now,
                period_start=now - timedelta(days=1),
                idempotency_key="usage:repo:1",
                meta={"requestId": "req_1"},
            )
            await repo.usage_events.put(ev)
            back = await repo.usage_events.get(ev.id)
            assert back is not None
            assert back.meter == "api_calls"
            assert back.quantity == 42
            assert back.meta == {"requestId": "req_1"}
        finally:
            await drop_test_db(db)

    asyncio.run(run())


def test_refunds_roundtrip():
    async def run():
        db = await create_test_db("py_repo_refunds")
        try:
            repo = PostgresRepo(db.dsn)
            now = datetime.now(UTC)
            await repo.customers.put(
                Customer(
                    id="cust_repo_refund",
                    email=None,
                    provider_refs=[],
                    status="active",
                    created_at=now,
                )
            )
            payment = Payment(
                id="pay_repo_refund",
                customer_id="cust_repo_refund",
                provider="stripe",
                provider_ref="pi_refund_1",
                subscription_id=None,
                amount=Money(amount_minor=5000, currency="USD"),
                status="succeeded",
                kind="topup",
                period=None,
                occurred_at=now,
                failure=None,
            )
            await repo.payments.put(payment)
            refund = Refund(
                id="refund_repo_1",
                payment_id=payment.id,
                customer_id="cust_repo_refund",
                amount=Money(amount_minor=5000, currency="USD"),
                status="succeeded",
                provider_ref="re_1",
                credits_revoked=10,
                rule_id="D1",
                reason="requested",
                failure=None,
                created_at=now,
            )
            await repo.refunds.put(refund)
            back = await repo.refunds.get(refund.id)
            assert back is not None
            assert back.status == "succeeded"
            assert back.credits_revoked == 10
            assert back.rule_id == "D1"
        finally:
            await drop_test_db(db)

    asyncio.run(run())


def test_webhook_events_roundtrip():
    async def run():
        db = await create_test_db("py_repo_webhook")
        try:
            repo = PostgresRepo(db.dsn)
            now = datetime.now(UTC)
            ev = WebhookEventRecord(
                id="evt_repo_1",
                provider="stripe",
                type="payment.succeeded",
                status="received",
                raw_body='{"id":"evt_repo_1"}',
                headers={"stripe-signature": "sig_1"},
                received_at=now,
                processed_at=None,
                error=None,
                attempts=0,
                customer_id=None,
                payment_id=None,
                subscription_id=None,
            )
            await repo.webhook_events.put(ev)
            back = await repo.webhook_events.get(ev.id)
            assert back is not None
            assert back.type == "payment.succeeded"
            assert back.headers == {"stripe-signature": "sig_1"}
        finally:
            await drop_test_db(db)

    asyncio.run(run())


def test_outbox_roundtrip():
    async def run():
        db = await create_test_db("py_repo_outbox")
        try:
            repo = PostgresRepo(db.dsn)
            now = datetime.now(UTC)
            item = OutboxItem(
                id="outbox_repo_1",
                kind="webhook.process",
                payload={"eventId": "evt_repo_1"},
                status="pending",
                attempts=0,
                next_attempt_at=now + timedelta(minutes=5),
                created_at=now,
            )
            await repo.outbox.put(item)
            back = await repo.outbox.get(item.id)
            assert back is not None
            assert back.kind == "webhook.process"
            assert back.payload == {"eventId": "evt_repo_1"}
        finally:
            await drop_test_db(db)

    asyncio.run(run())


def test_cs_cases_policy_snapshot_dedup():
    async def run():
        db = await create_test_db("py_repo_cs_dedup")
        try:
            repo = PostgresRepo(db.dsn)
            now = datetime.now(UTC)
            await repo.customers.put(
                Customer(
                    id="cust_repo_cs_dedup",
                    email=None,
                    provider_refs=[],
                    status="active",
                    created_at=now,
                )
            )
            case1 = CsCase(
                id="cs_repo_dedup_1",
                customer_id="cust_repo_cs_dedup",
                kind="refund",
                status="resolved_auto",
                reference_id="ref_dedup_1",
                policy_snapshot=DEFAULT_POLICY,
                decision=None,
                churn_reason=None,
                churn_text=None,
                opened_at=now,
                resolved_at=now,
            )
            case2 = CsCase(
                id="cs_repo_dedup_2",
                customer_id="cust_repo_cs_dedup",
                kind="dispute",
                status="resolved_auto",
                reference_id="ref_dedup_2",
                policy_snapshot=DEFAULT_POLICY,
                decision=None,
                churn_reason=None,
                churn_text=None,
                opened_at=now,
                resolved_at=now,
            )
            await repo.cs_cases.put(case1)
            await repo.cs_cases.put(case2)
            back1 = await repo.cs_cases.get(case1.id)
            back2 = await repo.cs_cases.get(case2.id)
            assert back1 is not None and back2 is not None
            assert back1.policy_snapshot.upgrade.mode == DEFAULT_POLICY.upgrade.mode
            assert back2.policy_snapshot.upgrade.mode == DEFAULT_POLICY.upgrade.mode

            conn = await psycopg.AsyncConnection.connect(db.dsn, autocommit=True)
            try:
                async with conn.cursor() as cur:
                    await cur.execute(
                        "select count(distinct policy_snapshot_id) from cs_cases where id = any(%s)",
                        ([case1.id, case2.id],),
                    )
                    row = await cur.fetchone()
                    assert (
                        row[0] == 1
                    )  # both rows point at the SAME dedup'd policy_snapshots row
            finally:
                await conn.close()
        finally:
            await drop_test_db(db)

    asyncio.run(run())


def test_cs_cases_i7_open_case_dedup_partial_unique_index():
    async def run():
        db = await create_test_db("py_repo_cs_i7")
        try:
            repo = PostgresRepo(db.dsn)
            now = datetime.now(UTC)
            await repo.customers.put(
                Customer(
                    id="cust_repo_i7",
                    email=None,
                    provider_refs=[],
                    status="active",
                    created_at=now,
                )
            )
            case1 = CsCase(
                id="cs_repo_i7_1",
                customer_id="cust_repo_i7",
                kind="regrant",
                status="open",
                reference_id="ref_i7_dup",
                policy_snapshot=DEFAULT_POLICY,
                decision=None,
                churn_reason=None,
                churn_text=None,
                opened_at=now,
                resolved_at=None,
            )
            await repo.cs_cases.put(case1)

            case2_dup = CsCase(
                id="cs_repo_i7_2",
                customer_id="cust_repo_i7",
                kind="regrant",
                status="open",
                reference_id="ref_i7_dup",
                policy_snapshot=DEFAULT_POLICY,
                decision=None,
                churn_reason=None,
                churn_text=None,
                opened_at=now,
                resolved_at=None,
            )
            with pytest.raises(psycopg.errors.UniqueViolation) as exc_info:
                await repo.cs_cases.put(case2_dup)
            assert "cs_cases_open_unique_idx" in str(exc_info.value)

            # after resolving case1, the same (customer_id, kind, reference_id) key must be openable again
            case1.status = "resolved_auto"
            case1.resolved_at = now
            await repo.cs_cases.put(case1)

            case2 = CsCase(
                id="cs_repo_i7_3",
                customer_id="cust_repo_i7",
                kind="regrant",
                status="open",
                reference_id="ref_i7_dup",
                policy_snapshot=DEFAULT_POLICY,
                decision=None,
                churn_reason=None,
                churn_text=None,
                opened_at=now,
                resolved_at=None,
            )
            back = await repo.cs_cases.put(case2)
            assert back.id == "cs_repo_i7_3"
            assert back.status == "open"
        finally:
            await drop_test_db(db)

    asyncio.run(run())
