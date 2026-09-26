"""Phase 6 regression test -- examples/e2e/FINDINGS.md #4 (read-only flag, RESOLVED):
default_handlers' one-time top-up branch (on_payment_succeeded, no subscription_ref) now
REQUIRES resolve_topup_credits(payment) to resolve a credits amount. Unresolved -> the
webhook record fails with error 'topup_credits_unresolved' instead of a null-amount
ledger entry. See packages/webhook/py/src/boilpayment_webhook/handlers.py."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime

from _helpers import FakeProvider, json_verify
from boilpayment_core import (
    DEFAULT_POLICY,
    CollectingNotifier,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    Money,
    Payment,
    SequentialIdGen,
    run_idempotent,
)
from boilpayment_webhook import default_handlers, process, receive


def _make_topup_payment(clock, **overrides):
    base = {
        "id": "pay_topup",
        "customer_id": "cust_1",
        "provider": "stripe",
        "provider_ref": "pi_topup",
        "subscription_id": None,
        "amount": Money(amount_minor=999, currency="USD"),
        "status": "succeeded",
        "kind": "topup",
        "period": None,
        "occurred_at": clock.now(),
        "failure": None,
    }
    base.update(overrides)
    return Payment(**base)


def test_ec_topup_fails_with_topup_credits_unresolved_when_resolver_cannot_resolve():
    async def run():
        clock = FixedClock(datetime(2026, 2, 2, tzinfo=UTC))
        repo = InMemoryRepo()
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        notifier = CollectingNotifier()
        payment = _make_topup_payment(clock)
        await repo.payments.put(payment)

        provider = FakeProvider(
            verify=json_verify(), get_payment_impl=lambda ref: payment
        )

        credits_calls = []

        class FakeCredits:
            async def topup(self, **kwargs):
                credits_calls.append(kwargs)

        async def resolve_topup_credits(payment):
            return None

        handlers = default_handlers(
            policy=DEFAULT_POLICY,
            ledger=ledger,
            repo=repo,
            notifier=notifier,
            clock=clock,
            ids=SequentialIdGen("id_"),
            credits=FakeCredits(),
            resolve_topup_credits=resolve_topup_credits,
        )

        raw_body = json.dumps(
            {
                "id": "evt_topup_unresolved",
                "type": "payment.succeeded",
                "occurredAt": clock.now().isoformat(),
                "paymentRef": payment.provider_ref,
            }
        )
        r = await receive(
            provider=provider,
            headers={"x-sig": "ok"},
            raw_body=raw_body,
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

        record = await repo.webhook_events.get(r.event_id)
        assert record.status == "failed"
        assert record.error == "topup_credits_unresolved"
        assert credits_calls == []

    asyncio.run(run())


def test_ec_topup_succeeds_and_calls_credits_topup_with_resolved_amount():
    async def run():
        clock = FixedClock(datetime(2026, 2, 2, tzinfo=UTC))
        repo = InMemoryRepo()
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        notifier = CollectingNotifier()
        payment = _make_topup_payment(clock, id="pay_topup2", provider_ref="pi_topup2")
        await repo.payments.put(payment)

        provider = FakeProvider(
            verify=json_verify(), get_payment_impl=lambda ref: payment
        )

        credits_calls = []

        class FakeCredits:
            async def topup(
                self, *, customer_id, payment, credits, policy, ledger, clock, repo
            ):
                credits_calls.append({"customer_id": customer_id, "credits": credits})

        async def resolve_topup_credits(p):
            return 250 if p.id == payment.id else None

        handlers = default_handlers(
            policy=DEFAULT_POLICY,
            ledger=ledger,
            repo=repo,
            notifier=notifier,
            clock=clock,
            ids=SequentialIdGen("id_"),
            credits=FakeCredits(),
            resolve_topup_credits=resolve_topup_credits,
        )

        raw_body = json.dumps(
            {
                "id": "evt_topup_resolved",
                "type": "payment.succeeded",
                "occurredAt": clock.now().isoformat(),
                "paymentRef": payment.provider_ref,
            }
        )
        r = await receive(
            provider=provider,
            headers={"x-sig": "ok"},
            raw_body=raw_body,
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

        record = await repo.webhook_events.get(r.event_id)
        assert record.status == "processed"
        assert record.error is None
        assert len(credits_calls) == 1
        assert credits_calls[0]["credits"] == 250
        assert credits_calls[0]["customer_id"] == payment.customer_id

    asyncio.run(run())


def test_ec_k1_b10_repo_threading_replayed_payment_succeeded_grants_once():
    async def run():
        clock = FixedClock(datetime(2026, 2, 2, tzinfo=UTC))
        repo = InMemoryRepo()
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        notifier = CollectingNotifier()
        payment = _make_topup_payment(clock, id="pay_topup3", provider_ref="pi_topup3")
        await repo.payments.put(payment)

        provider = FakeProvider(
            verify=json_verify(), get_payment_impl=lambda ref: payment
        )

        grant_count = 0

        # Mirrors how the real credits.topup() uses run_idempotent, keyed the same way
        # (topup:{payment.id}) -- this only proves anything if `repo` actually reaches this call
        # site, which is exactly the gap CreditsDeps.topup previously had (no `repo` kwarg, so a
        # webhook-triggered top-up could only be deduped by the ledger's idempotency_key UNIQUE
        # constraint, not by the operation-level in-progress/replay guarantees of J1-J3).
        class FakeCredits:
            async def topup(
                self, *, customer_id, payment, credits, policy, ledger, clock, repo
            ):
                nonlocal grant_count

                async def _fn():
                    nonlocal grant_count
                    grant_count += 1
                    return {"granted": credits}

                result = await run_idempotent(
                    repo=repo,
                    clock=clock,
                    key=f"topup:{payment.id}",
                    kind="credits.topup",
                    payload={"paymentId": payment.id, "credits": credits},
                    fn=_fn,
                )
                return result.result

        async def resolve_topup_credits(p):
            return 250 if p.id == payment.id else None

        handlers = default_handlers(
            policy=DEFAULT_POLICY,
            ledger=ledger,
            repo=repo,
            notifier=notifier,
            clock=clock,
            ids=SequentialIdGen("id_"),
            credits=FakeCredits(),
            resolve_topup_credits=resolve_topup_credits,
        )

        # Two separate webhook deliveries (different provider event ids) for the SAME underlying
        # payment -- simulates the provider redelivering payment.succeeded.
        raw_body_1 = json.dumps(
            {
                "id": "evt_topup_redelivery_1",
                "type": "payment.succeeded",
                "occurredAt": clock.now().isoformat(),
                "paymentRef": payment.provider_ref,
            }
        )
        r1 = await receive(
            provider=provider,
            headers={"x-sig": "ok"},
            raw_body=raw_body_1,
            repo=repo,
            clock=clock,
        )
        await process(
            event_id=r1.event_id,
            providers={"stripe": provider},
            handlers=handlers,
            repo=repo,
            clock=clock,
        )

        raw_body_2 = json.dumps(
            {
                "id": "evt_topup_redelivery_2",
                "type": "payment.succeeded",
                "occurredAt": clock.now().isoformat(),
                "paymentRef": payment.provider_ref,
            }
        )
        r2 = await receive(
            provider=provider,
            headers={"x-sig": "ok"},
            raw_body=raw_body_2,
            repo=repo,
            clock=clock,
        )
        await process(
            event_id=r2.event_id,
            providers={"stripe": provider},
            handlers=handlers,
            repo=repo,
            clock=clock,
        )

        assert (
            grant_count == 1
        )  # the grant only actually ran once, across two webhook deliveries
        op = await repo.operations.get(f"topup:{payment.id}")
        assert op.status == "done"

    asyncio.run(run())
