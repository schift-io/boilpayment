"""[EC:D18] An external refund's revoke is tied to grant buckets (mirrors the TS test)."""
from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from boilpayment_core import (
    ConsumeInput,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    LedgerReference,
    Money,
    NewLedgerEntry,
    NormalizedEvent,
    Payment,
    SequentialIdGen,
)
from boilpayment_refund import OnExternalRefundInput, on_external_refund


class _Cs:
    async def open_reconcile_mismatch_case(self, **kwargs) -> None:
        return None


def test_ec_d18_refund_then_consume_refused() -> None:
    async def run():
        clock = FixedClock(datetime(2026, 1, 1, tzinfo=UTC))
        ledger, repo = InMemoryLedger(SequentialIdGen("l_"), clock), InMemoryRepo()
        await repo.payments.put(Payment(id="pay_1", customer_id="c", provider="stripe", provider_ref="pi_1", subscription_id=None,
                                        amount=Money(amount_minor=1000, currency="USD"), status="succeeded", kind="topup",
                                        period=None, occurred_at=clock.now(), failure=None))
        await ledger.append(NewLedgerEntry(customer_id="c", pool="paid", kind="grant", amount=100, unit_price_minor=10, currency="USD",
                                           source="topup", reference=LedgerReference(payment_id="pay_1"),
                                           idempotency_key="topup:pay_1", actor="t"))
        event = NormalizedEvent(id="evt", provider="stripe", type="refund.created", occurred_at=clock.now(), customer_ref=None,
                                subscription_ref=None, payment_ref="pi_1", refund_ref="re_1",
                                amount=Money(amount_minor=1000, currency="USD"), raw={})
        refund = await on_external_refund(OnExternalRefundInput(event=event, ledger=ledger, repo=repo, cs=_Cs(), clock=clock,
                                                                ids=SequentialIdGen("i_")))
        revokes = await ledger.entries("c", kind="revoke")
        use = await ledger.consume(ConsumeInput(customer_id="c", pool_order=["paid"], amount=100, idempotency_key="use",
                                                meta=LedgerReference(), now=clock.now(), negative_balance="block", negative_floor=0))
        return (refund.credits_revoked, all(e.reference.grant_id for e in revokes), use.ok,
                (await ledger.balance("c", None, clock.now())).available)

    assert asyncio.run(run()) == (100, True, False, 0)
