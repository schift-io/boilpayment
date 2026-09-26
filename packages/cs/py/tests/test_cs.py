"""Phase 6 regression tests -- packages/cs (Python). Real code paths against the core in-memory
doubles; PaymentProvider and http_call are faked. Mirrors packages/cs/ts/test/cs.test.ts (same
cases). See docs/EDGE_CASES.md I1-I8/A18/E1/E2/E14/B11/D9, packages/cs/spec/cs.pseudo.md.

pytest-asyncio is not installed in this workspace -- every test wraps its async body with
asyncio.run(...) inside a plain `def test_...():`, per packages/core/py/tests/test_ledger.py.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

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
    NormalizedEvent,
    Payment,
    ProviderRef,
    SequentialIdGen,
    resolve_policy,
)
from boilpayment_cs import (
    CaseMeter,
    CaseReportInput,
    DisputeInput,
    EscalateInput,
    HttpLicenseReporter,
    OpenCaseInput,
    ReconcileInput,
    RegrantInput,
    RegrantPlan,
    RejectInput,
    ResolveInput,
    churn,
    escalate,
    open_case,
    reconcile,
    regrant,
    reject,
    resolve,
    widget,
)
from boilpayment_cs import (
    dispute as cs_dispute,
)
from boilpayment_cs.metrics import Metrics


def run(coro):
    return asyncio.run(coro)


CUSTOMER_ID = "cust_1"


def _clock() -> FixedClock:
    return FixedClock(datetime(2026, 1, 1, tzinfo=UTC))


async def _put_customer(
    repo: InMemoryRepo,
    clock: FixedClock,
    cid: str = CUSTOMER_ID,
    status: str = "active",
) -> Customer:
    customer = Customer(
        id=cid,
        email=f"{cid}@x.com",
        provider_refs=[ProviderRef(provider="stripe", ref=f"cus_{cid}")],
        status=status,
        created_at=clock.now(),
    )
    await repo.customers.put(customer)
    return customer


# ── EC:I7 EC:I8 openCase ──────────────────────────────────────────────────────────────────────


def test_i7_dedupes_active_case_for_same_customer_kind_reference_id():
    async def go():
        clock, ids, repo = _clock(), SequentialIdGen("id_"), InMemoryRepo()
        policy = DEFAULT_POLICY
        first = await open_case(
            OpenCaseInput(
                customer_id=CUSTOMER_ID,
                kind="refund",
                reference_id="ref_1",
                policy=policy,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )
        second = await open_case(
            OpenCaseInput(
                customer_id=CUSTOMER_ID,
                kind="refund",
                reference_id="ref_1",
                policy=policy,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )
        assert second.id == first.id
        rows = await repo.cs_cases.list(
            customer_id=CUSTOMER_ID, kind="refund", reference_id="ref_1"
        )
        assert len(rows) == 1

    run(go())


def test_i7_opens_a_new_case_once_the_prior_one_left_active_statuses():
    async def go():
        clock, ids, repo = _clock(), SequentialIdGen("id_"), InMemoryRepo()
        policy = DEFAULT_POLICY
        first = await open_case(
            OpenCaseInput(
                customer_id=CUSTOMER_ID,
                kind="refund",
                reference_id="ref_2",
                policy=policy,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )
        await resolve(
            ResolveInput(case=first, by="auto", decision={}, repo=repo, clock=clock)
        )
        second = await open_case(
            OpenCaseInput(
                customer_id=CUSTOMER_ID,
                kind="refund",
                reference_id="ref_2",
                policy=policy,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )
        assert second.id != first.id

    run(go())


def test_i8_policy_snapshot_at_open_time_is_unaffected_by_a_later_different_policy_object():
    async def go():
        clock, ids, repo = _clock(), SequentialIdGen("id_"), InMemoryRepo()
        ledger = InMemoryLedger(ids)

        policy_at_open = resolve_policy({"cs": {"regrant": {"mode": "auto"}}})
        cs_case = await open_case(
            OpenCaseInput(
                customer_id=CUSTOMER_ID,
                kind="regrant",
                reference_id="topup:pay_1",
                policy=policy_at_open,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )
        assert cs_case.policy_snapshot.cs.regrant.mode == "auto"

        policy_at_open.cs.regrant.mode = "off"
        # The stored rules continue to govern this case after configuration changes.
        policy_later = resolve_policy({"cs": {"regrant": {"mode": "off"}}})
        result = await regrant(
            RegrantInput(
                case=cs_case,
                ledger=ledger,
                repo=repo,
                policy=policy_later,
                clock=clock,
                ids=ids,
                plan=RegrantPlan(pool="paid", amount=10),
            )
        )

        assert result.status == "resolved_auto"  # follows the case policy snapshot
        assert (
            cs_case.policy_snapshot.cs.regrant.mode == "auto"
        )  # snapshot from open-time untouched

    run(go())


# ── EC:I3 escalate ────────────────────────────────────────────────────────────────────────────


def test_i3_escalate_sets_needs_human_and_notifies_cs_needs_human():
    async def go():
        clock, ids, repo = _clock(), SequentialIdGen("id_"), InMemoryRepo()
        notifier = CollectingNotifier()
        policy = DEFAULT_POLICY

        cs_case = await open_case(
            OpenCaseInput(
                customer_id=CUSTOMER_ID,
                kind="dispute",
                reference_id="evt_1",
                policy=policy,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )
        escalated = await escalate(
            EscalateInput(
                case=cs_case,
                repo=repo,
                clock=clock,
                reason="manual review needed",
                notifier=notifier,
            )
        )

        assert escalated.status == "needs_human"
        assert escalated.decision["escalateReason"] == "manual review needed"
        assert len(notifier.sent) == 1
        assert notifier.sent[0].type == "cs.needs_human"
        assert notifier.sent[0].customer_id == CUSTOMER_ID
        assert notifier.sent[0].payload == {
            "caseId": cs_case.id,
            "kind": "dispute",
            "reason": "manual review needed",
        }

    run(go())


# ── EC:I4 churn.record ────────────────────────────────────────────────────────────────────────


def test_i4_churn_record_persists_reason_and_text_onto_the_given_case():
    async def go():
        clock, ids, repo = _clock(), SequentialIdGen("id_"), InMemoryRepo()
        policy = DEFAULT_POLICY
        cs_case = await open_case(
            OpenCaseInput(
                customer_id=CUSTOMER_ID,
                kind="refund",
                reference_id="churn_ref",
                policy=policy,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )

        record = await churn.record(
            churn.ChurnRecordInput(
                customer_id=CUSTOMER_ID,
                reason="not_using",
                text="switched to a competitor",
                case=cs_case,
                repo=repo,
                clock=clock,
            )
        )

        assert record.reason == "not_using"
        assert record.text == "switched to a competitor"
        reread = await repo.cs_cases.get(cs_case.id)
        assert reread.churn_reason == "not_using"
        assert reread.churn_text == "switched to a competitor"

    run(go())


def test_i4_bare_customer_id_only_call_returns_record_without_persisting():
    async def go():
        clock = _clock()
        record = await churn.record(
            churn.ChurnRecordInput(
                customer_id="cust_2", reason="too_expensive", clock=clock
            )
        )
        assert record.customer_id == "cust_2"
        assert record.reason == "too_expensive"
        assert record.text is None
        assert record.recorded_at == clock.now()

    run(go())


# ── EC:A18 EC:E1 EC:E2 EC:E14 regrant ─────────────────────────────────────────────────────────


def test_a18_mode_auto_grants_credits_and_resolves_auto():
    async def go():
        clock, ids, repo = _clock(), SequentialIdGen("id_"), InMemoryRepo()
        ledger = InMemoryLedger(ids)
        policy = DEFAULT_POLICY
        cs_case = await open_case(
            OpenCaseInput(
                customer_id=CUSTOMER_ID,
                kind="regrant",
                reference_id="topup:pay_x",
                policy=policy,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )

        resolved = await regrant(
            RegrantInput(
                case=cs_case,
                ledger=ledger,
                repo=repo,
                policy=policy,
                clock=clock,
                ids=ids,
                plan=RegrantPlan(pool="paid", amount=50, reason="reconcile regrant"),
            )
        )

        assert resolved.status == "resolved_auto"
        assert resolved.decision["granted"] is True
        assert (
            resolved.decision["idempotencyKey"] == "topup:pay_x"
        )  # defaults to case.reference_id
        assert (await ledger.balance(CUSTOMER_ID, "paid", clock.now())).available == 50

    run(go())


def test_e2_e14_j1_duplicate_regrant_with_same_idempotency_key_is_a_noop_but_still_resolves():
    async def go():
        clock, ids, repo = _clock(), SequentialIdGen("id_"), InMemoryRepo()
        ledger = InMemoryLedger(ids)
        policy = DEFAULT_POLICY
        cs_case = await open_case(
            OpenCaseInput(
                customer_id=CUSTOMER_ID,
                kind="regrant",
                reference_id="topup:pay_y",
                policy=policy,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )

        first = await regrant(
            RegrantInput(
                case=cs_case,
                ledger=ledger,
                repo=repo,
                policy=policy,
                clock=clock,
                ids=ids,
                plan=RegrantPlan(pool="paid", amount=50),
            )
        )
        assert first.decision["granted"] is True

        # Simulates a late-arriving duplicate webhook re-driving the same case/plan. EC:J1 --
        # regrant() is wrapped in run_idempotent keyed by the same idempotency key used for the
        # ledger append, so the second call never reaches the ledger at all: it replays the first
        # call's CsCase/decision verbatim.
        second = await regrant(
            RegrantInput(
                case=first,
                ledger=ledger,
                repo=repo,
                policy=policy,
                clock=clock,
                ids=ids,
                plan=RegrantPlan(pool="paid", amount=50),
            )
        )
        assert (
            second.decision["granted"] is True
        )  # replayed first decision, not a fresh (deduped) append
        assert second.status == "resolved_auto"
        assert (
            await ledger.balance(CUSTOMER_ID, "paid", clock.now())
        ).available == 50  # not double-granted

    run(go())


def test_a18_manual_approve_without_approved_by_escalates_without_granting():
    async def go():
        clock, ids, repo = _clock(), SequentialIdGen("id_"), InMemoryRepo()
        ledger = InMemoryLedger(ids)
        policy = resolve_policy({"cs": {"regrant": {"mode": "manual_approve"}}})
        cs_case = await open_case(
            OpenCaseInput(
                customer_id=CUSTOMER_ID,
                kind="regrant",
                reference_id="topup:pay_z",
                policy=policy,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )

        result = await regrant(
            RegrantInput(
                case=cs_case,
                ledger=ledger,
                repo=repo,
                policy=policy,
                clock=clock,
                ids=ids,
                plan=RegrantPlan(pool="paid", amount=50),
            )
        )

        assert result.status == "needs_human"
        assert (await ledger.balance(CUSTOMER_ID, "paid", clock.now())).available == 0

    run(go())


def test_a18_manual_approve_with_approved_by_grants_and_resolves_auto():
    async def go():
        clock, ids, repo = _clock(), SequentialIdGen("id_"), InMemoryRepo()
        ledger = InMemoryLedger(ids)
        policy = resolve_policy({"cs": {"regrant": {"mode": "manual_approve"}}})
        cs_case = await open_case(
            OpenCaseInput(
                customer_id=CUSTOMER_ID,
                kind="regrant",
                reference_id="topup:pay_w",
                policy=policy,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )

        result = await regrant(
            RegrantInput(
                case=cs_case,
                ledger=ledger,
                repo=repo,
                policy=policy,
                clock=clock,
                ids=ids,
                plan=RegrantPlan(pool="paid", amount=50),
                approved_by="agent_42",
            )
        )

        assert result.status == "resolved_auto"
        assert result.decision["approvedBy"] == "agent_42"

    run(go())


def test_a18_off_mode_rejects_without_granting():
    async def go():
        clock, ids, repo = _clock(), SequentialIdGen("id_"), InMemoryRepo()
        ledger = InMemoryLedger(ids)
        policy = resolve_policy({"cs": {"regrant": {"mode": "off"}}})
        cs_case = await open_case(
            OpenCaseInput(
                customer_id=CUSTOMER_ID,
                kind="regrant",
                reference_id="topup:pay_v",
                policy=policy,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )

        result = await regrant(
            RegrantInput(
                case=cs_case,
                ledger=ledger,
                repo=repo,
                policy=policy,
                clock=clock,
                ids=ids,
                plan=RegrantPlan(pool="paid", amount=50),
            )
        )

        assert result.status == "rejected"
        assert result.decision == {"reason": "cs.regrant.mode=off"}
        assert (await ledger.balance(CUSTOMER_ID, "paid", clock.now())).available == 0

    run(go())


def test_e14_explicit_plan_idempotency_key_overrides_case_reference_id():
    async def go():
        clock, ids, repo = _clock(), SequentialIdGen("id_"), InMemoryRepo()
        ledger = InMemoryLedger(ids)
        policy = DEFAULT_POLICY
        cs_case = await open_case(
            OpenCaseInput(
                customer_id=CUSTOMER_ID,
                kind="regrant",
                reference_id="topup:pay_u",
                policy=policy,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )

        result = await regrant(
            RegrantInput(
                case=cs_case,
                ledger=ledger,
                repo=repo,
                policy=policy,
                clock=clock,
                ids=ids,
                plan=RegrantPlan(
                    pool="paid", amount=50, idempotency_key="custom_key_1"
                ),
            )
        )

        assert result.decision["idempotencyKey"] == "custom_key_1"
        entries = await ledger.entries(CUSTOMER_ID, kind="grant")
        assert entries[0].idempotency_key == "custom_key_1"

    run(go())


# ── EC:E1 EC:E14 reconcile ────────────────────────────────────────────────────────────────────


class FakeProvider:
    """Implements every PaymentProvider method; anything not exercised by reconcile raises."""

    name = "stripe"

    def __init__(self, payments: list[Payment]) -> None:
        self._payments = payments

    def capabilities(self):
        return {
            "native_subscriptions": True,
            "partial_refund": True,
            "meters": False,
            "scheduling": "provider",
            "webhook_signature": True,
        }

    async def create_customer(self, *, email, name=None, metadata=None):
        raise NotImplementedError("unused: create_customer")

    async def create_checkout(self, input):
        raise NotImplementedError("unused: create_checkout")

    async def get_payment(self, provider_ref):
        raise NotImplementedError("unused: get_payment")

    async def list_payments(self, *, customer_ref, since):
        return self._payments

    async def get_subscription(self, provider_ref):
        raise NotImplementedError("unused: get_subscription")

    async def change_subscription(
        self, provider_ref, *, new_price_ref, proration, reset_anchor
    ):
        raise NotImplementedError("unused: change_subscription")

    async def cancel_subscription(self, provider_ref, *, at_period_end):
        raise NotImplementedError("unused: cancel_subscription")

    async def charge_billing_key(
        self, *, billing_key, amount, order_id, customer_ref, idempotency_key
    ):
        raise NotImplementedError("unused: charge_billing_key")

    async def refund(self, *, payment_ref, amount, reason, idempotency_key, extra=None):
        raise NotImplementedError("unused: refund")

    async def report_usage(
        self, *, meter, customer_ref, quantity, occurred_at, idempotency_key
    ):
        raise NotImplementedError("unused: report_usage")

    async def verify_webhook(self, *, headers, raw_body):
        raise NotImplementedError("unused: verify_webhook")


def test_e1_e14_flags_unmatched_topup_then_second_pass_is_noop_after_regrant():
    async def go():
        clock, ids, repo = _clock(), SequentialIdGen("id_"), InMemoryRepo()
        ledger = InMemoryLedger(ids)
        policy = DEFAULT_POLICY
        await _put_customer(repo, clock)

        topup = Payment(
            id="pay_topup",
            customer_id=CUSTOMER_ID,
            provider="stripe",
            provider_ref="pi_topup",
            subscription_id=None,
            amount=Money(amount_minor=500, currency="USD"),
            status="succeeded",
            kind="topup",
            period=None,
            occurred_at=clock.now(),
            failure=None,
        )
        provider = FakeProvider([topup])
        since = datetime(2025, 1, 1, tzinfo=UTC)

        first_pass = await reconcile(
            ReconcileInput(
                providers={"stripe": provider},
                ledger=ledger,
                repo=repo,
                policy=policy,
                clock=clock,
                ids=ids,
                since=since,
            )
        )
        assert len(first_pass) == 1
        assert first_pass[0].kind == "regrant"
        assert first_pass[0].reference_id == f"topup:{topup.id}"

        await regrant(
            RegrantInput(
                case=first_pass[0],
                ledger=ledger,
                repo=repo,
                policy=policy,
                clock=clock,
                ids=ids,
                plan=RegrantPlan(pool="paid", amount=50),
            )
        )

        second_pass = await reconcile(
            ReconcileInput(
                providers={"stripe": provider},
                ledger=ledger,
                repo=repo,
                policy=policy,
                clock=clock,
                ids=ids,
                since=since,
            )
        )
        assert len(second_pass) == 0

    run(go())


def test_e1_subscription_payment_grant_key_pattern():
    async def go():
        clock, ids, repo = _clock(), SequentialIdGen("id_"), InMemoryRepo()
        ledger = InMemoryLedger(ids)
        policy = DEFAULT_POLICY
        await _put_customer(repo, clock)
        period_start = datetime(2026, 1, 1, tzinfo=UTC)

        sub_payment = Payment(
            id="pay_sub_1",
            customer_id=CUSTOMER_ID,
            provider="stripe",
            provider_ref="pi_sub_1",
            subscription_id="sub_1",
            amount=Money(amount_minor=2000, currency="USD"),
            status="succeeded",
            kind="subscription",
            period=None,
            occurred_at=period_start,
            failure=None,
        )
        # supply a real Period via dataclasses to keep grant_key derivation exercised
        from boilpayment_core import Period

        sub_payment = Payment(
            id="pay_sub_1",
            customer_id=CUSTOMER_ID,
            provider="stripe",
            provider_ref="pi_sub_1",
            subscription_id="sub_1",
            amount=Money(amount_minor=2000, currency="USD"),
            status="succeeded",
            kind="subscription",
            period=Period(start=period_start, end=datetime(2026, 2, 1, tzinfo=UTC)),
            occurred_at=period_start,
            failure=None,
        )
        provider = FakeProvider([sub_payment])

        cases = await reconcile(
            ReconcileInput(
                providers={"stripe": provider},
                ledger=ledger,
                repo=repo,
                policy=policy,
                clock=clock,
                ids=ids,
                since=datetime(2025, 1, 1, tzinfo=UTC),
            )
        )
        assert len(cases) == 1
        assert cases[0].reference_id == f"grant:sub_1:{period_start.isoformat()}"

    run(go())


# ── EC:B11 EC:D9 dispute ──────────────────────────────────────────────────────────────────────


def test_b11_dispute_opened_freeze_customer_default_policy_escalates():
    async def go():
        clock, ids, repo = _clock(), SequentialIdGen("id_"), InMemoryRepo()
        ledger = InMemoryLedger(ids)
        notifier = CollectingNotifier()
        policy = DEFAULT_POLICY
        await _put_customer(repo, clock)

        event = NormalizedEvent(
            id="evt_dispute_1",
            provider="stripe",
            type="dispute.opened",
            occurred_at=clock.now(),
            customer_ref=CUSTOMER_ID,
            subscription_ref=None,
            payment_ref=None,
            amount=None,
            raw={},
        )
        cs_case = await cs_dispute(
            DisputeInput(
                event=event,
                policy=policy,
                ledger=ledger,
                repo=repo,
                notifier=notifier,
                clock=clock,
                ids=ids,
            )
        )

        assert cs_case.status == "needs_human"
        customer = await repo.customers.get(CUSTOMER_ID)
        assert customer.status == "frozen"
        assert any(n.type == "cs.needs_human" for n in notifier.sent)

    run(go())


def test_b11_revoke_disputed_grant_revokes_the_full_grant_tied_to_the_payment():
    async def go():
        clock, ids, repo = _clock(), SequentialIdGen("id_"), InMemoryRepo()
        ledger = InMemoryLedger(ids)
        notifier = CollectingNotifier()
        policy = resolve_policy({"dispute": {"on_open": "revoke_disputed_grant"}})
        await _put_customer(repo, clock)

        payment = Payment(
            id="pay_disputed",
            customer_id=CUSTOMER_ID,
            provider="stripe",
            provider_ref="pi_disputed",
            subscription_id=None,
            amount=Money(amount_minor=1000, currency="USD"),
            status="succeeded",
            kind="topup",
            period=None,
            occurred_at=clock.now(),
            failure=None,
        )
        await repo.payments.put(payment)
        await ledger.append(
            NewLedgerEntry(
                customer_id=CUSTOMER_ID,
                pool="paid",
                kind="grant",
                amount=80,
                unit_price_minor=10,
                currency="USD",
                source="topup",
                reference=LedgerReference(payment_id=payment.id),
                idempotency_key=f"topup:{payment.id}",
                actor="system",
            )
        )

        event = NormalizedEvent(
            id="evt_dispute_2",
            provider="stripe",
            type="dispute.opened",
            occurred_at=clock.now(),
            customer_ref=CUSTOMER_ID,
            subscription_ref=None,
            payment_ref=payment.provider_ref,
            amount=None,
            raw={},
        )
        cs_case = await cs_dispute(
            DisputeInput(
                event=event,
                policy=policy,
                ledger=ledger,
                repo=repo,
                notifier=notifier,
                clock=clock,
                ids=ids,
            )
        )

        assert (await ledger.balance(CUSTOMER_ID, "paid", clock.now())).available == 0
        revoke_entries = await ledger.entries(CUSTOMER_ID, kind="revoke")
        # EC:B11 -- attributed per grant bucket (reference.grant_id), like refund.execute, so expiry
        # (B14) and a later D9 restore can see which bucket each unit came from.
        assert len(revoke_entries) == 1
        assert revoke_entries[0].reference.grant_id is not None
        assert (
            revoke_entries[0].idempotency_key
            == f"revoke:dispute:{cs_case.id}:{revoke_entries[0].reference.grant_id}"
        )
        assert sum(-e.amount for e in revoke_entries) == 80
        assert (
            await repo.customers.get(CUSTOMER_ID)
        ).status == "active"  # freeze_customer branch not taken

    run(go())


def test_b11_on_open_none_has_no_side_effect():
    async def go():
        clock, ids, repo = _clock(), SequentialIdGen("id_"), InMemoryRepo()
        ledger = InMemoryLedger(ids)
        notifier = CollectingNotifier()
        policy = resolve_policy({"dispute": {"on_open": "none"}})
        await _put_customer(repo, clock)

        payment = Payment(
            id="pay_none",
            customer_id=CUSTOMER_ID,
            provider="stripe",
            provider_ref="pi_none",
            subscription_id=None,
            amount=Money(amount_minor=1000, currency="USD"),
            status="succeeded",
            kind="topup",
            period=None,
            occurred_at=clock.now(),
            failure=None,
        )
        await repo.payments.put(payment)
        await ledger.append(
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

        event = NormalizedEvent(
            id="evt_dispute_none",
            provider="stripe",
            type="dispute.opened",
            occurred_at=clock.now(),
            customer_ref=CUSTOMER_ID,
            subscription_ref=None,
            payment_ref=payment.provider_ref,
            amount=None,
            raw={},
        )
        await cs_dispute(
            DisputeInput(
                event=event,
                policy=policy,
                ledger=ledger,
                repo=repo,
                notifier=notifier,
                clock=clock,
                ids=ids,
            )
        )

        assert (await ledger.balance(CUSTOMER_ID, "paid", clock.now())).available == 100
        assert (await repo.customers.get(CUSTOMER_ID)).status == "active"

    run(go())


def test_d9_dispute_closed_lost_bans_customer_default_policy_and_resolves_human():
    async def go():
        clock, ids, repo = _clock(), SequentialIdGen("id_"), InMemoryRepo()
        ledger = InMemoryLedger(ids)
        notifier = CollectingNotifier()
        policy = DEFAULT_POLICY
        await _put_customer(repo, clock)

        open_event = NormalizedEvent(
            id="evt_dispute_3",
            provider="stripe",
            type="dispute.opened",
            occurred_at=clock.now(),
            customer_ref=CUSTOMER_ID,
            subscription_ref=None,
            payment_ref="pi_d9",
            amount=None,
            raw={},
        )
        await cs_dispute(
            DisputeInput(
                event=open_event,
                policy=policy,
                ledger=ledger,
                repo=repo,
                notifier=notifier,
                clock=clock,
                ids=ids,
            )
        )

        close_event = NormalizedEvent(
            id="evt_dispute_3_closed",
            provider="stripe",
            type="dispute.closed",
            occurred_at=clock.now(),
            customer_ref=CUSTOMER_ID,
            subscription_ref=None,
            payment_ref="pi_d9",
            amount=None,
            raw={"outcome": "lost"},
        )
        closed = await cs_dispute(
            DisputeInput(
                event=close_event,
                policy=policy,
                ledger=ledger,
                repo=repo,
                notifier=notifier,
                clock=clock,
                ids=ids,
            )
        )

        assert closed.status == "resolved_human"
        assert closed.decision["outcome"] == "lost"
        assert (await repo.customers.get(CUSTOMER_ID)).status == "banned"

    run(go())


def test_d9_dispute_closed_lost_revoke_only_does_not_ban_or_double_revoke():
    async def go():
        clock, ids, repo = _clock(), SequentialIdGen("id_"), InMemoryRepo()
        ledger = InMemoryLedger(ids)
        notifier = CollectingNotifier()
        policy = resolve_policy(
            {"dispute": {"on_open": "revoke_disputed_grant", "on_lost": "revoke_only"}}
        )
        await _put_customer(repo, clock)

        payment = Payment(
            id="pay_ro",
            customer_id=CUSTOMER_ID,
            provider="stripe",
            provider_ref="pi_ro",
            subscription_id=None,
            amount=Money(amount_minor=1000, currency="USD"),
            status="succeeded",
            kind="topup",
            period=None,
            occurred_at=clock.now(),
            failure=None,
        )
        await repo.payments.put(payment)
        await ledger.append(
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

        open_event = NormalizedEvent(
            id="evt_ro_o",
            provider="stripe",
            type="dispute.opened",
            occurred_at=clock.now(),
            customer_ref=CUSTOMER_ID,
            subscription_ref=None,
            payment_ref=payment.provider_ref,
            amount=None,
            raw={},
        )
        await cs_dispute(
            DisputeInput(
                event=open_event,
                policy=policy,
                ledger=ledger,
                repo=repo,
                notifier=notifier,
                clock=clock,
                ids=ids,
            )
        )
        assert (
            await ledger.balance(CUSTOMER_ID, "paid", clock.now())
        ).available == 0  # revoked at open time

        close_event = NormalizedEvent(
            id="evt_ro_c",
            provider="stripe",
            type="dispute.closed",
            occurred_at=clock.now(),
            customer_ref=CUSTOMER_ID,
            subscription_ref=None,
            payment_ref=payment.provider_ref,
            amount=None,
            raw={"outcome": "lost"},
        )
        closed = await cs_dispute(
            DisputeInput(
                event=close_event,
                policy=policy,
                ledger=ledger,
                repo=repo,
                notifier=notifier,
                clock=clock,
                ids=ids,
            )
        )

        assert closed.status == "resolved_human"
        assert (
            await repo.customers.get(CUSTOMER_ID)
        ).status == "active"  # never banned
        revoke_entries = await ledger.entries(CUSTOMER_ID, kind="revoke")
        # already revoked at open; the (idempotent) revoke on close must not double-revoke
        assert len(revoke_entries) == 1
        assert closed.decision["revoked"] == 0
        assert (await ledger.balance(CUSTOMER_ID, "paid", clock.now())).available == 0

    run(go())


def test_d9_dispute_closed_won_unfreezes_customer_and_resolves_human():
    async def go():
        clock, ids, repo = _clock(), SequentialIdGen("id_"), InMemoryRepo()
        ledger = InMemoryLedger(ids)
        notifier = CollectingNotifier()
        policy = DEFAULT_POLICY
        await _put_customer(repo, clock)

        open_event = NormalizedEvent(
            id="evt_dispute_4",
            provider="stripe",
            type="dispute.opened",
            occurred_at=clock.now(),
            customer_ref=CUSTOMER_ID,
            subscription_ref=None,
            payment_ref="pi_d9b",
            amount=None,
            raw={},
        )
        await cs_dispute(
            DisputeInput(
                event=open_event,
                policy=policy,
                ledger=ledger,
                repo=repo,
                notifier=notifier,
                clock=clock,
                ids=ids,
            )
        )
        assert (await repo.customers.get(CUSTOMER_ID)).status == "frozen"

        close_event = NormalizedEvent(
            id="evt_dispute_4_closed",
            provider="stripe",
            type="dispute.closed",
            occurred_at=clock.now(),
            customer_ref=CUSTOMER_ID,
            subscription_ref=None,
            payment_ref="pi_d9b",
            amount=None,
            raw={"outcome": "won"},
        )
        closed = await cs_dispute(
            DisputeInput(
                event=close_event,
                policy=policy,
                ledger=ledger,
                repo=repo,
                notifier=notifier,
                clock=clock,
                ids=ids,
            )
        )

        assert closed.status == "resolved_human"
        assert closed.decision["outcome"] == "won"
        assert (await repo.customers.get(CUSTOMER_ID)).status == "active"

    run(go())


# ── EC:I6 widget ──────────────────────────────────────────────────────────────────────────────


def test_i6_valid_sign_verify_round_trip():
    token = widget.sign_token(
        widget.SignTokenInput(customer_id=CUSTOMER_ID, ttl_seconds=60), "test-secret"
    )
    claims = widget.verify_token(token, "test-secret")
    assert claims.customer_id == CUSTOMER_ID


def test_i6_expired_token_is_rejected():
    from boilpayment_core import PaymentKitError

    token = widget.sign_token(
        widget.SignTokenInput(customer_id=CUSTOMER_ID, ttl_seconds=-1), "test-secret"
    )
    try:
        widget.verify_token(token, "test-secret")
        raise AssertionError("expected PaymentKitError")
    except PaymentKitError as err:
        assert err.code == "widget_token_expired"


def test_i6_tampered_signature_is_rejected():
    from boilpayment_core import PaymentKitError

    token = widget.sign_token(
        widget.SignTokenInput(customer_id=CUSTOMER_ID, ttl_seconds=60), "test-secret"
    )
    header, payload, _sig = token.split(".")
    tampered = f"{header}.{payload}.deadbeef"
    try:
        widget.verify_token(tampered, "test-secret")
        raise AssertionError("expected PaymentKitError")
    except PaymentKitError as err:
        assert err.code == "widget_token_invalid"


def test_i6_wrong_secret_is_rejected():
    from boilpayment_core import PaymentKitError

    token = widget.sign_token(
        widget.SignTokenInput(customer_id=CUSTOMER_ID, ttl_seconds=60), "test-secret"
    )
    try:
        widget.verify_token(token, "other-secret")
        raise AssertionError("expected PaymentKitError")
    except PaymentKitError as err:
        assert err.code == "widget_token_invalid"


# ── EC:I5 Metrics / CaseMeter ─────────────────────────────────────────────────────────────────


def test_i5_metrics_snapshot_tallies_opened_escalated_resolved_churn_events():
    async def go():
        clock, ids, repo = _clock(), SequentialIdGen("id_"), InMemoryRepo()
        policy = DEFAULT_POLICY
        metrics = Metrics()

        c1 = await open_case(
            OpenCaseInput(
                customer_id=CUSTOMER_ID,
                kind="refund",
                reference_id="m1",
                policy=policy,
                repo=repo,
                clock=clock,
                ids=ids,
                on_case_event=metrics.record,
            )
        )
        await resolve(
            ResolveInput(
                case=c1,
                by="auto",
                decision={},
                repo=repo,
                clock=clock,
                on_case_event=metrics.record,
            )
        )
        c2 = await open_case(
            OpenCaseInput(
                customer_id=CUSTOMER_ID,
                kind="dispute",
                reference_id="m2",
                policy=policy,
                repo=repo,
                clock=clock,
                ids=ids,
                on_case_event=metrics.record,
            )
        )
        await escalate(
            EscalateInput(
                case=c2,
                repo=repo,
                clock=clock,
                reason="needs review",
                on_case_event=metrics.record,
            )
        )

        snap = metrics.snapshot()
        assert snap.counts_by_kind["refund"] == 1
        assert snap.counts_by_kind["dispute"] == 1
        assert snap.counts_by_status["resolved_auto"] == 1
        assert snap.counts_by_status["needs_human"] == 1
        assert snap.durations_ms_by_kind["refund"] == [
            0
        ]  # FixedClock did not advance between open/resolve

    run(go())


def test_i5_case_meter_counts_only_billable_statuses():
    async def go():
        clock, ids, repo = _clock(), SequentialIdGen("id_"), InMemoryRepo()
        policy = DEFAULT_POLICY

        await open_case(
            OpenCaseInput(
                customer_id=CUSTOMER_ID,
                kind="refund",
                reference_id="cm1",
                policy=policy,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )  # open
        needs_human = await open_case(
            OpenCaseInput(
                customer_id=CUSTOMER_ID,
                kind="refund",
                reference_id="cm2",
                policy=policy,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )
        await escalate(
            EscalateInput(case=needs_human, repo=repo, clock=clock, reason="x")
        )
        auto = await open_case(
            OpenCaseInput(
                customer_id=CUSTOMER_ID,
                kind="refund",
                reference_id="cm3",
                policy=policy,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )
        await resolve(
            ResolveInput(case=auto, by="auto", decision={}, repo=repo, clock=clock)
        )
        human = await open_case(
            OpenCaseInput(
                customer_id=CUSTOMER_ID,
                kind="refund",
                reference_id="cm4",
                policy=policy,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )
        await resolve(
            ResolveInput(case=human, by="human", decision={}, repo=repo, clock=clock)
        )
        rejected = await open_case(
            OpenCaseInput(
                customer_id=CUSTOMER_ID,
                kind="refund",
                reference_id="cm5",
                policy=policy,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )
        await reject(RejectInput(case=rejected, reason="no", repo=repo, clock=clock))

        meter = CaseMeter(repo)
        assert (
            await meter.count_billable(customer_id=CUSTOMER_ID) == 3
        )  # auto + human + rejected

    run(go())


# ── EC:I5 HttpLicenseReporter ─────────────────────────────────────────────────────────────────


def _fake_http_call(responder):
    calls: list[dict] = []

    async def http_call(method, url, headers, body):
        calls.append({"method": method, "url": url, "headers": headers, "body": body})
        return responder()

    return http_call, calls


def test_i5_report_case_posts_once_with_bearer_auth_header_on_success():
    async def go():
        http_call, calls = _fake_http_call(lambda: (200, b"{}"))
        reporter = HttpLicenseReporter(api_key="sk_test_123", http_call=http_call)

        await reporter.report_case(
            CaseReportInput(
                case_id="case_1",
                kind="refund",
                status="resolved_auto",
                tenant_ref=CUSTOMER_ID,
                occurred_at=datetime(2026, 1, 1, tzinfo=UTC),
            )
        )

        assert len(calls) == 1
        assert calls[0]["method"] == "POST"
        assert calls[0]["url"].endswith("/cases")
        assert calls[0]["headers"]["Authorization"] == "Bearer sk_test_123"

    run(go())


def test_i5_a_500_response_is_queued_and_flush_sends_it_once_recovered():
    async def go():
        fail = True

        def responder():
            return (500, b"server error") if fail else (200, b"{}")

        http_call, calls = _fake_http_call(responder)
        reporter = HttpLicenseReporter(api_key="sk_test_123", http_call=http_call)

        await reporter.report_case(
            CaseReportInput(
                case_id="case_2",
                kind="refund",
                status="resolved_auto",
                tenant_ref=CUSTOMER_ID,
                occurred_at=datetime(2026, 1, 1, tzinfo=UTC),
            )
        )
        assert len(calls) == 1  # the failed attempt

        fail = False
        result = await reporter.flush()
        assert result == {"sent": 1, "remaining": 0}
        assert len(calls) == 2  # the retried attempt

    run(go())


def test_i5_resolve_through_a_real_http_license_reporter_makes_exactly_one_post():
    async def go():
        clock, ids, repo = _clock(), SequentialIdGen("id_"), InMemoryRepo()
        policy = DEFAULT_POLICY
        http_call, calls = _fake_http_call(lambda: (200, b"{}"))
        reporter = HttpLicenseReporter(api_key="sk_test_123", http_call=http_call)

        cs_case = await open_case(
            OpenCaseInput(
                customer_id=CUSTOMER_ID,
                kind="refund",
                reference_id="http_1",
                policy=policy,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )
        await resolve(
            ResolveInput(
                case=cs_case,
                by="auto",
                decision={},
                repo=repo,
                clock=clock,
                reporter=reporter,
            )
        )

        assert len(calls) == 1

    run(go())


def _dispute_env(policy_patch: dict):
    clock, ids, repo = _clock(), SequentialIdGen("id_"), InMemoryRepo()
    return (
        clock,
        ids,
        repo,
        InMemoryLedger(ids),
        CollectingNotifier(),
        resolve_policy(policy_patch),
    )


def test_d9_won_after_revoke_restores_every_revoked_credit():
    """EC:D9 -- audit gap #1 regression: winning the dispute must give the credits back."""

    async def go():
        clock, ids, repo, ledger, notifier, policy = _dispute_env(
            {"dispute": {"on_open": "revoke_disputed_grant"}}
        )
        await _put_customer(repo, clock)
        payment = Payment(
            id="pay_won",
            customer_id=CUSTOMER_ID,
            provider="stripe",
            provider_ref="pi_won",
            subscription_id=None,
            amount=Money(amount_minor=1000, currency="USD"),
            status="disputed",
            kind="topup",
            period=None,
            occurred_at=clock.now(),
            failure=None,
        )
        await repo.payments.put(payment)
        expires_at = clock.now() + timedelta(days=30)
        await ledger.append(
            NewLedgerEntry(
                customer_id=CUSTOMER_ID,
                pool="paid",
                kind="grant",
                amount=100,
                unit_price_minor=10,
                currency="USD",
                expires_at=expires_at,
                source="topup",
                reference=LedgerReference(payment_id=payment.id),
                idempotency_key=f"topup:{payment.id}",
                actor="system",
            )
        )

        def di(eid: str, etype: str, raw: dict) -> DisputeInput:
            return DisputeInput(
                event=NormalizedEvent(
                    id=eid,
                    provider="stripe",
                    type=etype,
                    occurred_at=clock.now(),
                    customer_ref=CUSTOMER_ID,
                    subscription_ref=None,
                    payment_ref=payment.provider_ref,
                    amount=None,
                    raw=raw,
                ),
                policy=policy,
                ledger=ledger,
                repo=repo,
                notifier=notifier,
                clock=clock,
                ids=ids,
            )

        await cs_dispute(di("evt_won", "dispute.opened", {}))
        assert (await ledger.balance(CUSTOMER_ID, "paid", clock.now())).available == 0

        closed = await cs_dispute(di("evt_won_c", "dispute.closed", {"outcome": "won"}))
        assert closed.decision["outcome"] == "won"
        assert closed.decision["restored"] == 100
        # was 0 before the fix
        assert (await ledger.balance(CUSTOMER_ID, "paid", clock.now())).available == 100
        restored = next(
            e
            for e in await ledger.entries(CUSTOMER_ID, kind="grant")
            if e.source == "dispute"
        )
        assert restored.expires_at == expires_at  # original expiry preserved

        again = await cs_dispute(di("evt_won_c", "dispute.closed", {"outcome": "won"}))
        assert again.decision["restored"] == 0  # replay must not grant twice
        assert (await ledger.balance(CUSTOMER_ID, "paid", clock.now())).available == 100

    run(go())


def test_d9_lost_with_freeze_on_open_still_revokes():
    """EC:D9 -- revoke_only must honour its name even when on_open only froze the customer."""

    async def go():
        clock, ids, repo, ledger, notifier, policy = _dispute_env(
            {"dispute": {"on_open": "freeze_customer", "on_lost": "revoke_only"}}
        )
        await _put_customer(repo, clock)
        payment = Payment(
            id="pay_lost",
            customer_id=CUSTOMER_ID,
            provider="stripe",
            provider_ref="pi_lost",
            subscription_id=None,
            amount=Money(amount_minor=1000, currency="USD"),
            status="disputed",
            kind="topup",
            period=None,
            occurred_at=clock.now(),
            failure=None,
        )
        await repo.payments.put(payment)
        await ledger.append(
            NewLedgerEntry(
                customer_id=CUSTOMER_ID,
                pool="paid",
                kind="grant",
                amount=60,
                unit_price_minor=10,
                currency="USD",
                source="topup",
                reference=LedgerReference(payment_id=payment.id),
                idempotency_key=f"topup:{payment.id}",
                actor="system",
            )
        )

        def di(eid: str, etype: str, raw: dict) -> DisputeInput:
            return DisputeInput(
                event=NormalizedEvent(
                    id=eid,
                    provider="stripe",
                    type=etype,
                    occurred_at=clock.now(),
                    customer_ref=CUSTOMER_ID,
                    subscription_ref=None,
                    payment_ref=payment.provider_ref,
                    amount=None,
                    raw=raw,
                ),
                policy=policy,
                ledger=ledger,
                repo=repo,
                notifier=notifier,
                clock=clock,
                ids=ids,
            )

        await cs_dispute(di("evt_lost", "dispute.opened", {}))
        assert (await ledger.balance(CUSTOMER_ID, "paid", clock.now())).available == 60

        closed = await cs_dispute(
            di("evt_lost_c", "dispute.closed", {"outcome": "lost"})
        )
        assert closed.decision["revoked"] == 60
        # was 60 before the fix
        assert (await ledger.balance(CUSTOMER_ID, "paid", clock.now())).available == 0
        assert (await repo.customers.get(CUSTOMER_ID)).status == "frozen"

    run(go())


# ── EC:L5 correlationId propagation ──────────────────────────────────────────────────────────


def test_ec_l5_regrant_auto_mode_stamps_correlation_id():
    async def go():
        clock, ids, repo = _clock(), SequentialIdGen("id_"), InMemoryRepo()
        ledger = InMemoryLedger(ids)
        policy = DEFAULT_POLICY
        cs_case = await open_case(
            OpenCaseInput(
                customer_id=CUSTOMER_ID,
                kind="regrant",
                reference_id="topup:pay_l5",
                policy=policy,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )

        resolved = await regrant(
            RegrantInput(
                case=cs_case,
                ledger=ledger,
                repo=repo,
                policy=policy,
                clock=clock,
                ids=ids,
                plan=RegrantPlan(pool="paid", amount=50),
                correlation_id="corr_regrant_1",
            )
        )
        assert resolved.status == "resolved_auto"
        entries = await ledger.entries(CUSTOMER_ID, kind="grant")
        entry = next(e for e in entries if e.source == "regrant")
        assert entry.reference.correlation_id == "corr_regrant_1"

    run(go())


def test_ec_l5_dispute_revoke_and_restore_stamp_correlation_id():
    async def go():
        clock, ids, repo = _clock(), SequentialIdGen("id_"), InMemoryRepo()
        ledger = InMemoryLedger(ids)
        notifier = CollectingNotifier()
        policy = resolve_policy({"dispute": {"on_open": "revoke_disputed_grant"}})
        await _put_customer(repo, clock)

        payment = Payment(
            id="pay_l5_dispute",
            customer_id=CUSTOMER_ID,
            provider="stripe",
            provider_ref="pi_l5_dispute",
            subscription_id=None,
            amount=Money(amount_minor=1000, currency="USD"),
            status="succeeded",
            kind="topup",
            period=None,
            occurred_at=clock.now(),
            failure=None,
        )
        await repo.payments.put(payment)
        await ledger.append(
            NewLedgerEntry(
                customer_id=CUSTOMER_ID,
                pool="paid",
                kind="grant",
                amount=80,
                unit_price_minor=10,
                currency="USD",
                source="topup",
                reference=LedgerReference(payment_id=payment.id),
                idempotency_key=f"topup:{payment.id}",
                actor="system",
            )
        )

        def di(eid: str, etype: str, raw: dict) -> DisputeInput:
            return DisputeInput(
                event=NormalizedEvent(
                    id=eid,
                    provider="stripe",
                    type=etype,
                    occurred_at=clock.now(),
                    customer_ref=CUSTOMER_ID,
                    subscription_ref=None,
                    payment_ref=payment.provider_ref,
                    amount=None,
                    raw=raw,
                ),
                policy=policy,
                ledger=ledger,
                repo=repo,
                notifier=notifier,
                clock=clock,
                ids=ids,
                correlation_id="corr_dispute_1",
            )

        await cs_dispute(di("evt_dispute_l5", "dispute.opened", {}))
        revoke_entries = await ledger.entries(CUSTOMER_ID, kind="revoke")
        assert len(revoke_entries) == 1
        assert revoke_entries[0].reference.correlation_id == "corr_dispute_1"

        closed = await cs_dispute(
            di("evt_dispute_l5_closed", "dispute.closed", {"outcome": "won"})
        )
        assert closed.decision["outcome"] == "won"
        assert closed.decision["restored"] == 80
        grant_entries = [
            e
            for e in await ledger.entries(CUSTOMER_ID, kind="grant")
            if e.source == "dispute"
        ]
        assert grant_entries[0].reference.correlation_id == "corr_dispute_1"

    run(go())


def test_manual_regrant_approval_can_resume_the_same_case():
    async def go():
        clock, ids, repo = _clock(), SequentialIdGen("approval_"), InMemoryRepo()
        ledger = InMemoryLedger(ids)
        policy = resolve_policy({"cs": {"regrant": {"mode": "manual_approve"}}})
        case = await open_case(
            OpenCaseInput(
                customer_id=CUSTOMER_ID,
                kind="regrant",
                reference_id="approval",
                policy=policy,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )
        input = RegrantInput(
            case=case,
            ledger=ledger,
            repo=repo,
            policy=policy,
            clock=clock,
            ids=ids,
            plan=RegrantPlan(pool="paid", amount=10),
        )
        pending = await regrant(input)
        assert pending.status == "needs_human"
        input.approved_by = "operator"
        resolved = await regrant(input)
        assert resolved.status == "resolved_auto"
        input.approved_by = None
        replay = await regrant(input)
        assert replay.status == "resolved_auto"
        assert len(await ledger.entries(CUSTOMER_ID, kind="grant")) == 1

    run(go())
