"""EC:E16 -- a native provider (Stripe/Polar) renews on its own and sends payment.succeeded for
a NEW invoice. No local Payment row exists for it yet; the local subscription does.
Mirrors packages/webhook/ts/test/native-renewal.test.ts."""

from __future__ import annotations

import asyncio
import dataclasses
import json
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from _helpers import FakeProvider, json_verify
from boilpayment_core import (
    DEFAULT_POLICY,
    CollectingNotifier,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    LedgerReference,
    Money,
    NewLedgerEntry,
    NormalizedEvent,
    Operation,
    Payment,
    Period,
    Plan,
    PlanPrice,
    SequentialIdGen,
    Subscription,
)
from boilpayment_webhook import default_handlers, process, receive

PERIOD2 = Period(start=datetime(2026, 3, 1, tzinfo=UTC), end=datetime(2026, 4, 1, tzinfo=UTC))


def _setup(
    *, local_status="active", provider_status=None,
    failed_subscriptions: list[Subscription] | None = None,
    provider_reads: list[str] | None = None,
    **remote_overrides,
):
    clock = FixedClock(datetime(2026, 3, 1, 0, 5, tzinfo=UTC))
    repo = InMemoryRepo()
    notifier = CollectingNotifier()
    sub = Subscription(
        id="sub_local", customer_id="cust_1", plan_id="plan_pro", provider="stripe",
        provider_ref="sub_123", status=local_status,
        current_period=Period(start=datetime(2026, 2, 1, tzinfo=UTC), end=PERIOD2.start),
        anchor_day=1, cancel_at_period_end=False, grace_until=None, billing_key=None,
        scheduled_plan_id=None, version=0, created_at=clock.now(),
    )
    remote = Payment(
        id="in_renew_2", customer_id="", provider="stripe", provider_ref="in_renew_2",
        subscription_id="sub_123", amount=Money(amount_minor=2000, currency="USD"),
        status="succeeded", kind="subscription", period=PERIOD2, occurred_at=clock.now(),
        raw={"invoice": "provider-raw"},
    )
    remote = dataclasses.replace(remote, **remote_overrides)
    def get_subscription(ref: str) -> Subscription:
        if provider_reads is not None:
            provider_reads.append(ref)
        return dataclasses.replace(
            sub, status=provider_status or local_status, current_period=PERIOD2
        )

    provider = FakeProvider(
        verify=json_verify("stripe"), name="stripe",
        get_payment_impl=lambda ref: remote,
        get_subscription_impl=get_subscription,
    )
    renewed: list[tuple[str, Payment]] = []

    class FakeDunning:
        async def on_payment_failed(self, **kwargs):
            if failed_subscriptions is not None:
                failed_subscriptions.append(kwargs["sub"])

    class FakeLifecycle:
        dunning = FakeDunning()

        async def on_renewal_paid(self, *, sub, payment, policy, ledger, repo, clock):
            renewed.append((sub.id, payment))

    handlers = default_handlers(
        policy=DEFAULT_POLICY, ledger=InMemoryLedger(SequentialIdGen("led_")), repo=repo,
        notifier=notifier, clock=clock, ids=SequentialIdGen("pay_"), lifecycle=FakeLifecycle(),
    )

    async def deliver(event_id: str, event_type: str = "payment.succeeded"):
        raw_body = json.dumps({
            "id": event_id, "type": event_type, "occurredAt": clock.now().isoformat(),
            "customerRef": "cus_1", "subscriptionRef": "sub_123", "paymentRef": "in_renew_2",
        })
        r = await receive(provider=provider, headers={"x-sig": "ok"}, raw_body=raw_body, repo=repo, clock=clock)
        await process(event_id=r.event_id, providers={"stripe": provider}, handlers=handlers, repo=repo, clock=clock)
        return await repo.webhook_events.get(r.event_id)

    return repo, sub, notifier, renewed, deliver


def test_sb_07_failed_renewal_verifies_advanced_provider_period_but_duns_stored_paid_period():
    async def run():
        failed: list[Subscription] = []
        reads: list[str] = []
        repo, sub, _, _, deliver = _setup(
            provider_status="past_due",
            failed_subscriptions=failed,
            provider_reads=reads,
        )
        await repo.subscriptions.put(sub)

        await deliver("evt_failed_advanced_period", "subscription.payment_failed")

        assert reads == ["sub_123"]
        assert len(failed) == 1
        assert failed[0].status == "past_due"
        assert failed[0].current_period == sub.current_period

    asyncio.run(run())


def test_ec_e16_records_renewal_invoice_and_renews():
    async def run():
        repo, sub, notifier, renewed, deliver = _setup()
        await repo.subscriptions.put(sub)
        record = await deliver("evt_renew_1")
        assert record.error is None
        assert record.status == "processed"
        payments = await repo.payments.list(provider_ref="in_renew_2")
        assert len(payments) == 1
        p = payments[0]
        assert (p.customer_id, p.subscription_id, p.kind, p.status) == ("cust_1", "sub_local", "subscription", "succeeded")
        assert p.amount == Money(amount_minor=2000, currency="USD")
        assert p.raw == {"invoice": "provider-raw"}
        assert [s for s, _ in renewed] == ["sub_local"]
        assert renewed[0][1].id == p.id
        assert notifier.sent == []

    asyncio.run(run())


def test_ec_e16_redelivery_does_not_create_second_row():
    async def run():
        repo, sub, _, _, deliver = _setup()
        await repo.subscriptions.put(sub)
        await deliver("evt_renew_1")
        await deliver("evt_renew_1_again")
        assert len(await repo.payments.list(provider_ref="in_renew_2")) == 1

    asyncio.run(run())


def test_ec_e16_payment_of_another_subscription_is_refused():
    async def run():
        repo, sub, _, renewed, deliver = _setup(subscription_id="sub_OTHER")
        await repo.subscriptions.put(sub)
        record = await deliver("evt_renew_foreign")
        assert record.status == "failed"
        assert record.error == "unknown_provider_ref"
        assert await repo.payments.list(provider_ref="in_renew_2") == []
        assert renewed == []

    asyncio.run(run())


def test_ec_e16_unknown_subscription_still_fails_as_unknown_payment():
    async def run():
        repo, _, notifier, _, deliver = _setup()
        record = await deliver("evt_renew_nosub")
        assert record.error == "unknown_provider_ref"
        assert notifier.sent[0].type == "reconcile.mismatch"
        assert notifier.sent[0].payload["kind"] == "payment"
        assert await repo.payments.list() == []

    asyncio.run(run())


@pytest.mark.parametrize("status", ["expired", "canceled"])
def test_sb_10_late_successful_renewal_for_closed_subscription_is_parked_once(status):
    async def run():
        repo, sub, notifier, renewed, deliver = _setup(
            local_status=status, provider_status="active"
        )
        await repo.subscriptions.put(sub)

        await deliver("evt_late_renewal_1")
        await deliver("evt_late_renewal_redelivery")

        assert renewed == []
        assert (await repo.subscriptions.get(sub.id)).status == status
        payments = await repo.payments.list(provider_ref="in_renew_2")
        assert len(payments) == 1
        cases = await repo.cs_cases.list(reference_id=payments[0].id)
        assert len(cases) == 1
        assert cases[0].customer_id == "cust_1"
        assert cases[0].status == "needs_human"
        notices = [notice for notice in notifier.sent if notice.type == "cs.needs_human"]
        assert len(notices) == 1
        assert notices[0].customer_id == "cust_1"
        assert notices[0].payload["paymentId"] == payments[0].id

    asyncio.run(run())


def test_sb_03_trial_checkout_persists_subscription_then_first_paid_invoice_grants_once():
    """[SB-03] Trial checkout persists identity; only the first paid invoice grants."""
    async def run():
        clock = FixedClock(datetime(2026, 3, 1, tzinfo=UTC))
        repo = InMemoryRepo()
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        notifier = CollectingNotifier()
        checkout_id = "cs_trial_1"
        subscription_ref = "sub_trial_1"
        subscription_id = f"subscription:stripe:{subscription_ref}"
        trial_period = Period(
            start=clock.now(), end=datetime(2026, 3, 15, tzinfo=UTC)
        )
        paid_period = Period(
            start=trial_period.end, end=datetime(2026, 4, 15, tzinfo=UTC)
        )
        state = {"status": "trialing"}
        remote_sub = Subscription(
            id=subscription_ref,
            customer_id="cus_provider",
            plan_id="provider_plan",
            provider="stripe",
            provider_ref=subscription_ref,
            status="trialing",
            current_period=trial_period,
            anchor_day=15,
            cancel_at_period_end=False,
            grace_until=None,
            billing_key=None,
            scheduled_plan_id=None,
            version=0,
            created_at=clock.now(),
        )
        opening_invoice = Payment(
            id="in_trial_opening",
            customer_id="",
            provider="stripe",
            provider_ref="in_trial_opening",
            subscription_id=subscription_ref,
            amount=Money(amount_minor=0, currency="USD"),
            status="succeeded",
            kind="subscription",
            period=trial_period,
            occurred_at=clock.now(),
            raw={"billing_reason": "subscription_create"},
        )
        paid_invoice = Payment(
            id="in_trial_paid",
            customer_id="",
            provider="stripe",
            provider_ref="in_trial_paid",
            subscription_id=subscription_ref,
            amount=Money(amount_minor=2000, currency="USD"),
            status="succeeded",
            kind="subscription",
            period=paid_period,
            occurred_at=paid_period.start,
            raw={"billing_reason": "subscription_cycle"},
        )
        current_payment = {"value": opening_invoice}

        def verify(headers, raw_body):
            raw = json.loads(raw_body)
            obj = raw["data"]["object"]
            checkout = raw["type"] == "checkout.session.completed"
            stripe_event = SimpleNamespace(
                type=raw["type"],
                data=SimpleNamespace(object=SimpleNamespace(**obj)),
            )
            return NormalizedEvent(
                id=raw["id"],
                provider="stripe",
                type="subscription.created" if checkout else "payment.succeeded",
                occurred_at=clock.now(),
                customer_ref=obj["customer"],
                subscription_ref=obj["subscription"],
                payment_ref=None if checkout else obj["id"],
                amount=None,
                raw=stripe_event,
            )

        provider = FakeProvider(
            name="stripe",
            verify=verify,
            get_payment_impl=lambda ref: current_payment["value"],
            get_subscription_impl=lambda ref: dataclasses.replace(
                remote_sub,
                status=state["status"],
                current_period=trial_period
                if state["status"] == "trialing"
                else paid_period,
            ),
        )

        class FakeDunning:
            async def on_payment_failed(self, **kwargs):
                return None

        class FakeLifecycle:
            dunning = FakeDunning()

            async def on_renewal_paid(
                self, *, sub, payment, policy, ledger, repo, clock
            ):
                await ledger.append(NewLedgerEntry(
                    customer_id=sub.customer_id,
                    pool="paid",
                    kind="grant",
                    amount=100,
                    source="subscription",
                    idempotency_key=f"renewal:{payment.id}",
                    actor="system",
                    expires_at=payment.period.end if payment.period else None,
                    reference=LedgerReference(
                        subscription_id=sub.id, payment_id=payment.id
                    ),
                ))
                fresh = await repo.subscriptions.get(sub.id)
                await repo.subscriptions.put(dataclasses.replace(
                    fresh,
                    status="active",
                    current_period=payment.period,
                ))

        operation_key = f"checkout-entitlement-by-id:{checkout_id}"
        await repo.operations.put(Operation(
            id=operation_key,
            key=operation_key,
            kind="checkout.entitlement",
            payload_hash="snapshot",
            status="done",
            result={
                "customer_id": "cust_local",
                "provider": "stripe",
                "plan": {"id": "plan_trial"},
                "price": {"currency": "USD"},
            },
            created_at=clock.now(),
            completed_at=clock.now(),
            attempts=1,
        ))
        await repo.plans.put(Plan(
            id="plan_trial",
            name="Trial plan",
            interval="month",
            credits_per_period=100,
            usage_included=0,
            trial_days=14,
            prices=[PlanPrice(currency="USD", amount_minor=2000)],
        ))
        handlers = default_handlers(
            policy=DEFAULT_POLICY,
            ledger=ledger,
            repo=repo,
            notifier=notifier,
            clock=clock,
            ids=SequentialIdGen("pay_"),
            lifecycle=FakeLifecycle(),
        )

        async def deliver(raw):
            received = await receive(
                provider=provider,
                headers={},
                raw_body=json.dumps(raw),
                repo=repo,
                clock=clock,
            )
            await process(
                event_id=received.event_id,
                providers={"stripe": provider},
                handlers=handlers,
                repo=repo,
                clock=clock,
            )
            return await repo.webhook_events.get(received.event_id)

        created = await deliver({
            "id": "evt_trial_created",
            "type": "checkout.session.completed",
            "data": {"object": {
                "id": checkout_id,
                "mode": "subscription",
                "customer": "cus_provider",
                "subscription": subscription_ref,
            }},
        })
        assert created.status == "processed"
        stored = await repo.subscriptions.get(subscription_id)
        assert stored.customer_id == "cust_local"
        assert stored.plan_id == "plan_trial"
        assert stored.provider == "stripe"
        assert stored.provider_ref == subscription_ref
        assert stored.currency == "USD"
        assert stored.status == "trialing"
        assert stored.current_period == trial_period
        assert (await ledger.balance("cust_local", "paid", clock.now())).available == 0

        opening = await deliver({
            "id": "evt_trial_opening",
            "type": "invoice.paid",
            "data": {"object": {
                "id": opening_invoice.provider_ref,
                "customer": "cus_provider",
                "subscription": subscription_ref,
            }},
        })
        opening_redelivery = await deliver({
            "id": "evt_trial_opening_redelivery",
            "type": "invoice.paid",
            "data": {"object": {
                "id": opening_invoice.provider_ref,
                "customer": "cus_provider",
                "subscription": subscription_ref,
            }},
        })
        assert opening.status == "processed"
        assert opening_redelivery.status == "processed"
        opening_payments = await repo.payments.list(
            provider_ref=opening_invoice.provider_ref
        )
        assert len(opening_payments) == 1
        assert opening_payments[0].raw["boilpaymentTrialOpeningInvoice"] is True
        stored = await repo.subscriptions.get(subscription_id)
        assert stored.status == "trialing"
        assert stored.current_period == trial_period
        assert await ledger.entries("cust_local", kind="grant") == []

        state["status"] = "active"
        current_payment["value"] = paid_invoice
        paid = await deliver({
            "id": "evt_trial_paid",
            "type": "invoice.paid",
            "data": {"object": {
                "id": paid_invoice.provider_ref,
                "customer": "cus_provider",
                "subscription": subscription_ref,
            }},
        })
        paid_redelivery = await deliver({
            "id": "evt_trial_paid_redelivery",
            "type": "invoice.paid",
            "data": {"object": {
                "id": paid_invoice.provider_ref,
                "customer": "cus_provider",
                "subscription": subscription_ref,
            }},
        })
        assert paid.status == "processed"
        assert paid_redelivery.status == "processed"
        grants = await ledger.entries("cust_local", kind="grant")
        assert len(grants) == 1
        assert grants[0].amount == 100
        assert len(
            await repo.payments.list(provider_ref=paid_invoice.provider_ref)
        ) == 1
        stored = await repo.subscriptions.get(subscription_id)
        assert stored.status == "active"
        assert stored.current_period == paid_period

    asyncio.run(run())


def test_sb_03_direct_dashboard_subscription_without_snapshot_is_ignored():
    """[SB-03] Direct provider subscriptions cannot invent local customer or plan identity."""
    async def run():
        clock = FixedClock(datetime(2026, 3, 1, tzinfo=UTC))
        repo = InMemoryRepo()
        remote = Subscription(
            id="sub_dashboard",
            customer_id="cus_provider",
            plan_id="provider_plan",
            provider="stripe",
            provider_ref="sub_dashboard",
            status="trialing",
            current_period=Period(
                start=clock.now(), end=datetime(2026, 3, 15, tzinfo=UTC)
            ),
            anchor_day=15,
            cancel_at_period_end=False,
            grace_until=None,
            billing_key=None,
            scheduled_plan_id=None,
            created_at=clock.now(),
        )

        def verify(headers, raw_body):
            return NormalizedEvent(
                id="evt_dashboard",
                provider="stripe",
                type="subscription.created",
                occurred_at=clock.now(),
                customer_ref="cus_provider",
                subscription_ref=remote.provider_ref,
                payment_ref=None,
                amount=None,
                raw={
                    "type": "customer.subscription.created",
                    "data": {"object": {"id": remote.provider_ref}},
                },
            )

        provider = FakeProvider(
            name="stripe",
            verify=verify,
            get_subscription_impl=lambda ref: remote,
        )
        handlers = default_handlers(
            policy=DEFAULT_POLICY,
            ledger=InMemoryLedger(SequentialIdGen("led_")),
            repo=repo,
            notifier=CollectingNotifier(),
            clock=clock,
            ids=SequentialIdGen("pay_"),
        )
        received = await receive(
            provider=provider, headers={}, raw_body="{}", repo=repo, clock=clock
        )
        await process(
            event_id=received.event_id,
            providers={"stripe": provider},
            handlers=handlers,
            repo=repo,
            clock=clock,
        )

        assert await repo.subscriptions.list() == []
        assert provider.get_subscription_called is False

    asyncio.run(run())
