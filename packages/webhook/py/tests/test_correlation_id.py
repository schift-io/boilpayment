"""[EC:L5] correlation_id propagation -- follows ONE id from receive() (where it's minted)
through process() (where it's read back off the record and threaded into HandlerCtx) into a
ledger entry's `reference.correlation_id` (via handlers.py wrapping the `ledger` dep, transparent
to lifecycle) and into every `webhook.*` audit log line for the delivery (via CollectingLogger --
PostgresLogger promoting `fields["correlationId"]` to the `audit_log.correlation_id` column is
already proven separately in packages/schema-postgres, see spec/schema-postgres.pseudo.md
[EC:L1-L5] "Smoke-tested 2026-09-09").
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime

from _helpers import FakeProvider, json_verify
from boilpayment_core import (
    DEFAULT_POLICY,
    CollectingLogger,
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
from boilpayment_webhook import (
    default_handlers,
    mint_correlation_id,
    process,
    receive,
)


def test_correlation_id_flows_from_receive_through_process_into_ledger_entry_and_audit_log():
    async def run():
        clock = FixedClock(datetime(2026, 1, 1, tzinfo=UTC))
        repo = InMemoryRepo()
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        logger = CollectingLogger()

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

        class FakeDunning:
            async def on_payment_failed(self, **kwargs):
                return None

        class FakeLifecycle:
            dunning = FakeDunning()

            # `ledger` here is handlers.py's correlation-id-wrapping decorator, not the raw
            # InMemoryLedger -- this fake has no idea correlation_id exists, exactly like a real
            # lifecycle.on_renewal_paid wouldn't.
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
            notifier=None,
            clock=clock,
            ids=SequentialIdGen("id_"),
            lifecycle=FakeLifecycle(),
        )

        raw_body = json.dumps(
            {
                "id": "evt_corr_1",
                "type": "payment.succeeded",
                "occurredAt": clock.now().isoformat(),
                "subscriptionRef": sub.provider_ref,
                "paymentRef": payment.provider_ref,
            }
        )

        expected_correlation_id = mint_correlation_id("evt_corr_1")

        r1 = await receive(
            provider=provider,
            headers={"x-sig": "ok"},
            raw_body=raw_body,
            repo=repo,
            clock=clock,
            logger=logger,
        )
        assert r1.event_id == "evt_corr_1"

        # 1) minted at receive() and persisted on the WebhookEventRecord
        record = await repo.webhook_events.get("evt_corr_1")
        assert record.correlation_id == expected_correlation_id

        # 2) the receive() log line carries it
        received_log = next(
            e for e in logger.entries if e["event"] == "webhook.received"
        )
        assert received_log["correlationId"] == expected_correlation_id

        await process(
            event_id=r1.event_id,
            providers={"stripe": provider},
            handlers=handlers,
            repo=repo,
            clock=clock,
            logger=logger,
        )

        # 3) both process() log lines carry the SAME id
        processing_log = next(
            e for e in logger.entries if e["event"] == "webhook.processing"
        )
        processed_log = next(
            e for e in logger.entries if e["event"] == "webhook.processed"
        )
        assert processing_log["correlationId"] == expected_correlation_id
        assert processed_log["correlationId"] == expected_correlation_id

        # 4) the ledger entry lifecycle.on_renewal_paid wrote carries it too -- end to end.
        entries = await ledger.entries("cust1")
        grant = next(e for e in entries if e.idempotency_key == "renewal:pay1")
        assert grant.reference.correlation_id == expected_correlation_id

    asyncio.run(run())
