"""Re-audit regressions for the self-scheduled renewal loop (EC:A29 A30 A31 A32); mirrors the TS test."""
from __future__ import annotations

import asyncio
import dataclasses
from datetime import UTC, datetime

from boilpayment_core import (
    CollectingNotifier,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    Money,
    Payment,
    Period,
    Plan,
    PlanPrice,
    SequentialIdGen,
    Subscription,
    resolve_policy,
)
from boilpayment_lifecycle.renewal import OnRenewalPaidInput, on_renewal_paid
from boilpayment_lifecycle.scheduler import SchedulerTickInput, tick
from helpers import FakeSelfSchedulingProvider


def _plan(pid: str, credits: int, amount: int, currency: str = "KRW") -> Plan:
    return Plan(id=pid, name=pid, interval="month", credits_per_period=credits, usage_included=0, trial_days=0,
                prices=[PlanPrice(currency=currency, amount_minor=amount)])


def _sub(sid: str, **extra) -> Subscription:
    base = {"id": sid, "customer_id": f"c_{sid}", "plan_id": "pro", "provider": "toss", "provider_ref": None,
            "status": "active", "current_period": Period(start=datetime(2024, 1, 1, tzinfo=UTC), end=datetime(2024, 2, 1, tzinfo=UTC)),
            "anchor_day": 1, "cancel_at_period_end": False, "grace_until": None, "billing_key": f"bk_{sid}",
            "scheduled_plan_id": None, "currency": "KRW", "created_at": datetime(2024, 1, 1, tzinfo=UTC)}
    base.update(extra)
    return Subscription(**base)


def _at(day: str) -> FixedClock:
    return FixedClock(datetime.fromisoformat(f"{day}T01:00:00+00:00"))


async def _setup(subs):
    repo = InMemoryRepo()
    for p in (_plan("pro", 1000, 50000), _plan("basic", 100, 5000)):
        await repo.plans.put(p)
    for s in subs:
        await repo.subscriptions.put(s)
    return repo, InMemoryLedger(SequentialIdGen("l_")), CollectingNotifier()


async def _end(repo, sid):
    return (await repo.subscriptions.get(sid)).current_period.end.date().isoformat()


def _tick(provider, repo, ledger, day, notifier=None, ids="i_"):
    return tick(SchedulerTickInput(provider=provider, repo=repo, ledger=ledger, policy=resolve_policy(),
                                   clock=_at(day), ids=SequentialIdGen(ids), notifier=notifier))


def test_ec_a29_scheduled_downgrade_renews_at_new_plan_price() -> None:
    async def run():
        repo, ledger, _ = await _setup([_sub("s1", scheduled_plan_id="basic")])
        provider = FakeSelfSchedulingProvider()
        await _tick(provider, repo, ledger, "2024-02-01")
        return (provider.last_charge["amount_minor"], (await repo.subscriptions.get("s1")).plan_id,
                (await ledger.balance("c_s1", None, datetime(2024, 2, 2, tzinfo=UTC))).available)

    assert asyncio.run(run()) == (5000, "basic", 100)


def test_ec_a30_unresolved_charge_reported_others_renew() -> None:
    class P(FakeSelfSchedulingProvider):
        async def charge_billing_key(self, **kw):
            p = await super().charge_billing_key(**kw)
            return dataclasses.replace(p, status="pending") if kw["billing_key"] == "bk_s1" else p

    async def run():
        repo, ledger, _ = await _setup([_sub("s1"), _sub("s2"), _sub("s3")])
        r = await _tick(P(), repo, ledger, "2024-02-01")
        return [(e.subscription_id, e.code) for e in r.errors], [await _end(repo, s) for s in ("s1", "s2", "s3")]

    assert asyncio.run(run()) == ([("s1", "scheduler_charge_unresolved")], ["2024-02-01", "2024-03-01", "2024-03-01"])


def test_ec_a30_succeeded_charge_resumed_without_second_charge() -> None:
    async def run():
        repo, ledger, _ = await _setup([_sub("s1")])
        state = {"fail": True, "charges": 0}
        real_append = ledger.append

        async def flaky_append(e):
            if state["fail"] and e.kind == "grant":
                state["fail"] = False
                raise RuntimeError("db blip")
            return await real_append(e)

        ledger.append = flaky_append  # type: ignore[method-assign]
        provider = FakeSelfSchedulingProvider()
        real_charge = provider.charge_billing_key

        async def counting(**kw):
            state["charges"] += 1
            return await real_charge(**kw)

        provider.charge_billing_key = counting  # type: ignore[method-assign]
        first = await _tick(provider, repo, ledger, "2024-02-01")
        await _tick(provider, repo, ledger, "2024-02-02", ids="j_")
        return ([e.subscription_id for e in first.errors], state["charges"], await _end(repo, "s1"),
                (await ledger.balance("c_s1", None, datetime(2024, 2, 3, tzinfo=UTC))).available, len(await repo.payments.list()))

    assert asyncio.run(run()) == (["s1"], 1, "2024-03-01", 1000, 1)


def test_ec_a31_missing_scheduled_plan_not_charged_person_told() -> None:
    async def run():
        repo, ledger, notifier = await _setup([_sub("s1", scheduled_plan_id="plan_deleted"), _sub("s2")])
        provider = FakeSelfSchedulingProvider()
        charges = {"n": 0}
        real_charge = provider.charge_billing_key

        async def counting(**kw):
            charges["n"] += 1
            return await real_charge(**kw)

        provider.charge_billing_key = counting  # type: ignore[method-assign]
        await _tick(provider, repo, ledger, "2024-02-01", notifier)
        told = any(n.type == "cs.needs_human" and n.payload.get("kind") == "plan_price_missing"
                   and n.payload.get("subscription_id") == "s1" for n in notifier.sent)
        return charges["n"], (await repo.subscriptions.get("s1")).status, await _end(repo, "s2"), told

    assert asyncio.run(run()) == (1, "past_due", "2024-03-01", True)


def test_ec_a31_missing_currency_goes_to_dunning_told_once() -> None:
    async def run():
        repo, ledger, notifier = await _setup([_sub("s1", currency="USD")])
        provider = FakeSelfSchedulingProvider()
        for day in ("2024-02-01", "2024-03-15"):
            await _tick(provider, repo, ledger, day, notifier, ids=f"i{day}")
        told = [n for n in notifier.sent if n.type == "cs.needs_human" and n.payload.get("kind") == "plan_price_missing"]
        return provider.last_charge, (await repo.subscriptions.get("s1")).status != "active", len(told)

    assert asyncio.run(run()) == (None, True, 1)


def test_ec_a32_late_payment_keeps_canceled_subscription_canceled() -> None:
    async def run():
        repo, ledger, _ = await _setup([_sub("s1", status="canceled")])
        s = await repo.subscriptions.get("s1")
        payment = Payment(id="pay_1", customer_id="c_s1", provider="toss", provider_ref="tx_1", subscription_id="s1",
                          amount=Money(amount_minor=50000, currency="KRW"), status="succeeded", kind="subscription",
                          period=Period(start=datetime(2024, 2, 1, tzinfo=UTC), end=datetime(2024, 3, 1, tzinfo=UTC)),
                          occurred_at=datetime(2024, 2, 1, tzinfo=UTC), failure=None)
        r = await on_renewal_paid(OnRenewalPaidInput(sub=s, payment=payment, policy=resolve_policy(), ledger=ledger,
                                                     repo=repo, clock=_at("2024-02-01")))
        return (r.sub.status, (await repo.subscriptions.get("s1")).status,
                (await ledger.balance("c_s1", None, datetime(2024, 2, 2, tzinfo=UTC))).available)

    assert asyncio.run(run()) == ("canceled", "canceled", 1000)
