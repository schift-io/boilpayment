"""[EC:D18] An external refund's revoke racing a consume on Postgres never drives the balance below
zero under negativeBalance=block, and a clamped revoke opens a reconcile case."""
from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime

from boilpayment_core import (
    ConsumeInput,
    Customer,
    LedgerReference,
    Money,
    NewLedgerEntry,
    NormalizedEvent,
    Payment,
    SystemClock,
    UuidIdGen,
)
from boilpayment_refund import OnExternalRefundInput, on_external_refund
from boilpayment_schema_postgres import PostgresLedgerStore, PostgresRepo
from db_helper import create_test_db, drop_test_db


class _Cs:
    def __init__(self) -> None:
        self.cases = 0

    async def open_reconcile_mismatch_case(self, **kwargs) -> None:
        self.cases += 1


def test_ec_d18_external_refund_vs_consume_never_negative() -> None:
    async def run():
        db = await create_test_db("py_extrefund")
        out = []
        try:
            ledger, repo = PostgresLedgerStore(db.dsn), PostgresRepo(db.dsn)
            for rnd in range(8):
                c = f"c_{uuid.uuid4()}"
                await repo.customers.put(Customer(id=c, email=None, provider_refs=[], status="active", created_at=datetime.now(UTC)))
                payment = Payment(id=f"p_{uuid.uuid4()}", customer_id=c, provider="stripe", provider_ref=f"pi_{uuid.uuid4()}",
                                  subscription_id=None, amount=Money(amount_minor=1000, currency="USD"), status="succeeded",
                                  kind="topup", period=None, occurred_at=datetime.now(UTC), failure=None)
                await repo.payments.put(payment)
                await ledger.append(NewLedgerEntry(customer_id=c, pool="paid", kind="grant", amount=100, unit_price_minor=10,
                                                   currency="USD", source="topup", reference=LedgerReference(payment_id=payment.id),
                                                   idempotency_key=f"topup:{payment.id}", actor="t"))
                cs = _Cs()
                event = NormalizedEvent(id=f"evt_{rnd}", provider="stripe", type="refund.created", occurred_at=datetime.now(UTC), customer_ref=None,
                                        subscription_ref=None, payment_ref=payment.provider_ref, refund_ref=f"re_{rnd}",
                                        amount=Money(amount_minor=1000, currency="USD"), raw={})
                refund, consume = await asyncio.gather(
                    on_external_refund(OnExternalRefundInput(event=event, ledger=ledger, repo=repo, cs=cs,
                                                             clock=SystemClock(), ids=UuidIdGen())),
                    ledger.consume(ConsumeInput(customer_id=c, pool_order=["paid"], amount=100, idempotency_key=f"use_{rnd}",
                                                meta=LedgerReference(), now=datetime.now(UTC), negative_balance="block",
                                                negative_floor=0)),
                )
                bal = (await ledger.balance(c, None, datetime.now(UTC))).available
                out.append((bal, refund.credits_revoked, consume.ok, cs.cases))
        finally:
            await drop_test_db(db)
        return out

    rounds = asyncio.run(run())
    print("[EC:D18 py] rounds", rounds)
    for bal, revoked, consumed, cases in rounds:
        assert bal >= 0
        assert revoked + (100 if consumed else 0) <= 100
        if revoked < 100:
            assert cases > 0
