"""Round-7 audit A7-8 (EC:I11): every notification the kit itself sends renders with no {placeholder}
left, in both locales. The payloads come from the real senders (scheduler decline, dunning retries,
grace expiry, an unanswered charge, credits expiry, a CS escalation). Mirrors round7-notify.test.ts."""

from __future__ import annotations

import asyncio
import dataclasses
import re
from datetime import UTC, datetime
from typing import Any

from boilpayment_core import (
    CollectingNotifier,
    Customer,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    LedgerReference,
    NewLedgerEntry,
    Payment,
    PaymentFailure,
    Period,
    Plan,
    PlanPrice,
    ProviderCapabilities,
    SequentialIdGen,
    Subscription,
    resolve_policy,
)
from boilpayment_credits import NotifyExpiringInput, notify_expiring
from boilpayment_cs import EscalateInput, OpenCaseInput, escalate, open_case
from boilpayment_lifecycle import dunning, scheduler
from boilpayment_notify import render_notification


def d(s: str) -> datetime:
    return datetime.fromisoformat(s).astimezone(UTC)


class Fake:
    name = "toss"

    def __init__(self) -> None:
        self.throw_next = False

    def capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(native_subscriptions=False, partial_refund=True, meters=False, scheduling="self", webhook_signature=False)

    async def charge_billing_key(self, **kw: Any) -> Payment:
        if self.throw_next:
            self.throw_next = False
            raise RuntimeError("socket hang up")
        return Payment(id="x", customer_id=kw["customer_ref"], provider="toss", provider_ref="pk_" + kw["order_id"], subscription_id=None,
                       amount=kw["amount"], status="failed", kind="subscription", period=None, occurred_at=d("2024-02-01T01:00:00Z"),
                       failure=PaymentFailure(code="card_declined", provider_code=None, retryable=True, user_message="d"), cash_receipt=None)


def _sub(sub_id: str) -> Subscription:
    return Subscription(id=sub_id, customer_id="c1", plan_id="basic", provider="toss", provider_ref=None, status="active",
                        current_period=Period(start=d("2024-01-01T00:00:00Z"), end=d("2024-02-01T00:00:00Z")), anchor_day=1,
                        cancel_at_period_end=False, grace_until=None, billing_key="bk", scheduled_plan_id=None, version=0,
                        currency="KRW", created_at=d("2024-01-01T00:00:00Z"))


def test_every_kit_notification_renders_without_a_placeholder() -> None:
    async def body() -> None:
        repo, ledger = InMemoryRepo(), InMemoryLedger(SequentialIdGen("l_"))
        notifier, policy, provider = CollectingNotifier(), resolve_policy(), Fake()

        def clk(at: str) -> FixedClock:
            return FixedClock(d(at))

        await repo.plans.put(Plan(id="basic", name="Basic", interval="month", credits_per_period=100, usage_included=0, trial_days=0,
                                  prices=[PlanPrice(currency="KRW", amount_minor=5000, provider_price_refs={})]))
        await repo.customers.put(Customer(id="c1", email=None, provider_refs=[], status="active", created_at=d("2024-01-01T00:00:00Z")))
        await repo.subscriptions.put(_sub("sub_1"))
        await repo.subscriptions.put(_sub("sub_2"))

        # sub_2: the charge gets no answer -> cs.needs_human (renewal_charge_unresolved)
        s1 = await repo.subscriptions.get("sub_1")
        await repo.subscriptions.put(dataclasses.replace(s1, cancel_at_period_end=True))
        provider.throw_next = True
        await scheduler.tick(scheduler.SchedulerTickInput(provider=provider, repo=repo, policy=policy, ledger=ledger,
                                                          clock=clk("2024-02-01T01:00:00Z"), ids=SequentialIdGen("a_"), notifier=notifier))
        s1 = await repo.subscriptions.get("sub_1")
        await repo.subscriptions.put(dataclasses.replace(s1, cancel_at_period_end=False))
        # sub_1: declined -> payment.failed + grace.started; every retry declined -> payment.failed + grace.ending
        await scheduler.tick(scheduler.SchedulerTickInput(provider=provider, repo=repo, policy=policy, ledger=ledger,
                                                          clock=clk("2024-02-01T02:00:00Z"), ids=SequentialIdGen("b_"), notifier=notifier))
        for at in ("2024-02-02T03:00:00Z", "2024-02-05T04:00:00Z", "2024-02-07T05:00:00Z"):
            for item in await dunning.retry_due(dunning.RetryDueInput(repo=repo, clock=clk(at))):
                await dunning.run_retry(dunning.RunRetryInput(item=item, provider=provider, repo=repo, ledger=ledger, policy=policy,
                                                              notifier=notifier, clock=clk(at)))
        # grace ends -> grace.ending
        s1 = await repo.subscriptions.get("sub_1")
        await dunning.on_grace_expired(dunning.OnGraceExpiredInput(sub=s1, policy=policy, ledger=ledger, repo=repo, notifier=notifier,
                                                                   clock=clk("2024-02-09T00:00:00Z")))
        # credits about to expire -> credits.expiring
        await ledger.append(NewLedgerEntry(customer_id="c1", pool="paid", kind="grant", amount=50, source="topup", reference=LedgerReference(),
                                           idempotency_key="g1", actor="system", reason=None, unit_price_minor=None, currency=None,
                                           expires_at=d("2024-02-12T00:00:00Z")))
        await notify_expiring(NotifyExpiringInput(ledger=ledger, repo=repo, notifier=notifier, clock=clk("2024-02-10T00:00:00Z"),
                                                  policy=resolve_policy({"credits": {"expiryNoticeDays": 7}})))
        # a CS case escalated -> cs.needs_human
        case = await open_case(OpenCaseInput(customer_id="c1", kind="refund", reference_id="pay_1", policy=policy, repo=repo,
                                             clock=clk("2024-02-10T00:00:00Z"), ids=SequentialIdGen("c_")))
        await escalate(EscalateInput(case=case, repo=repo, clock=clk("2024-02-10T00:00:00Z"), notifier=notifier,
                                     reason="over the auto-approve limit"))

        types = sorted({n.type for n in notifier.sent})
        assert types == ["credits.expiring", "cs.needs_human", "grace.ending", "grace.started", "payment.failed"]
        assert sum(1 for n in notifier.sent if n.type == "payment.failed") > 1
        for n in notifier.sent:
            for locale in ("en", "ko"):
                out = render_notification(n, locale)
                assert not re.search(r"\{\w+\}", f"{out.subject} {out.text}"), (n.type, locale, n.payload, out.text)

    asyncio.run(body())

