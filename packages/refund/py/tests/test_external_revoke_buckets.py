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


def test_ec_d20_full_refund_of_uneven_price_revokes_all_credits_without_case() -> None:
    """[EC:D20] 1999 minor bought 1000 credits (unit price 1, remainder 999): the refund's share of the payment decides."""
    async def run():
        clock = FixedClock(datetime(2026, 1, 1, tzinfo=UTC))
        ledger, repo = InMemoryLedger(SequentialIdGen("l_"), clock), InMemoryRepo()
        await repo.payments.put(Payment(id="pay_1", customer_id="c", provider="stripe", provider_ref="in_1", subscription_id=None,
                                        amount=Money(amount_minor=1999, currency="USD"), status="succeeded", kind="subscription",
                                        period=None, occurred_at=clock.now(), failure=None))
        await ledger.append(NewLedgerEntry(customer_id="c", pool="paid", kind="grant", amount=1000, unit_price_minor=1, currency="USD",
                                           source="subscription", reference=LedgerReference(payment_id="pay_1"),
                                           idempotency_key="grant:s", actor="t", reason="remainder_minor:999"))
        cases: list[str] = []

        class Cs:
            async def open_reconcile_mismatch_case(self, *, reason: str, **kwargs) -> None:
                cases.append(reason)

        out = []
        for ref, minor in (("re_1", 1000), ("re_2", 999)):
            event = NormalizedEvent(id=f"evt_{ref}", provider="stripe", type="refund.created", occurred_at=clock.now(), customer_ref=None,
                                    subscription_ref=None, payment_ref="in_1", refund_ref=ref,
                                    amount=Money(amount_minor=minor, currency="USD"), raw={})
            r = await on_external_refund(OnExternalRefundInput(event=event, ledger=ledger, repo=repo, cs=Cs(), clock=clock,
                                                               ids=SequentialIdGen(f"i_{ref}_")))
            out.append(r.credits_revoked)
        return out, cases, (await ledger.balance("c", None, clock.now())).available

    assert asyncio.run(run()) == ([500, 500], [], 0)


def test_sb_11_external_anchor_invoice_refund_revokes_linked_delta_bucket() -> None:
    async def run():
        clock = FixedClock(datetime(2026, 1, 1, tzinfo=UTC))
        ledger, repo = InMemoryLedger(SequentialIdGen("l_"), clock), InMemoryRepo()
        invoice = Payment(
            id="pay_sb11_invoice", customer_id="c", provider="stripe", provider_ref="in_sb11",
            subscription_id="sub_1", amount=Money(amount_minor=2000, currency="USD"), status="succeeded",
            kind="subscription", period=None, occurred_at=clock.now(), failure=None,
        )
        await repo.payments.put(invoice)
        await ledger.append(NewLedgerEntry(
            customer_id="c", pool="paid", kind="grant", amount=1000, unit_price_minor=1, currency="USD",
            source="topup", reference=LedgerReference(payment_id="pay_unrelated"),
            idempotency_key="topup:unrelated", actor="t",
        ))
        delta = (await ledger.append(NewLedgerEntry(
            customer_id="c", pool="paid", kind="grant", amount=2000, unit_price_minor=None, currency=None,
            source="subscription", reference=LedgerReference(payment_id="pay_sb11_difference"),
            idempotency_key="grant:sb11:delta", actor="t",
        ))).entry
        for suffix in ("", ":duplicate"):
            await ledger.append(NewLedgerEntry(
                customer_id="c", pool="paid", kind="adjust", amount=0, unit_price_minor=None, currency=None,
                source="subscription", reference=LedgerReference(payment_id=invoice.id, grant_id=delta.id),
                idempotency_key=f"attribute:sb11{suffix}", actor="system",
                reason="SB-11 upgrade_invoice_attribution",
            ))
        event = NormalizedEvent(
            id="evt_sb11", provider="stripe", type="refund.created", occurred_at=clock.now(), customer_ref=None,
            subscription_ref=None, payment_ref=invoice.provider_ref, refund_ref="re_sb11",
            amount=Money(amount_minor=1000, currency="USD"), raw={},
        )

        refund = await on_external_refund(OnExternalRefundInput(
            event=event, ledger=ledger, repo=repo, cs=_Cs(), clock=clock, ids=SequentialIdGen("i_"),
        ))
        revokes = await ledger.entries("c", kind="revoke")
        return refund.credits_revoked, [entry.reference.grant_id for entry in revokes], delta.id

    credits, grant_ids, delta_id = asyncio.run(run())
    assert credits == 1000
    assert grant_ids == [delta_id]
