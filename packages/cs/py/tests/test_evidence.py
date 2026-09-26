"""EC:B18 -- chargeback evidence workflow. Mirrors packages/cs/ts/test/evidence.test.ts (same
cases). See docs/EDGE_CASES.md B18, packages/cs/spec/cs.pseudo.md [EC:B18].

pytest-asyncio is not installed in this workspace -- every test wraps its async body with
asyncio.run(...) inside a plain `def test_...():`, per packages/core/py/tests/test_ledger.py.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from boilpayment_core import (
    DEFAULT_POLICY,
    CollectingNotifier,
    Customer,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    LedgerReference,
    Money,
    NewLedgerEntry,
    Payment,
    ProviderRef,
    SequentialIdGen,
    resolve_policy,
)
from boilpayment_cs import (
    ChecklistInput,
    CollectInput,
    DueInput,
    OpenCaseInput,
    SubmitInput,
    open_case,
)
from boilpayment_cs.evidence import checklist, collect, due, submit


def run(coro):
    return asyncio.run(coro)


CUSTOMER_ID = "cust_ev"


def _clock() -> FixedClock:
    return FixedClock(datetime(2026, 1, 1, tzinfo=UTC))


async def _put_customer(repo: InMemoryRepo, clock: FixedClock) -> Customer:
    customer = Customer(
        id=CUSTOMER_ID,
        email=f"{CUSTOMER_ID}@x.com",
        provider_refs=[ProviderRef(provider="stripe", ref="cus_ev")],
        status="active",
        created_at=clock.now(),
    )
    await repo.customers.put(customer)
    return customer


async def _put_payment(
    repo: InMemoryRepo, clock: FixedClock, pid: str = "pay_ev"
) -> Payment:
    payment = Payment(
        id=pid,
        customer_id=CUSTOMER_ID,
        provider="stripe",
        provider_ref=f"pi_{pid}",
        subscription_id=None,
        amount=Money(amount_minor=5000, currency="USD"),
        status="disputed",
        kind="topup",
        period=None,
        occurred_at=clock.now(),
        failure=None,
        cash_receipt=None,
    )
    await repo.payments.put(payment)
    return payment


async def _open_dispute_case(repo, clock, ids, policy=DEFAULT_POLICY):
    await _put_customer(repo, clock)
    return await open_case(
        OpenCaseInput(
            customer_id=CUSTOMER_ID,
            kind="dispute",
            reference_id="pi_ev",
            policy=policy,
            repo=repo,
            clock=clock,
            ids=ids,
        )
    )


# ── checklist ────────────────────────────────────────────────────────────────────────────


def test_b18_checklist_marks_ledger_backed_items_available_and_unknown_unavailable_with_reason():
    async def go():
        clock, ids, repo = _clock(), SequentialIdGen("id_"), InMemoryRepo()
        ledger = InMemoryLedger(ids)
        case = await _open_dispute_case(repo, clock, ids)
        payment = await _put_payment(repo, clock)

        grant_result = await ledger.append(
            NewLedgerEntry(
                customer_id=CUSTOMER_ID,
                pool="paid",
                kind="grant",
                amount=100,
                unit_price_minor=10,
                currency="USD",
                source="topup",
                reference=LedgerReference(payment_id=payment.id),
                idempotency_key=f"topup:{payment.id}",
                actor="system",
            )
        )
        await ledger.append(
            NewLedgerEntry(
                customer_id=CUSTOMER_ID,
                pool="paid",
                kind="consume",
                amount=-30,
                source="usage",
                reference=LedgerReference(grant_id=grant_result.entry.id),
                idempotency_key="consume:1",
                actor="system",
            )
        )

        items = await checklist(
            ChecklistInput(
                case=case,
                payment=payment,
                sub=None,
                repo=repo,
                ledger=ledger,
                policy=DEFAULT_POLICY,
                clock=clock,
            )
        )
        by_key = {i.key: i for i in items}

        assert by_key["payment_record"].available is True
        assert by_key["proof_of_delivery"].available is True
        assert by_key["proof_of_usage"].available is True
        assert by_key["case_trail"].available is True

        assert by_key["customer_acceptance"].available is False
        assert by_key["customer_acceptance"].reason
        assert by_key["usage_events"].available is False
        assert by_key["usage_events"].reason
        assert by_key["refund_communication"].available is False
        assert by_key["refund_communication"].reason

    run(go())


def test_b18_checklist_with_no_payment_record_marks_grant_and_consume_unavailable():
    async def go():
        clock, ids, repo = _clock(), SequentialIdGen("id_"), InMemoryRepo()
        ledger = InMemoryLedger(ids)
        case = await _open_dispute_case(repo, clock, ids)

        items = await checklist(
            ChecklistInput(
                case=case,
                payment=None,
                sub=None,
                repo=repo,
                ledger=ledger,
                policy=DEFAULT_POLICY,
                clock=clock,
            )
        )
        by_key = {i.key: i for i in items}
        assert by_key["payment_record"].available is False
        assert by_key["proof_of_delivery"].available is False
        assert by_key["proof_of_usage"].available is False
        for i in items:
            if not i.available:
                assert i.reason

    run(go())


# ── collect ──────────────────────────────────────────────────────────────────────────────


def test_b18_collect_is_idempotent():
    async def go():
        clock, ids, repo = _clock(), SequentialIdGen("id_"), InMemoryRepo()
        ledger = InMemoryLedger(ids)
        case = await _open_dispute_case(repo, clock, ids)
        payment = await _put_payment(repo, clock)

        first = await collect(
            CollectInput(
                case=case,
                payment=payment,
                sub=None,
                repo=repo,
                ledger=ledger,
                policy=DEFAULT_POLICY,
                clock=clock,
            )
        )
        first_record = first.decision["evidence"]
        assert len(first_record.items) > 0
        assert first_record.due_at
        assert first_record.collected_at

        second = await collect(
            CollectInput(
                case=case,
                payment=payment,
                sub=None,
                repo=repo,
                ledger=ledger,
                policy=DEFAULT_POLICY,
                clock=clock,
            )
        )
        second_record = second.decision["evidence"]
        assert len(second_record.items) == len(first_record.items)

        assert len(await ledger.entries(CUSTOMER_ID)) == 0

    run(go())


# ── submit ───────────────────────────────────────────────────────────────────────────────


class _NoEvidenceSupportProvider:
    pass


class _EvidenceCapableProvider:
    def __init__(self):
        self.calls: list[dict] = []

    async def submit_dispute_evidence(
        self, *, payment_ref: str, case_id: str, evidence
    ):
        self.calls.append({"payment_ref": payment_ref, "case_id": case_id})
        return {"provider_ref": "stripe_evd_1"}


class _ThrowingProvider:
    async def submit_dispute_evidence(
        self, *, payment_ref: str, case_id: str, evidence
    ):
        raise RuntimeError("network down")


def test_b18_submit_against_unsupported_provider_returns_submitted_false_and_escalates():
    async def go():
        clock, ids, repo = _clock(), SequentialIdGen("id_"), InMemoryRepo()
        ledger = InMemoryLedger(ids)
        notifier = CollectingNotifier()
        case = await _open_dispute_case(repo, clock, ids)
        payment = await _put_payment(repo, clock)

        result = await submit(
            SubmitInput(
                case=case,
                payment=payment,
                sub=None,
                provider=_NoEvidenceSupportProvider(),
                repo=repo,
                ledger=ledger,
                policy=DEFAULT_POLICY,
                clock=clock,
                notifier=notifier,
            )
        )
        assert result.submitted is False
        assert result.reason == "provider_unsupported"
        assert result.case.status == "needs_human"
        assert any(n.type == "cs.needs_human" for n in notifier.sent)

    run(go())


def test_b18_submit_against_capable_provider_returns_submitted_true_and_records_provider_ref():
    async def go():
        clock, ids, repo = _clock(), SequentialIdGen("id_"), InMemoryRepo()
        ledger = InMemoryLedger(ids)
        notifier = CollectingNotifier()
        case = await _open_dispute_case(repo, clock, ids)
        payment = await _put_payment(repo, clock)
        provider = _EvidenceCapableProvider()

        result = await submit(
            SubmitInput(
                case=case,
                payment=payment,
                sub=None,
                provider=provider,
                repo=repo,
                ledger=ledger,
                policy=DEFAULT_POLICY,
                clock=clock,
                notifier=notifier,
            )
        )
        assert result.submitted is True
        assert result.provider_ref == "stripe_evd_1"
        assert result.case.decision["evidence"].submitted_at
        assert provider.calls[0]["payment_ref"] == payment.provider_ref

    run(go())


def test_b18_submit_never_pretends_success_when_provider_raises():
    async def go():
        clock, ids, repo = _clock(), SequentialIdGen("id_"), InMemoryRepo()
        ledger = InMemoryLedger(ids)
        notifier = CollectingNotifier()
        case = await _open_dispute_case(repo, clock, ids)
        payment = await _put_payment(repo, clock)

        result = await submit(
            SubmitInput(
                case=case,
                payment=payment,
                sub=None,
                provider=_ThrowingProvider(),
                repo=repo,
                ledger=ledger,
                policy=DEFAULT_POLICY,
                clock=clock,
                notifier=notifier,
            )
        )
        assert result.submitted is False
        assert result.reason == "submit_failed"
        assert result.case.status == "needs_human"

    run(go())


# ── due (cron) ───────────────────────────────────────────────────────────────────────────


def test_b18_due_escalates_only_inside_24h_of_the_deadline():
    async def go():
        clock, ids, repo = _clock(), SequentialIdGen("id_"), InMemoryRepo()
        notifier = CollectingNotifier()
        policy = resolve_policy({"dispute": {"evidence_due_days": 7}})
        case = await _open_dispute_case(repo, clock, ids, policy=policy)

        far = await due(DueInput(repo=repo, clock=clock, notifier=notifier))
        assert far == []
        assert notifier.sent == []

        clock.advance(
            7 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000
        )  # 1h from the 7-day deadline
        inside = await due(DueInput(repo=repo, clock=clock, notifier=notifier))
        assert len(inside) == 1
        assert inside[0].case.id == case.id
        assert inside[0].incomplete is True

    run(go())


def test_b18_due_does_not_escalate_a_case_with_complete_evidence():
    async def go():
        clock, ids, repo = _clock(), SequentialIdGen("id_"), InMemoryRepo()
        ledger = InMemoryLedger(ids)
        notifier = CollectingNotifier()
        policy = resolve_policy({"dispute": {"evidence_due_days": 7}})
        case = await _open_dispute_case(repo, clock, ids, policy=policy)
        payment = await _put_payment(repo, clock)

        items = await checklist(
            ChecklistInput(
                case=case,
                payment=payment,
                sub=None,
                repo=repo,
                ledger=ledger,
                policy=policy,
                clock=clock,
            )
        )
        for item in items:
            item.available = True
        from boilpayment_cs.evidence import EvidenceRecord, evidence_due_at

        case.decision = {
            "evidence": EvidenceRecord(
                items=items,
                due_at=evidence_due_at(case).isoformat(),
                collected_at=clock.now().isoformat(),
            )
        }
        await repo.cs_cases.put(case)

        clock.advance(7 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000)
        result = await due(DueInput(repo=repo, clock=clock, notifier=notifier))
        assert result == []

    run(go())
