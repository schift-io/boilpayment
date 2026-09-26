"""Phase 6 regression test -- mirrors examples/e2e/round_trip.py step 02: webhook.receive +
webhook.process on a payment.succeeded event drives lifecycle.on_renewal_paid (injected as a
LifecycleDeps-shaped fake, per spec/webhook.pseudo.md -- lifecycle is duck-typed, not imported)
and results in a fresh 100-credit grant; replaying the identical event is a true no-op."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime

from _helpers import FakeProvider, json_verify
from schift_payment_kit_core import (
    DEFAULT_POLICY,
    CollectingNotifier,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    LedgerReference,
    Money,
    NewLedgerEntry,
    Payment,
    Period,
    SequentialIdGen,
    Subscription,
)
from schift_payment_kit_webhook import default_handlers, process, receive


def test_receive_process_round_trip_grants_100_credits_and_replay_is_no_op():
    async def run():
        clock = FixedClock(datetime(2026, 1, 1, tzinfo=UTC))
        repo = InMemoryRepo()
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        notifier = CollectingNotifier()

        period = Period(start=clock.now(), end=datetime(2026, 2, 1, tzinfo=UTC))
        sub = Subscription(
            id="sub1",
            customer_id="cust1",
            plan_id="planA",
            provider="stripe",
            provider_ref="sub_1",
            status="active",
            current_period=period,
            anchor_day=1,
            cancel_at_period_end=False,
            grace_until=None,
            billing_key=None,
            scheduled_plan_id=None,
            created_at=clock.now(),
        )
        payment = Payment(
            id="pay1",
            customer_id="cust1",
            provider="stripe",
            provider_ref="pay_1",
            subscription_id="sub1",
            amount=Money(amount_minor=1000, currency="USD"),
            status="succeeded",
            kind="subscription",
            period=period,
            occurred_at=clock.now(),
            failure=None,
        )
        await repo.subscriptions.put(sub)
        await repo.payments.put(payment)

        provider = FakeProvider(
            verify=json_verify(),
            get_payment_impl=lambda ref: payment,
            get_subscription_impl=lambda ref: sub,
        )

        # Fake lifecycle.on_renewal_paid: appends a 100-credit grant idempotently keyed by payment id
        # (a real lifecycle package would do the same -- see examples/e2e/round_trip.py step 02, where
        # planA.credits_per_period=100 and the resulting balance is 100).
        class FakeDunning:
            async def on_payment_failed(self, **kwargs):
                return None

        class FakeLifecycle:
            dunning = FakeDunning()

            async def on_renewal_paid(
                self, *, sub, payment, policy, ledger, repo, clock
            ):
                await ledger.append(
                    NewLedgerEntry(
                        customer_id=payment.customer_id,
                        pool="paid",
                        kind="grant",
                        amount=100,
                        source="subscription",
                        idempotency_key=f"renewal:{payment.id}",
                        actor="system",
                        reference=LedgerReference(
                            subscription_id=sub.id, payment_id=payment.id
                        ),
                    )
                )

        handlers = default_handlers(
            policy=DEFAULT_POLICY,
            ledger=ledger,
            repo=repo,
            notifier=notifier,
            clock=clock,
            ids=SequentialIdGen("id_"),
            lifecycle=FakeLifecycle(),
        )

        raw_body = json.dumps(
            {
                "id": "evt_1",
                "type": "payment.succeeded",
                "occurredAt": clock.now().isoformat(),
                "subscriptionRef": sub.provider_ref,
                "paymentRef": payment.provider_ref,
            }
        )

        r1 = await receive(
            provider=provider,
            headers={"x-sig": "ok"},
            raw_body=raw_body,
            repo=repo,
            clock=clock,
        )
        assert r1.duplicated is False
        await process(
            event_id=r1.event_id,
            providers={"stripe": provider},
            handlers=handlers,
            repo=repo,
            clock=clock,
        )

        bal = await ledger.balance("cust1", "paid", clock.now())
        assert bal.available == 100

        # -- replay the identical event: receive() dedupes; even if process() is invoked again on
        #    the same record, the ledger append is idempotent by key, so the balance does not move. --
        r2 = await receive(
            provider=provider,
            headers={"x-sig": "ok"},
            raw_body=raw_body,
            repo=repo,
            clock=clock,
        )
        assert r2.duplicated is True
        assert r2.event_id == r1.event_id
        await process(
            event_id=r2.event_id,
            providers={"stripe": provider},
            handlers=handlers,
            repo=repo,
            clock=clock,
        )

        bal = await ledger.balance("cust1", "paid", clock.now())
        assert bal.available == 100

    asyncio.run(run())
