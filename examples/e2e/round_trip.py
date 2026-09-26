"""E2E round-trip across all boilpayment modules (Python side).

Uses ONLY public package exports + an in-file fake PaymentProvider.
Mirrors examples/e2e/round-trip.ts line-for-line (except ISO tz suffix).

Adapters: webhook.default_handlers' LifecycleDeps Protocol and
cs.refund_assist's RefundEvaluateFn/RefundExecuteFn Protocol call their
dependencies with flat keyword args, but the real lifecycle/refund
functions take a single dataclass-input argument. Small in-file adapters
below bridge that gap (this is drift from docs/ARCHITECTURE.md §3.5's
implied "same call shape" — see FINDINGS.md).
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
from datetime import datetime, timedelta, timezone

from boilpayment_core import (
    Customer,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    CollectingNotifier,
    Money,
    NormalizedEvent,
    Payment,
    Period,
    Plan,
    PlanPrice,
    ProviderCapabilities,
    ProviderRef,
    Refund,
    SequentialIdGen,
    Subscription,
    WebhookSignatureError,
    resolve_policy,
)
import boilpayment_credits as credits
import boilpayment_lifecycle as lifecycle
import boilpayment_refund as refund
import boilpayment_usage as usage
import boilpayment_webhook as webhook
import boilpayment_cs as cs


# ── in-file fake provider ────────────────────────────────────────────────────
class FakeProvider:
    name = "stripe"

    def __init__(self) -> None:
        self._payments: dict[str, Payment] = {}
        self._payments_by_customer: dict[str, list[Payment]] = {}
        self._subs: dict[str, Subscription] = {}

    def capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            native_subscriptions=True,
            partial_refund=True,
            meters=False,
            scheduling="provider",
            webhook_signature=True,
        )

    async def create_customer(self, *, email, name=None, metadata=None):
        return {"ref": "cus_fake"}

    async def create_checkout(self, input):
        raise RuntimeError("fake: create_checkout not used in this scenario")

    async def get_payment(self, provider_ref: str) -> Payment:
        p = self._payments.get(provider_ref)
        if p is None:
            raise RuntimeError(f"fake: no payment {provider_ref}")
        return p

    async def list_payments(
        self, *, customer_ref: str, since: datetime
    ) -> list[Payment]:
        return [
            p
            for p in self._payments_by_customer.get(customer_ref, [])
            if p.occurred_at >= since
        ]

    async def get_subscription(self, provider_ref: str) -> Subscription:
        s = self._subs.get(provider_ref)
        if s is None:
            raise RuntimeError(f"fake: no subscription {provider_ref}")
        return s

    async def change_subscription(
        self, provider_ref: str, *, new_price_ref, proration, reset_anchor
    ) -> Subscription:
        s = self._subs.get(provider_ref)
        if s is None:
            raise RuntimeError(f"fake: no subscription {provider_ref}")
        return s

    async def cancel_subscription(
        self, provider_ref: str, *, at_period_end
    ) -> Subscription:
        s = self._subs.get(provider_ref)
        if s is None:
            raise RuntimeError(f"fake: no subscription {provider_ref}")
        return s

    async def charge_billing_key(self, **kwargs) -> Payment:
        raise RuntimeError("fake: charge_billing_key not used in this scenario")

    async def refund(
        self, *, payment_ref, amount, reason, idempotency_key, extra=None
    ) -> Refund:
        payment = self._payments.get(payment_ref)
        return Refund(
            id=f"re_{idempotency_key}",
            payment_id=payment.id if payment else "",
            customer_id=payment.customer_id if payment else "",
            amount=amount,
            status="succeeded",
            provider_ref=f"re_{idempotency_key}",
            credits_revoked=0,
            rule_id="",
            reason=reason,
            failure=None,
            created_at=datetime.now(timezone.utc),
        )

    async def report_usage(self, **kwargs) -> None:
        return None

    async def verify_webhook(
        self, *, headers: dict[str, str], raw_body: str
    ) -> NormalizedEvent:
        if headers.get("x-sig") != "ok":
            raise WebhookSignatureError()
        raw = json.loads(raw_body)
        amount = None
        if raw.get("amount") is not None:
            amount = Money(
                amount_minor=raw["amount"]["amount_minor"],
                currency=raw["amount"]["currency"],
            )
        return NormalizedEvent(
            id=raw["id"],
            provider="stripe",
            type=raw["type"],
            occurred_at=datetime.fromisoformat(raw["occurred_at"]),
            customer_ref=raw.get("customer_ref"),
            subscription_ref=raw.get("subscription_ref"),
            payment_ref=raw.get("payment_ref"),
            amount=amount,
            raw=raw,
        )

    # test-only helpers — mirror local repo state into the "live" provider view
    def set_payment(self, p: Payment, customer_ref: str) -> None:
        self._payments[p.provider_ref] = p
        lst = self._payments_by_customer.setdefault(customer_ref, [])
        for i, x in enumerate(lst):
            if x.provider_ref == p.provider_ref:
                lst[i] = p
                break
        else:
            lst.append(p)

    def set_subscription(self, s: Subscription) -> None:
        self._subs[s.provider_ref] = s


# ── adapters bridging webhook/cs's flat-kwarg Protocols to the real
#    dataclass-input lifecycle/refund functions ──────────────────────────────
class _LifecycleDunningAdapter:
    async def on_payment_failed(self, *, sub, policy, repo, notifier, clock):
        return await lifecycle.dunning.on_payment_failed(
            lifecycle.dunning.OnPaymentFailedInput(
                sub=sub, policy=policy, repo=repo, notifier=notifier, clock=clock
            )
        )


class _LifecycleAdapter:
    def __init__(self) -> None:
        self.dunning = _LifecycleDunningAdapter()

    async def on_renewal_paid(self, *, sub, payment, policy, ledger, repo, clock):
        return await lifecycle.on_renewal_paid(
            lifecycle.OnRenewalPaidInput(
                sub=sub,
                payment=payment,
                policy=policy,
                ledger=ledger,
                repo=repo,
                clock=clock,
            )
        )


async def _refund_evaluate_adapter(
    *,
    payment,
    sub,
    policy,
    ledger,
    repo,
    clock,
    requested_amount=None,
    provider_fee_minor=None,
):
    return await refund.evaluate(
        refund.EvaluateInput(
            payment=payment,
            sub=sub,
            policy=policy,
            ledger=ledger,
            repo=repo,
            clock=clock,
            requested_amount=requested_amount,
            provider_fee_minor=provider_fee_minor,
        )
    )


async def _refund_execute_adapter(
    *,
    decision,
    provider,
    ledger,
    repo,
    clock,
    ids,
    extra=None,
    cs=None,
    correlation_id=None,
):
    return await refund.execute(
        refund.ExecuteInput(
            decision=decision,
            provider=provider,
            ledger=ledger,
            repo=repo,
            clock=clock,
            ids=ids,
            extra=extra,
            cs=cs,
            correlation_id=correlation_id,
        )
    )


def _fmt(v: object) -> str:
    if isinstance(v, datetime):
        return v.isoformat()
    if v is None:
        return "None"
    return str(v)


def _line(n: str, label: str, kv: dict[str, object]) -> None:
    parts = " ".join(f"{k}={_fmt(v)}" for k, v in kv.items())
    print(f"{n}_{label}: {parts}")


async def main() -> None:
    clock = FixedClock(datetime(2026, 1, 1, tzinfo=timezone.utc))
    ids = SequentialIdGen("id_")
    ledger = InMemoryLedger(ids)
    repo = InMemoryRepo()
    notifier = CollectingNotifier()
    policy = resolve_policy({"credits": {"rollover": "banked", "bank_cap": 50}})
    provider = FakeProvider()

    # ── 01 seed ─────────────────────────────────────────────────────────────
    customer = Customer(
        id="cust1",
        email="e@x.com",
        provider_refs=[ProviderRef(provider="stripe", ref="cus_1")],
        status="active",
        created_at=clock.now(),
    )
    await repo.customers.put(customer)

    plan_a = Plan(
        id="planA",
        name="Plan A",
        interval="month",
        credits_per_period=100,
        usage_included=5,
        trial_days=0,
        prices=[PlanPrice(currency="USD", amount_minor=1000)],
    )
    plan_b = Plan(
        id="planB",
        name="Plan B",
        interval="month",
        credits_per_period=300,
        usage_included=20,
        trial_days=0,
        prices=[PlanPrice(currency="USD", amount_minor=3000)],
    )
    await repo.plans.put(plan_a)
    await repo.plans.put(plan_b)

    sub1 = Subscription(
        id="sub1",
        customer_id="cust1",
        plan_id="planA",
        provider="stripe",
        provider_ref="sub_1",
        status="active",
        current_period=Period(
            start=datetime(2026, 1, 1, tzinfo=timezone.utc),
            end=datetime(2026, 2, 1, tzinfo=timezone.utc),
        ),
        anchor_day=1,
        cancel_at_period_end=False,
        grace_until=None,
        billing_key=None,
        scheduled_plan_id=None,
        created_at=clock.now(),
    )
    await repo.subscriptions.put(sub1)
    provider.set_subscription(sub1)

    payment1 = Payment(
        id="pay1",
        customer_id="cust1",
        provider="stripe",
        provider_ref="pay_1",
        subscription_id="sub1",
        amount=Money(amount_minor=1000, currency="USD"),
        status="succeeded",
        kind="subscription",
        period=Period(start=sub1.current_period.start, end=sub1.current_period.end),
        occurred_at=clock.now(),
        failure=None,
    )
    await repo.payments.put(payment1)
    provider.set_payment(payment1, "cus_1")

    _line(
        "01",
        "seed",
        {
            "customer": customer.id,
            "planA": plan_a.id,
            "planB": plan_b.id,
            "sub": sub1.id,
            "payment": payment1.id,
        },
    )

    # ── 02 webhook: payment.succeeded (first period) ───────────────────────
    lifecycle_deps = _LifecycleAdapter()
    handlers = webhook.default_handlers(
        policy=policy,
        ledger=ledger,
        repo=repo,
        notifier=notifier,
        clock=clock,
        ids=ids,
        lifecycle=lifecycle_deps,
    )

    evt1 = {
        "id": "evt_1",
        "type": "payment.succeeded",
        "occurred_at": clock.now().isoformat(),
        "customer_ref": "cus_1",
        "subscription_ref": "sub_1",
        "payment_ref": "pay_1",
        "amount": {
            "amount_minor": payment1.amount.amount_minor,
            "currency": payment1.amount.currency,
        },
    }
    r1 = await webhook.receive(
        provider=provider,
        headers={"x-sig": "ok"},
        raw_body=json.dumps(evt1),
        repo=repo,
        clock=clock,
    )
    await webhook.process(
        event_id=r1.event_id,
        providers={"stripe": provider},
        handlers=handlers,
        repo=repo,
        clock=clock,
    )
    bal = await ledger.balance("cust1", "paid", clock.now())
    _line(
        "02",
        "webhook_first_period",
        {
            "received_status": r1.status,
            "duplicated": r1.duplicated,
            "balance": bal.available,
        },
    )

    r1dup = await webhook.receive(
        provider=provider,
        headers={"x-sig": "ok"},
        raw_body=json.dumps(evt1),
        repo=repo,
        clock=clock,
    )
    await webhook.process(
        event_id=r1dup.event_id,
        providers={"stripe": provider},
        handlers=handlers,
        repo=repo,
        clock=clock,
    )
    bal = await ledger.balance("cust1", "paid", clock.now())
    _line(
        "02",
        "webhook_duplicate",
        {"duplicated": r1dup.duplicated, "balance": bal.available},
    )

    # ── 03 consume 30 ───────────────────────────────────────────────────────
    consume_result = await credits.consume(
        credits.ConsumeCreditsInput(
            customer_id="cust1",
            amount=30,
            policy=policy,
            ledger=ledger,
            clock=clock,
            idempotency_key="consume:1",
        )
    )
    bal = await ledger.balance("cust1", "paid", clock.now())
    _line("03", "consume", {"ok": consume_result.ok, "balance": bal.available})

    # ── 04 advance to Jan 16, upgrade to plan B ────────────────────────────
    clock.advance(15 * 86_400_000)
    sub1 = await repo.subscriptions.get("sub1")
    upgrade_result = await lifecycle.upgrade(
        lifecycle.UpgradeInput(
            sub=sub1,
            new_plan=plan_b,
            policy=policy,
            provider=provider,
            ledger=ledger,
            repo=repo,
            clock=clock,
            ids=ids,
        )
    )
    sub1 = upgrade_result.sub
    provider.set_subscription(sub1)
    bal = await ledger.balance("cust1", "paid", clock.now())
    _line(
        "04",
        "upgrade",
        {
            "creditDelta": upgrade_result.credit_delta,
            "anchorDay": sub1.anchor_day,
            "periodStart": sub1.current_period.start,
            "periodEnd": sub1.current_period.end,
            "balance": bal.available,
        },
    )

    # ── 05 usage.record x3 + usage.check (included=5, hard_block) ──────────
    for i in range(3):
        await usage.record(
            event=usage.UsageEventInput(
                customer_id="cust1",
                meter="api_call",
                quantity=1,
                occurred_at=clock.now(),
                idempotency_key=f"usage:{i}",
            ),
            sub=sub1,
            policy=policy,
            repo=repo,
            clock=clock,
            ids=ids,
        )
    check_allow = await usage.check(
        customer_id="cust1",
        meter="api_call",
        quantity=2,
        sub=sub1,
        policy=policy,
        repo=repo,
        ledger=ledger,
        clock=clock,
        included_quantity=5,
    )
    check_block = await usage.check(
        customer_id="cust1",
        meter="api_call",
        quantity=4,
        sub=sub1,
        policy=policy,
        repo=repo,
        ledger=ledger,
        clock=clock,
        included_quantity=5,
    )
    _line(
        "05",
        "usage",
        {
            "allow": check_allow.allow,
            "allow_reason": check_allow.reason,
            "block": check_block.allow,
            "block_reason": check_block.reason,
        },
    )

    # ── 06 advance to period end (Feb 16), renewal ─────────────────────────
    clock.advance(int((sub1.current_period.end - clock.now()).total_seconds() * 1000))
    sub1 = await repo.subscriptions.get("sub1")
    period2 = lifecycle.period.next_period(
        sub1.current_period,
        "month",
        sub1.anchor_day,
        policy.period.timezone,
        policy.period.month_end_anchor,
    )
    payment2 = Payment(
        id="pay2",
        customer_id="cust1",
        provider="stripe",
        provider_ref="pay_2",
        subscription_id="sub1",
        amount=Money(amount_minor=plan_b.prices[0].amount_minor, currency="USD"),
        status="succeeded",
        kind="subscription",
        period=period2,
        occurred_at=clock.now(),
        failure=None,
    )
    await repo.payments.put(payment2)
    provider.set_payment(payment2, "cus_1")
    provider.set_subscription(sub1)

    evt2 = {
        "id": "evt_2",
        "type": "payment.succeeded",
        "occurred_at": clock.now().isoformat(),
        "customer_ref": "cus_1",
        "subscription_ref": "sub_1",
        "payment_ref": "pay_2",
        "amount": {
            "amount_minor": payment2.amount.amount_minor,
            "currency": payment2.amount.currency,
        },
    }
    r2 = await webhook.receive(
        provider=provider,
        headers={"x-sig": "ok"},
        raw_body=json.dumps(evt2),
        repo=repo,
        clock=clock,
    )
    await webhook.process(
        event_id=r2.event_id,
        providers={"stripe": provider},
        handlers=handlers,
        repo=repo,
        clock=clock,
    )
    sub1 = await repo.subscriptions.get("sub1")
    bal = await ledger.balance("cust1", "paid", clock.now())
    _line(
        "06",
        "renewal",
        {
            "periodStart": sub1.current_period.start,
            "periodEnd": sub1.current_period.end,
            "balance": bal.available,
        },
    )

    # ── 07 refund at day 3 (D1) via cs.refund_assist ───────────────────────
    clock.advance(3 * 86_400_000)
    decision = await refund.evaluate(
        refund.EvaluateInput(
            payment=payment2,
            sub=sub1,
            policy=policy,
            ledger=ledger,
            repo=repo,
            clock=clock,
        )
    )
    cs_case_refund = await cs.open_case(
        cs.OpenCaseInput(
            customer_id="cust1",
            kind="refund",
            reference_id=payment2.id,
            policy=policy,
            repo=repo,
            clock=clock,
            ids=ids,
        )
    )
    resolved_refund_case = await cs.refund_assist(
        cs.RefundAssistInput(
            case=cs_case_refund,
            payment=payment2,
            sub=sub1,
            policy=policy,
            ledger=ledger,
            repo=repo,
            clock=clock,
            ids=ids,
            provider=provider,
            refund_evaluate=_refund_evaluate_adapter,
            refund_execute=_refund_execute_adapter,
        )
    )
    bal = await ledger.balance("cust1", "paid", clock.now())
    refund_record = (
        (resolved_refund_case.decision or {}).get("refund")
        if resolved_refund_case.decision
        else None
    )
    _line(
        "07",
        "refund",
        {
            "ruleId": decision.rule_id,
            "amountMinor": decision.amount.amount_minor,
            "creditsToRevoke": decision.credits_to_revoke,
            "needsHuman": decision.needs_human,
            "caseStatus": resolved_refund_case.status,
            "refundStatus": refund_record.status if refund_record else None,
            "balance": bal.available,
        },
    )

    # ── 08 cs.reconcile / cs.regrant (topup payment with no ledger grant) ──
    topup_payment = Payment(
        id="pay3",
        customer_id="cust1",
        provider="stripe",
        provider_ref="pay_3",
        subscription_id=None,
        amount=Money(amount_minor=500, currency="USD"),
        status="succeeded",
        kind="topup",
        period=None,
        occurred_at=clock.now(),
        failure=None,
    )
    provider.set_payment(
        topup_payment, "cus_1"
    )  # deliberately NOT stored in local repo.payments / no ledger grant

    since = datetime(2026, 1, 1, tzinfo=timezone.utc)
    cases1 = await cs.reconcile(
        cs.ReconcileInput(
            providers={"stripe": provider},
            ledger=ledger,
            repo=repo,
            policy=policy,
            clock=clock,
            ids=ids,
            since=since,
        )
    )
    regrant_case = next(
        (
            c
            for c in cases1
            if c.kind == "regrant" and c.reference_id == f"topup:{topup_payment.id}"
        ),
        None,
    )
    if regrant_case is None:
        raise RuntimeError("expected a regrant case for the unmatched topup payment")
    regranted = await cs.regrant(
        cs.RegrantInput(
            case=regrant_case,
            ledger=ledger,
            repo=repo,
            policy=policy,
            clock=clock,
            ids=ids,
            plan=cs.RegrantPlan(pool="paid", amount=50, reason="reconcile regrant"),
        )
    )
    bal = await ledger.balance("cust1", "paid", clock.now())
    cases2 = await cs.reconcile(
        cs.ReconcileInput(
            providers={"stripe": provider},
            ledger=ledger,
            repo=repo,
            policy=policy,
            clock=clock,
            ids=ids,
            since=since,
        )
    )
    _line(
        "08",
        "cs_reconcile",
        {
            "cases_found": len(cases1),
            "regrant_status": regranted.status,
            "balance": bal.available,
            "cases_second_pass": len(cases2),
        },
    )

    # ── 09 dunning: payment_failed -> grace expired ────────────────────────
    provider.set_subscription(sub1)
    evt3 = {
        "id": "evt_3",
        "type": "subscription.payment_failed",
        "occurred_at": clock.now().isoformat(),
        "customer_ref": "cus_1",
        "subscription_ref": "sub_1",
        "payment_ref": None,
        "amount": None,
    }
    r3 = await webhook.receive(
        provider=provider,
        headers={"x-sig": "ok"},
        raw_body=json.dumps(evt3),
        repo=repo,
        clock=clock,
    )
    await webhook.process(
        event_id=r3.event_id,
        providers={"stripe": provider},
        handlers=handlers,
        repo=repo,
        clock=clock,
    )
    sub1 = await repo.subscriptions.get("sub1")
    _line(
        "09", "payment_failed", {"status": sub1.status, "graceUntil": sub1.grace_until}
    )

    clock.advance(8 * 86_400_000)
    sub1 = await repo.subscriptions.get("sub1")
    grace_result = await lifecycle.dunning.on_grace_expired(
        lifecycle.dunning.OnGraceExpiredInput(
            sub=sub1,
            policy=policy,
            ledger=ledger,
            repo=repo,
            notifier=notifier,
            clock=clock,
        )
    )
    sub1 = grace_result.sub
    bal = await ledger.balance("cust1", "paid", clock.now())
    _line(
        "09",
        "grace_expired",
        {
            "status": sub1.status,
            "revoked_count": len(grace_result.revoked),
            "balance": bal.available,
            "notifier_types": ",".join(n.type for n in notifier.sent),
        },
    )

    # ── 10 EC:A25 renewal arrives while the payment is still pending, then settles ──
    await repo.customers.put(
        Customer(
            id="cust2",
            email="f@x.com",
            provider_refs=[ProviderRef(provider="stripe", ref="cus_2")],
            status="active",
            created_at=clock.now(),
        )
    )
    p10_start = clock.now()
    p10 = Period(start=p10_start, end=p10_start + timedelta(days=30))
    sub2 = Subscription(
        id="sub2",
        customer_id="cust2",
        plan_id="planA",
        provider="stripe",
        provider_ref="sub_2",
        status="active",
        current_period=Period(start=p10_start - timedelta(days=30), end=p10_start),
        anchor_day=1,
        cancel_at_period_end=False,
        grace_until=None,
        billing_key=None,
        scheduled_plan_id=None,
        created_at=clock.now(),
    )
    await repo.subscriptions.put(sub2)
    provider.set_subscription(sub2)
    payment3 = Payment(
        id="pay3",
        customer_id="cust2",
        provider="stripe",
        provider_ref="pay_3",
        subscription_id="sub2",
        amount=Money(amount_minor=plan_a.prices[0].amount_minor, currency="USD"),
        status="pending",
        kind="subscription",
        period=p10,
        occurred_at=clock.now(),
        failure=None,
    )
    await repo.payments.put(payment3)
    provider.set_payment(payment3, "cus_2")
    evt10 = {
        "id": "evt_10",
        "type": "payment.succeeded",
        "occurred_at": clock.now().isoformat(),
        "customer_ref": "cus_2",
        "subscription_ref": "sub_2",
        "payment_ref": "pay_3",
        "amount": {"amount_minor": payment3.amount.amount_minor, "currency": "USD"},
    }
    r10 = await webhook.receive(
        provider=provider, headers={"x-sig": "ok"}, raw_body=json.dumps(evt10), repo=repo, clock=clock
    )
    await webhook.process(
        event_id=r10.event_id, providers={"stripe": provider}, handlers=handlers, repo=repo, clock=clock
    )
    # copy the fields now: the in-memory repo hands back the live row, which the retry below rewrites
    pending_record = dataclasses.replace(await repo.webhook_events.get(r10.event_id))
    bal_pending = await ledger.balance("cust2", "paid", clock.now())
    provider.set_payment(dataclasses.replace(payment3, status="succeeded"), "cus_2")
    await webhook.process(
        event_id=r10.event_id, providers={"stripe": provider}, handlers=handlers, repo=repo, clock=clock
    )
    paid_record = await repo.webhook_events.get(r10.event_id)
    bal_paid = await ledger.balance("cust2", "paid", clock.now())
    _line(
        "10",
        "renewal_pending_then_paid",
        {
            "pending_status": pending_record.status,
            "pending_error": pending_record.error,
            "pending_balance": bal_pending.available,
            "paid_status": paid_record.status,
            "paid_balance": bal_paid.available,
        },
    )


if __name__ == "__main__":
    asyncio.run(main())
