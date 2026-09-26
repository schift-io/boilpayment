"""[EC:I10] settlement report on Postgres. Mirrors ts/test/settlement-report.test.ts."""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime, timedelta

from boilpayment_core import Customer, Money, NewLedgerEntry, Payment, Refund
from boilpayment_cs import NetLine, PaymentLine, RefundLine, settlement_report
from boilpayment_schema_postgres import PostgresLedgerStore, PostgresRepo
from db_helper import create_test_db, drop_test_db


def test_settlement_report_on_postgres():
    async def run():
        db = await create_test_db("py_settle_report")
        try:
            repo, ledger = PostgresRepo(db.dsn), PostgresLedgerStore(db.dsn)
            c = f"cust_{uuid.uuid4()}"
            await repo.customers.put(
                Customer(id=c, email=None, provider_refs=[], status="active", created_at=datetime(2026, 1, 1, tzinfo=UTC))
            )

            async def mk(pid, at, amount, status):
                await repo.payments.put(
                    Payment(
                        id=pid, customer_id=c, provider="stripe", provider_ref=f"pi_{pid}", subscription_id=None,
                        amount=Money(amount_minor=amount, currency="USD"), status=status, kind="topup", period=None,
                        occurred_at=at, failure=None,
                    )
                )

            await mk(f"p1_{c}", datetime(2026, 1, 5, tzinfo=UTC), 1000, "succeeded")
            await mk(f"p2_{c}", datetime(2026, 1, 6, tzinfo=UTC), 700, "failed")
            await mk(f"p3_{c}", datetime(2026, 2, 1, tzinfo=UTC), 999, "succeeded")
            await repo.refunds.put(
                Refund(
                    id=f"r1_{c}", payment_id=f"p1_{c}", customer_id=c, amount=Money(amount_minor=300, currency="USD"),
                    status="succeeded", provider_ref="re_1", credits_revoked=0, rule_id="D2", reason=None, failure=None,
                    created_at=datetime(2026, 1, 7, tzinfo=UTC),
                )
            )
            await ledger.append(
                NewLedgerEntry(customer_id=c, pool="paid", kind="grant", amount=100, source="topup", idempotency_key=f"g_{c}", actor="s")
            )
            r = await settlement_report(
                repo=repo, ledger=ledger, start=datetime(2026, 1, 1, tzinfo=UTC), end=datetime(2026, 2, 1, tzinfo=UTC)
            )
            assert r.payments == [
                PaymentLine(currency="USD", kind="topup", status="failed", count=1, amount_minor=700),
                PaymentLine(currency="USD", kind="topup", status="succeeded", count=1, amount_minor=1000),
            ]
            assert r.net == [NetLine(currency="USD", amount_minor=1000)]
            assert r.refunds == []  # created_at is the database clock at insert
            now = datetime.now(UTC)
            around = await settlement_report(repo=repo, ledger=ledger, start=now - timedelta(minutes=1), end=now + timedelta(minutes=1))
            assert around.refunds == [RefundLine(currency="USD", count=1, amount_minor=300)]
            assert [(x.kind, x.source, x.count, x.amount) for x in around.credits] == [("grant", "topup", 1, 100)]
        finally:
            await drop_test_db(db)

    asyncio.run(run())
