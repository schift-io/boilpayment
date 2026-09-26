"""spec: packages/cs/spec/cs.pseudo.md [EC:I9]
Mirrors packages/cs/ts/test/timeline.test.ts (same fixtures, same expected strings).

pytest-asyncio is not installed in this workspace -- every test wraps its async body with
asyncio.run(...) inside a plain `def test_...():`, per packages/cs/py/tests/test_cs.py.

NOTE on clocks: InMemoryLedger.append() stamps `created_at` with the REAL wall clock (ignores the
injected Clock -- see final report finding). To interleave ledger-sourced events correctly with
clock-sourced ones (payments/refunds/cs_cases) in an exact-ordering test, `clock` here is a
FixedClock seeded with `datetime.now(UTC)` (real "now") and advanced in lockstep with a real
`asyncio.sleep()` between narrative steps, instead of a hardcoded past date that would always sort
before real time.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from boilpayment_core import (
    DEFAULT_POLICY,
    CsCase,
    Customer,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    LedgerReference,
    NewLedgerEntry,
    NormalizedEvent,
    Payment,
    Refund,
    SequentialIdGen,
    WebhookEventRecord,
    money,
    resolve_policy,
    run_idempotent,
)
from boilpayment_cs import (
    DisputeInput,
    TimelineOptions,
    dispute,
    explain,
    timeline,
)


def run(coro):
    return asyncio.run(coro)


class _NoopNotifier:
    async def send(self, n) -> None:
        return None


async def _tick(clock: FixedClock, ms: int = 5) -> None:
    # InMemoryLedger now takes the clock, so no real sleep is needed to keep the two in step.
    clock.advance(ms)


def test_happy_path_exact_order_running_balance_and_explain():
    async def go():
        repo = InMemoryRepo()
        clock = FixedClock(datetime.now(UTC))
        ledger = InMemoryLedger(SequentialIdGen("led_"), clock)
        customer_id = "cust_happy"

        payment = Payment(
            id="pay_1",
            customer_id=customer_id,
            provider="toss",
            provider_ref="toss_1",
            subscription_id=None,
            amount=money(9900, "KRW"),
            status="succeeded",
            kind="topup",
            period=None,
            occurred_at=clock.now(),
        )
        await repo.payments.put(payment)
        await _tick(clock)

        granted = await ledger.append(
            NewLedgerEntry(
                customer_id=customer_id,
                pool="paid",
                kind="grant",
                amount=100,
                source="topup",
                reference=LedgerReference(payment_id=payment.id),
                idempotency_key=f"topup:{payment.id}",
                actor="system",
            )
        )
        await _tick(clock)

        await ledger.append(
            NewLedgerEntry(
                customer_id=customer_id,
                pool="paid",
                kind="consume",
                amount=-40,
                source="usage",
                reference=LedgerReference(grant_id=granted.entry.id),
                idempotency_key="consume:1",
                actor="app",
            )
        )
        await _tick(clock)

        refund = Refund(
            id="ref_1",
            payment_id=payment.id,
            customer_id=customer_id,
            amount=money(6000, "KRW"),
            status="succeeded",
            provider_ref="toss_refund_1",
            credits_revoked=60,
            rule_id="D1",
            reason=None,
            failure=None,
            created_at=clock.now(),
        )
        await repo.refunds.put(refund)
        await _tick(clock)

        await ledger.append(
            NewLedgerEntry(
                customer_id=customer_id,
                pool="paid",
                kind="revoke",
                amount=-60,
                source="refund",
                reference=LedgerReference(
                    payment_id=payment.id,
                    refund_id=refund.id,
                    grant_id=granted.entry.id,
                ),
                idempotency_key=f"revoke:refund:{refund.id}",
                actor="system",
            )
        )

        result = await timeline(
            TimelineOptions(
                customer_id=customer_id, repo=repo, ledger=ledger, clock=clock
            )
        )
        assert result.truncated is False
        assert [e.kind for e in result.events] == [
            "payment.succeeded",
            "credits.granted",
            "credits.consumed",
            "refund.succeeded",
            "credits.revoked",
        ]

        ledger_events = [e for e in result.events if e.source == "ledger_entries"]
        assert [e.detail["balance_after"] for e in ledger_events] == [100, 60, 0]

        assert explain(result.events) == [
            "payment pay_1 succeeded (₩9,900)",
            "100 credits granted",
            "40 credits consumed",
            "refund ref_1 for ₩6,000 (D1), 60 credits revoked",
            "60 credits revoked",
            "balance now 0",
        ]

    run(go())


def test_webhook_failure_story_unknown_provider_ref_global_query_only():
    async def go():
        repo = InMemoryRepo()
        clock = FixedClock(datetime.now(UTC))
        ledger = InMemoryLedger(SequentialIdGen("led_"), clock)

        await repo.webhook_events.put(
            WebhookEventRecord(
                id="evt_orphan_1",
                provider="toss",
                type="payment.succeeded",
                status="failed",
                raw_body="{}",
                headers={},
                received_at=clock.now(),
                processed_at=clock.now(),
                error="unknown_provider_ref",
                attempts=1,
            )
        )

        scoped = await timeline(
            TimelineOptions(
                customer_id="someone_else", repo=repo, ledger=ledger, clock=clock
            )
        )
        assert [e for e in scoped.events if e.source == "webhook_events"] == []

        glob = await timeline(TimelineOptions(repo=repo, ledger=ledger, clock=clock))
        assert len(glob.events) == 1
        assert glob.events[0].kind == "webhook.failed"
        assert glob.events[0].source == "webhook_events"
        assert (
            glob.events[0].summary
            == "webhook toss payment.succeeded failed: unknown_provider_ref"
        )

    run(go())


def test_dispute_story_reuses_cs_dispute():
    async def go():
        repo = InMemoryRepo()
        clock = FixedClock(datetime.now(UTC))
        ledger = InMemoryLedger(SequentialIdGen("led_"), clock)
        ids = SequentialIdGen("id_")
        customer_id = "cust_dispute"
        policy = resolve_policy({"dispute": {"on_open": "revoke_disputed_grant"}})

        await repo.customers.put(
            Customer(
                id=customer_id,
                email=None,
                provider_refs=[],
                status="active",
                created_at=clock.now(),
            )
        )
        payment = Payment(
            id="pay_d1",
            customer_id=customer_id,
            provider="stripe",
            provider_ref="pi_d1",
            subscription_id=None,
            amount=money(1000, "USD"),
            status="succeeded",
            kind="topup",
            period=None,
            occurred_at=clock.now(),
        )
        await repo.payments.put(payment)
        await ledger.append(
            NewLedgerEntry(
                customer_id=customer_id,
                pool="paid",
                kind="grant",
                amount=80,
                source="topup",
                reference=LedgerReference(payment_id=payment.id),
                idempotency_key=f"topup:{payment.id}",
                actor="system",
            )
        )
        await _tick(clock)

        open_event = NormalizedEvent(
            id="evt_open",
            provider="stripe",
            type="dispute.opened",
            occurred_at=clock.now(),
            customer_ref=customer_id,
            subscription_ref=None,
            payment_ref=payment.provider_ref,
            amount=None,
            raw={},
        )
        opened = await dispute(
            DisputeInput(
                event=open_event,
                policy=policy,
                ledger=ledger,
                repo=repo,
                notifier=_NoopNotifier(),
                clock=clock,
                ids=ids,
            )
        )
        await _tick(clock, 50)

        close_event = NormalizedEvent(
            id="evt_close",
            provider="stripe",
            type="dispute.closed",
            occurred_at=clock.now(),
            customer_ref=customer_id,
            subscription_ref=None,
            payment_ref=payment.provider_ref,
            amount=None,
            raw={"outcome": "won"},
        )
        await dispute(
            DisputeInput(
                event=close_event,
                policy=policy,
                ledger=ledger,
                repo=repo,
                notifier=_NoopNotifier(),
                clock=clock,
                ids=ids,
            )
        )

        result = await timeline(
            TimelineOptions(
                customer_id=customer_id, repo=repo, ledger=ledger, clock=clock
            )
        )
        kinds = [e.kind for e in result.events]
        assert kinds == [
            "payment.succeeded",
            "credits.granted",
            "case.opened",
            "case.escalated",
            "credits.revoked",
            # dispute() restores the credits and THEN resolves the case, so the restore comes first
            # at that instant (EC:I9 tie-break: credits.* ranks before case.resolved).
            "credits.granted",
            "case.resolved",
        ]
        assert all(
            e.refs.case_id is None or e.refs.case_id == opened.id for e in result.events
        )
        revoke_event = next(e for e in result.events if e.kind == "credits.revoked")
        assert revoke_event.detail["amount"] == -80
        # the restore is the LAST credits.granted, not the last event (case.resolved closes it)
        restore_event = [e for e in result.events if e.kind == "credits.granted"][-1]
        assert result.events[-1].kind == "case.resolved"
        assert restore_event.detail["amount"] == 80
        balance = await ledger.balance(customer_id, "paid", clock.now())
        assert balance.available == 80

    run(go())


def test_replayed_operation_story():
    async def go():
        repo = InMemoryRepo()
        clock = FixedClock(datetime.now(UTC))
        ledger = InMemoryLedger(SequentialIdGen("led_"), clock)
        payment_id = "pay_replay_1"
        executions = 0

        async def _fn():
            nonlocal executions
            executions += 1
            return {"granted": 100}

        async def _call():
            return await run_idempotent(
                repo=repo,
                clock=clock,
                key=f"topup:{payment_id}",
                kind="credits.topup",
                payload={"payment_id": payment_id},
                fn=_fn,
            )

        first = await _call()
        assert first.replayed is False
        second = await _call()
        assert second.replayed is True
        assert (
            executions == 1
        )  # proves the "customer clicked twice" didn't double-execute

        result = await timeline(
            TimelineOptions(
                payment_id=payment_id, repo=repo, ledger=ledger, clock=clock
            )
        )
        op_events = [e for e in result.events if e.kind == "operation.replayed"]
        assert len(op_events) == 1
        assert op_events[0].detail["key"] == f"topup:{payment_id}"
        assert op_events[0].detail["kind"] == "credits.topup"

    run(go())


def test_payment_id_scoped_query_pulls_only_related_rows():
    async def go():
        repo = InMemoryRepo()
        clock = FixedClock(datetime.now(UTC))
        ledger = InMemoryLedger(SequentialIdGen("led_"), clock)

        payment_a = Payment(
            id="pay_A",
            customer_id="cust_A",
            provider="stripe",
            provider_ref="pi_A",
            subscription_id=None,
            amount=money(500, "USD"),
            status="succeeded",
            kind="topup",
            period=None,
            occurred_at=clock.now(),
        )
        payment_b = Payment(
            id="pay_B",
            customer_id="cust_A",
            provider="stripe",
            provider_ref="pi_B",
            subscription_id=None,
            amount=money(700, "USD"),
            status="succeeded",
            kind="topup",
            period=None,
            occurred_at=clock.now(),
        )
        await repo.payments.put(payment_a)
        await repo.payments.put(payment_b)
        await ledger.append(
            NewLedgerEntry(
                customer_id="cust_A",
                pool="paid",
                kind="grant",
                amount=50,
                source="topup",
                reference=LedgerReference(payment_id="pay_A"),
                idempotency_key="topup:pay_A",
                actor="system",
            )
        )
        await ledger.append(
            NewLedgerEntry(
                customer_id="cust_A",
                pool="paid",
                kind="grant",
                amount=70,
                source="topup",
                reference=LedgerReference(payment_id="pay_B"),
                idempotency_key="topup:pay_B",
                actor="system",
            )
        )
        await repo.refunds.put(
            Refund(
                id="ref_A",
                payment_id="pay_A",
                customer_id="cust_A",
                amount=money(500, "USD"),
                status="succeeded",
                provider_ref=None,
                credits_revoked=50,
                rule_id="D1",
                reason=None,
                failure=None,
                created_at=clock.now(),
            )
        )
        await repo.cs_cases.put(
            CsCase(
                id="case_A",
                customer_id="cust_A",
                kind="refund",
                status="resolved_auto",
                reference_id="pay_A",
                policy_snapshot=DEFAULT_POLICY,
                decision={},
                churn_reason=None,
                churn_text=None,
                opened_at=clock.now(),
                resolved_at=clock.now(),
            )
        )

        result = await timeline(
            TimelineOptions(payment_id="pay_A", repo=repo, ledger=ledger, clock=clock)
        )
        assert all(
            e.refs.payment_id is None or e.refs.payment_id == "pay_A"
            for e in result.events
        )
        grant_amounts = [
            e.detail["amount"] for e in result.events if e.kind == "credits.granted"
        ]
        assert grant_amounts == [50]
        assert any(
            e.kind == "refund.succeeded" and e.refs.refund_id == "ref_A"
            for e in result.events
        )
        assert any(
            e.kind == "case.resolved" and e.refs.case_id == "case_A"
            for e in result.events
        )
        assert not any(e.detail.get("amount") == 70 for e in result.events)

    run(go())


def test_truncation_keeps_newest_limit_events():
    async def go():
        repo = InMemoryRepo()
        clock = FixedClock(datetime.now(UTC))
        ledger = InMemoryLedger(SequentialIdGen("led_"), clock)
        customer_id = "cust_trunc"

        for i in range(5):
            await ledger.append(
                NewLedgerEntry(
                    customer_id=customer_id,
                    pool="paid",
                    kind="grant",
                    amount=10,
                    source="manual",
                    reference=LedgerReference(),
                    idempotency_key=f"grant:{i}",
                    actor="system",
                )
            )
            await _tick(clock, 2)

        full = await timeline(
            TimelineOptions(
                customer_id=customer_id, repo=repo, ledger=ledger, clock=clock
            )
        )
        assert full.truncated is False
        assert len(full.events) == 5

        limited = await timeline(
            TimelineOptions(
                customer_id=customer_id, repo=repo, ledger=ledger, clock=clock, limit=2
            )
        )
        assert limited.truncated is True
        assert len(limited.events) == 2
        assert [e.at for e in limited.events] == [e.at for e in full.events[3:]]

    run(go())


def test_ec_l5_correlation_id_returns_exactly_the_events_of_one_delivery():
    async def go():
        repo = InMemoryRepo()
        clock = FixedClock(datetime.now(UTC))
        ledger = InMemoryLedger(SequentialIdGen("led_"), clock)
        customer_id = "cust_l5"

        # Two "deliveries" interleaved on the same customer: corr_a's grant+consume, corr_b's
        # grant, and one entry with NO correlation_id at all (a direct, non-webhook call) -- none
        # of it should leak in.
        await ledger.append(
            NewLedgerEntry(
                customer_id=customer_id,
                pool="paid",
                kind="grant",
                amount=100,
                source="topup",
                reference=LedgerReference(payment_id="pay_a", correlation_id="corr_a"),
                idempotency_key="topup:pay_a",
                actor="system",
            )
        )
        await _tick(clock)
        await ledger.append(
            NewLedgerEntry(
                customer_id=customer_id,
                pool="paid",
                kind="grant",
                amount=50,
                source="topup",
                reference=LedgerReference(payment_id="pay_b", correlation_id="corr_b"),
                idempotency_key="topup:pay_b",
                actor="system",
            )
        )
        await _tick(clock)
        await ledger.append(
            NewLedgerEntry(
                customer_id=customer_id,
                pool="paid",
                kind="consume",
                amount=-20,
                source="usage",
                reference=LedgerReference(correlation_id="corr_a"),
                idempotency_key="consume:corr_a",
                actor="app",
            )
        )
        await _tick(clock)
        await ledger.append(
            NewLedgerEntry(
                customer_id=customer_id,
                pool="paid",
                kind="grant",
                amount=5,
                source="manual",
                reference=LedgerReference(),
                idempotency_key="grant:no_corr",
                actor="system",
            )
        )

        scoped = await timeline(
            TimelineOptions(
                customer_id=customer_id,
                correlation_id="corr_a",
                repo=repo,
                ledger=ledger,
                clock=clock,
            )
        )
        assert len(scoped.events) == 2
        assert all(e.refs.correlation_id == "corr_a" for e in scoped.events)
        assert [e.kind for e in scoped.events] == [
            "credits.granted",
            "credits.consumed",
        ]

        full = await timeline(
            TimelineOptions(
                customer_id=customer_id, repo=repo, ledger=ledger, clock=clock
            )
        )
        assert (
            len(full.events) == 4
        )  # nothing dropped when correlation_id is not passed

    run(go())
