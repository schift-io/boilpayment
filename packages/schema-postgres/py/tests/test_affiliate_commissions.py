from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from boilpayment_core import (
    AffiliateCommission,
    Customer,
    Money,
    Payment,
    Plan,
    SaleEvidence,
    Subscription,
)
from boilpayment_core.types import Period
from boilpayment_schema_postgres import PostgresRepo
from db_helper import create_test_db, drop_test_db


def test_payment_and_subscription_affiliate_mapping_roundtrip():
    async def run():
        db = await create_test_db('py_affiliate_mapping')
        try:
            repo = PostgresRepo(db.dsn)
            now = datetime(2026, 9, 28, tzinfo=UTC)
            await repo.customers.put(
                Customer(
                    id='cust_affiliate_repo',
                    email=None,
                    provider_refs=[],
                    status='active',
                    created_at=now,
                )
            )
            payment = Payment(
                id='pay_affiliate_repo',
                customer_id='cust_affiliate_repo',
                provider='polar',
                provider_ref='order_affiliate_repo',
                subscription_id=None,
                amount=Money(amount_minor=8_000, currency='KRW'),
                status='succeeded',
                kind='topup',
                period=None,
                occurred_at=now,
                sale_evidence=SaleEvidence(
                    provider_subtotal=Money(amount_minor=10_000, currency='KRW'),
                    discount_amount=Money(amount_minor=2_000, currency='KRW'),
                    price_ref='price_affiliate_repo',
                    checkout_id='checkout_affiliate_repo',
                    payment_link_id=None,
                    link_reference=None,
                ),
                affiliate_id='partner-1',
            )

            await repo.payments.put(payment)
            stored_payment = await repo.payments.get(payment.id)

            assert stored_payment is not None
            assert stored_payment.sale_evidence == payment.sale_evidence
            assert stored_payment.affiliate_id == 'partner-1'

            await repo.plans.put(
                Plan(
                    id='plan_affiliate_repo',
                    name='Affiliate plan',
                    interval='month',
                    credits_per_period=100,
                    usage_included=0,
                    trial_days=0,
                    prices=[],
                )
            )
            subscription = Subscription(
                id='sub_affiliate_repo',
                customer_id='cust_affiliate_repo',
                plan_id='plan_affiliate_repo',
                provider='polar',
                provider_ref='sub_affiliate_repo',
                status='active',
                current_period=Period(
                    start=now, end=datetime(2026, 10, 28, tzinfo=UTC)
                ),
                anchor_day=28,
                cancel_at_period_end=False,
                grace_until=None,
                billing_key=None,
                scheduled_plan_id=None,
                created_at=now,
                affiliate_id='partner-1',
            )

            await repo.subscriptions.put(subscription)
            stored_subscription = await repo.subscriptions.get(subscription.id)

            assert stored_subscription is not None
            assert stored_subscription.affiliate_id == 'partner-1'
        finally:
            await drop_test_db(db)

    asyncio.run(run())


def test_affiliate_commission_append_is_idempotent_and_list_is_filtered():
    async def run():
        db = await create_test_db('py_affiliate_commissions')
        try:
            repo = PostgresRepo(db.dsn)
            now = datetime(2026, 9, 28, tzinfo=UTC)
            await repo.customers.put(
                Customer(
                    id='cust_affiliate_commission',
                    email=None,
                    provider_refs=[],
                    status='active',
                    created_at=now,
                )
            )
            payment = Payment(
                id='pay_affiliate_commission',
                customer_id='cust_affiliate_commission',
                provider='polar',
                provider_ref='order_affiliate_commission',
                subscription_id=None,
                amount=Money(amount_minor=8_000, currency='KRW'),
                status='succeeded',
                kind='topup',
                period=None,
                occurred_at=now,
            )
            await repo.payments.put(payment)
            accrual = AffiliateCommission(
                id='commission-accrual-1',
                kind='accrual',
                affiliate_id='partner-1',
                payment_id=payment.id,
                refund_id=None,
                related_accrual_id=None,
                amount=Money(amount_minor=800, currency='KRW'),
                idempotency_key='affiliate:pay_affiliate_commission:accrual',
                created_at=now,
            )
            replay = AffiliateCommission(
                id='commission-replay-must-not-replace',
                kind='accrual',
                affiliate_id='partner-1',
                payment_id=payment.id,
                refund_id=None,
                related_accrual_id=None,
                amount=Money(amount_minor=999, currency='KRW'),
                idempotency_key=accrual.idempotency_key,
                created_at=now,
            )

            first = await repo.affiliate_commissions.append(accrual)
            second = await repo.affiliate_commissions.append(replay)
            by_affiliate = await repo.affiliate_commissions.list(
                affiliate_id='partner-1'
            )
            by_payment = await repo.affiliate_commissions.list(
                payment_id=payment.id, kind='accrual'
            )

            assert first == accrual
            assert second == accrual
            assert by_affiliate == [accrual]
            assert by_payment == [accrual]
        finally:
            await drop_test_db(db)

    asyncio.run(run())
