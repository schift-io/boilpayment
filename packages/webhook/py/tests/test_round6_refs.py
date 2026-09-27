"""Round-6 audit A6-1: a Stripe renewal is recorded under its invoice (in_...) while refund and
dispute events name the PaymentIntent (pi_...) or charge (ch_...). EC:E24 -- the webhook resolves the
event to the local payment (exact, alias, provider re-fetch) before refund/cs see it; an event that
matches nothing tells a person once and fails the record instead of using customer 'unknown'.
Mirrors packages/webhook/ts/test/round6-refs.test.ts."""

from __future__ import annotations

import asyncio
import dataclasses
import json
from datetime import UTC, datetime

from _helpers import FakeProvider
from boilpayment_core import (
    DEFAULT_POLICY,
    CollectingNotifier,
    Customer,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    Money,
    NormalizedEvent,
    Payment,
    Period,
    ProviderRef,
    SequentialIdGen,
    Subscription,
    WebhookSignatureError,
)
from boilpayment_webhook import default_handlers, process, receive

PERIOD = Period(
    start=datetime(2026, 3, 1, tzinfo=UTC), end=datetime(2026, 4, 1, tzinfo=UTC)
)
USD = Money(amount_minor=1999, currency="USD")


def _verify(headers: dict[str, str], raw_body: str) -> NormalizedEvent:
    if headers.get("x-sig") != "ok":
        raise WebhookSignatureError()
    p = json.loads(raw_body)
    amount = p.get("amount")
    return NormalizedEvent(
        id=p["id"],
        provider="stripe",
        type=p["type"],
        occurred_at=datetime.fromisoformat(p["occurredAt"]),
        customer_ref=p.get("customerRef"),
        subscription_ref=p.get("subscriptionRef"),
        payment_ref=p.get("paymentRef"),
        amount=Money(amount_minor=amount["amountMinor"], currency=amount["currency"])
        if amount
        else None,
        raw=p,
        refund_ref=p.get("refundRef"),
    )


def _invoice(aliases: list[str] | None) -> Payment:
    return Payment(
        id="in_1",
        customer_id="",
        provider="stripe",
        provider_ref="in_1",
        subscription_id="sub_123",
        amount=USD,
        status="succeeded",
        kind="subscription",
        period=PERIOD,
        occurred_at=PERIOD.start,
        provider_ref_aliases=aliases,
    )


def _intent(knows_invoice: bool) -> Payment:
    return Payment(
        id="pi_1",
        customer_id="",
        provider="stripe",
        provider_ref="pi_1",
        subscription_id=None,
        amount=USD,
        status="refunded",
        kind="subscription",
        period=None,
        occurred_at=PERIOD.start,
        raw={"customer": "cus_1"},
        provider_ref_aliases=["in_1"] if knows_invoice else [],
    )


def _setup(*, invoice_aliases: list[str] | None = None, known_customer: bool = True):
    clock = FixedClock(datetime(2026, 3, 5, tzinfo=UTC))
    repo = InMemoryRepo()
    notifier = CollectingNotifier()
    sub = Subscription(
        id="sub_local",
        customer_id="c1",
        plan_id="p",
        provider="stripe",
        provider_ref="sub_123",
        status="active",
        current_period=Period(start=datetime(2026, 2, 1, tzinfo=UTC), end=PERIOD.start),
        anchor_day=1,
        cancel_at_period_end=False,
        grace_until=None,
        billing_key=None,
        scheduled_plan_id=None,
        version=0,
        created_at=clock.now(),
    )

    def get_payment(ref: str) -> Payment:
        if ref == "in_1":
            return _invoice(invoice_aliases)
        if ref == "pi_1":
            return _intent(False)
        raise RuntimeError("no such payment")

    provider = FakeProvider(
        verify=_verify,
        name="stripe",
        get_payment_impl=get_payment,
        get_subscription_impl=lambda ref: (
            Subscription(**{**sub.__dict__, "current_period": PERIOD})
            if hasattr(sub, "__dict__")
            else sub
        ),
    )
    refunds: list[NormalizedEvent] = []
    disputes: list[NormalizedEvent] = []

    class _Dunning:
        async def on_payment_failed(self, **kwargs):
            return None

    class _Lifecycle:
        dunning = _Dunning()

        async def on_renewal_paid(self, **kwargs):
            return None

    class _Refund:
        async def on_external_refund(self, *, event, **kwargs):
            refunds.append(event)

    class _Cs:
        async def dispute(self, *, event, **kwargs):
            disputes.append(event)

        async def open_reconcile_mismatch_case(self, **kwargs):
            return None

    handlers = default_handlers(
        policy=DEFAULT_POLICY,
        ledger=InMemoryLedger(SequentialIdGen("l_")),
        repo=repo,
        notifier=notifier,
        clock=clock,
        ids=SequentialIdGen("pay_"),
        lifecycle=_Lifecycle(),
        refund=_Refund(),
        cs=_Cs(),
    )

    async def deliver(event_id: str, body: dict):
        raw = json.dumps(
            {
                "id": event_id,
                "occurredAt": clock.now().isoformat(),
                "customerRef": None,
                "subscriptionRef": None,
                **body,
            }
        )
        r = await receive(
            provider=provider,
            headers={"x-sig": "ok"},
            raw_body=raw,
            repo=repo,
            clock=clock,
        )
        await process(
            event_id=r.event_id,
            providers={"stripe": provider},
            handlers=handlers,
            repo=repo,
            clock=clock,
        )
        return await repo.webhook_events.get(r.event_id)

    async def init():
        await repo.subscriptions.put(sub)
        if known_customer:
            await repo.customers.put(
                Customer(
                    id="c1",
                    email=None,
                    status="active",
                    created_at=clock.now(),
                    provider_refs=[ProviderRef(provider="stripe", ref="cus_1")],
                )
            )
        await deliver(
            "evt_paid",
            {
                "type": "payment.succeeded",
                "subscriptionRef": "sub_123",
                "paymentRef": "in_1",
            },
        )

    return repo, notifier, refunds, disputes, deliver, init


REFUND = {
    "type": "refund.created",
    "paymentRef": "pi_1",
    "refundRef": "re_1",
    "amount": {"amountMinor": 1999, "currency": "USD"},
}


def test_ec_e24_refund_on_payment_intent_reaches_refund_as_the_invoice():
    async def run():
        _, _, refunds, _, deliver, init = _setup(invoice_aliases=["pi_1", "ch_1"])
        await init()
        rec = await deliver("evt_re", REFUND)
        assert rec.status == "processed"
        assert [e.payment_ref for e in refunds] == ["in_1"]

    asyncio.run(run())


def test_ec_e24_dispute_on_charge_resolves_to_the_invoice():
    async def run():
        _, _, _, disputes, deliver, init = _setup(invoice_aliases=["pi_1", "ch_1"])
        await init()
        rec = await deliver("evt_dp", {"type": "dispute.opened", "paymentRef": "ch_1"})
        assert rec.status == "processed"
        assert [e.payment_ref for e in disputes] == ["in_1"]

    asyncio.run(run())


def test_ec_e24_row_recorded_before_aliases_is_found_through_the_provider():
    async def run():
        repo, _, refunds, _, deliver, init = _setup(invoice_aliases=["pi_1"])
        await init()
        # a pre-upgrade row: no alias record points at it
        for op in await repo.operations.list():
            if op.kind == "payment.ref_alias":
                await repo.operations.put(dataclasses.replace(op, result={"paymentId": "gone"}))
        rec = await deliver("evt_re", REFUND)
        assert rec.status == "processed"
        assert [e.payment_ref for e in refunds] == ["in_1"]

    asyncio.run(run())


def test_ec_e24_nothing_matches_tells_a_person_once_and_fails_the_record():
    async def run():
        repo, notifier, refunds, _, deliver, init = _setup(known_customer=False)
        await init()
        body = {**REFUND, "paymentRef": "pi_9", "refundRef": "re_9"}
        a = await deliver("evt_re", body)
        assert a.status == "failed"
        assert (
            "names no local payment" in (a.error or "") or a.error == "unmatched_refund"
        )
        await deliver("evt_re", body)
        assert refunds == []
        unmatched = [
            n
            for n in notifier.sent
            if n.type == "cs.needs_human"
            and n.payload.get("kind") == "unmatched_refund"
        ]
        assert len(unmatched) == 1
        assert await repo.cs_cases.list() == []

    asyncio.run(run())
