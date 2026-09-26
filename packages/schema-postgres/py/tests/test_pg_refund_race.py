"""[EC:D17] Two refund requests for the same payment with different keys, racing on Postgres:
exactly one is accepted when their sum exceeds the payment."""
from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime

from boilpayment_core import (
    Customer,
    Money,
    Payment,
    PaymentKitError,
    RefundDecision,
    SystemClock,
    UuidIdGen,
)
from boilpayment_refund import ExecuteInput, execute
from boilpayment_schema_postgres import PostgresLedgerStore, PostgresRepo
from db_helper import create_test_db, drop_test_db


class _Provider:
    name = "stripe"

    async def refund(self, *, payment_ref, amount, reason, idempotency_key, extra=None):
        from boilpayment_core import Refund
        await asyncio.sleep(0.02)
        return Refund(id=f"re_{uuid.uuid4()}", payment_id="", customer_id="", amount=amount, status="succeeded",
                      provider_ref=f"re_{uuid.uuid4()}", credits_revoked=0, rule_id="", reason=reason, failure=None,
                      created_at=datetime.now(UTC))


def test_ec_d17_pg_refund_race() -> None:
    async def run():
        db = await create_test_db("py_refundrace")
        lines = []
        try:
            repo, ledger = PostgresRepo(db.dsn), PostgresLedgerStore(db.dsn)
            for rnd in range(5):
                cid = f"c_{uuid.uuid4()}"
                await repo.customers.put(Customer(id=cid, email=None, provider_refs=[], status="active", created_at=datetime.now(UTC)))
                pay = Payment(id=f"p_{uuid.uuid4()}", customer_id=cid, provider="stripe", provider_ref=f"pi_{uuid.uuid4()}",
                              subscription_id=None, amount=Money(amount_minor=1000, currency="USD"), status="succeeded",
                              kind="topup", period=None, occurred_at=datetime.now(UTC), failure=None)
                await repo.payments.put(pay)

                def decision(n: int, pay: Payment = pay, cid: str = cid) -> RefundDecision:
                    return RefundDecision(eligible=True, amount=Money(amount_minor=600, currency="USD"), credits_to_revoke=0,
                                          rule_id=f"rule_{n}", reason="test", needs_human=False, payment_id=pay.id,
                                          customer_id=cid, subscription_id=None)

                results = await asyncio.gather(*[
                    execute(ExecuteInput(decision=decision(n), provider=_Provider(), ledger=ledger, repo=repo,
                                         clock=SystemClock(), ids=UuidIdGen(), idempotency_key=f"k_{rnd}_{n}"))
                    for n in (1, 2)], return_exceptions=True)
                won = sum(1 for r in results if not isinstance(r, BaseException))
                refused = sum(1 for r in results if isinstance(r, PaymentKitError) and r.code == "refund_invalid_decision")
                total = sum(r.amount.amount_minor for r in await repo.refunds.list(payment_id=pay.id))
                lines.append(f"round={rnd} won={won} refused={refused} refunded={total}")
        finally:
            await drop_test_db(db)
        print(f"[EC:D17 pg race py] {' | '.join(lines)}")
        return lines

    assert all("won=1 refused=1 refunded=600" in line for line in asyncio.run(run()))
