"""spec: packages/lifecycle/spec/lifecycle.pseudo.md -- EC:A71 A72 (round-9 A9-4 A9-8 A9-9). Mirrors round9-lifecycle.test.ts."""

from __future__ import annotations

import asyncio
import dataclasses
from datetime import datetime
from typing import Any

import pytest
from boilpayment_core import (
    Customer,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    Money,
    Payment,
    PaymentKitError,
    Period,
    Plan,
    PlanPrice,
    SequentialIdGen,
    Subscription,
    resolve_policy,
)
from boilpayment_lifecycle import (
    OnRenewalPaidInput,
    ReactivateInput,
    StartSubscriptionInput,
    UpgradeInput,
    on_renewal_paid,
    reactivate,
    scheduler,
    start_subscription,
    upgrade,
)
from helpers import FakeNativeProvider, FakeSelfSchedulingProvider

BASIC = Plan(id="basic", name="Basic", interval="month", credits_per_period=1000, usage_included=0, trial_days=0,
             prices=[PlanPrice(currency="KRW", amount_minor=9900)])
PRO = Plan(id="pro", name="Pro", interval="month", credits_per_period=3000, usage_included=0, trial_days=0,
           prices=[PlanPrice(currency="KRW", amount_minor=19900)])
SEOUL = resolve_policy({"period": {"timezone": "Asia/Seoul"}})


def d(s: str) -> datetime:
    return datetime.fromisoformat(s)


async def code(aw: Any) -> str:
    try:
        await aw
    except PaymentKitError as err:
        return err.code
    return "ok"


async def base(at: str, policy=SEOUL):  # type: ignore[no-untyped-def]
    repo, ledger = InMemoryRepo(), InMemoryLedger(SequentialIdGen("l_"))
    for p in (BASIC, PRO):
        await repo.plans.put(p)
    return repo, ledger, FakeSelfSchedulingProvider(), FixedClock(d(at)), policy


def start(env, request_id: str):  # type: ignore[no-untyped-def]
    repo, ledger, provider, clock, policy = env
    return start_subscription(StartSubscriptionInput(
        customer_id="u1", plan_id="basic", currency="KRW", billing_key="bk1", request_id=request_id, provider=provider,
        policy=policy, ledger=ledger, repo=repo, clock=clock))


@pytest.mark.parametrize(("at", "end", "anchor"), [
    ("2026-04-30T20:00:00Z", "2026-05-31T20:00:00Z", 1),
    ("2026-12-31T16:00:00Z", "2027-01-31T16:00:00Z", 1),
    ("2026-01-30T16:00:00Z", "2026-02-27T16:00:00Z", 31),
])
def test_a71_seoul_first_period_is_one_month(at: str, end: str, anchor: int) -> None:
    async def scenario() -> None:
        res = await start(await base(at), "r1")
        assert res.sub.current_period == Period(start=d(at), end=d(end))
        assert res.sub.anchor_day == anchor

    asyncio.run(scenario())


def test_a71_utc_policy_keeps_utc_day() -> None:
    async def scenario() -> None:
        res = await start(await base("2026-04-30T20:00:00Z", resolve_policy()), "r1")
        assert res.sub.current_period.end == d("2026-05-30T20:00:00Z")

    asyncio.run(scenario())


def test_a71_reset_anchor_upgrade_in_seoul() -> None:
    async def scenario() -> None:
        repo, ledger, provider, clock, policy = await base("2026-04-30T20:00:00Z")
        await repo.subscriptions.put(Subscription(
            id="s1", customer_id="c1", plan_id="basic", provider="toss", provider_ref=None, status="active",
            current_period=Period(start=d("2026-04-14T15:00:00Z"), end=d("2026-05-14T15:00:00Z")), anchor_day=15,
            cancel_at_period_end=False, grace_until=None, billing_key="bk1", scheduled_plan_id=None, currency="KRW",
            version=0, created_at=d("2026-04-14T15:00:00Z")))
        stored = await repo.subscriptions.get("s1")
        res = await upgrade(UpgradeInput(sub=stored, new_plan=PRO, policy=policy, provider=provider, ledger=ledger,
                                         repo=repo, clock=clock, ids=SequentialIdGen("id_")))
        assert res.sub.current_period == Period(start=d("2026-04-30T20:00:00Z"), end=d("2026-05-31T20:00:00Z"))

    asyncio.run(scenario())


def test_a72_deny_refuses_second_signup() -> None:
    async def scenario() -> None:
        env = await base("2026-04-11T03:00:00Z")
        await start(env, "a")
        assert await code(start(env, "b")) == "subscription_exists"
        assert len(await env[0].subscriptions.list()) == 1

    asyncio.run(scenario())


def test_a72_deny_concurrent_signups_leave_one() -> None:
    async def scenario() -> None:
        env = await base("2026-04-11T03:00:00Z")
        results = await asyncio.gather(start(env, "x"), start(env, "y"), return_exceptions=True)
        assert sum(1 for r in results if not isinstance(r, BaseException)) == 1
        assert len(await env[0].subscriptions.list()) == 1

    asyncio.run(scenario())


def test_a72_declined_signup_closed_and_next_allowed() -> None:
    async def scenario() -> None:
        env = await base("2026-04-11T03:00:00Z")
        env[2].next_charge_http_error = 402
        assert await code(start(env, "d1")) == "subscription_start_declined"
        assert await code(start(env, "d1")) == "subscription_start_declined"
        env[2].next_charge_http_error = None
        ok = await start(env, "d2")
        assert ok.sub.status == "active"
        assert sorted(s.status for s in await env[0].subscriptions.list()) == ["active", "expired"]

    asyncio.run(scenario())


async def banned(at: str = "2026-05-01T01:00:00Z"):  # type: ignore[no-untyped-def]
    repo, ledger, provider, clock, policy = await base(at, resolve_policy())
    await repo.customers.put(Customer(id="c1", email=None, provider_refs=[], status="banned", created_at=d("2026-01-01T00:00:00Z")))
    await repo.subscriptions.put(Subscription(
        id="s1", customer_id="c1", plan_id="basic", provider="toss", provider_ref=None, status="active",
        current_period=Period(start=d("2026-04-01T00:00:00Z"), end=d("2026-05-01T00:00:00Z")), anchor_day=1,
        cancel_at_period_end=False, grace_until=None, billing_key="bk1", scheduled_plan_id=None, currency="KRW",
        version=0, created_at=d("2026-04-01T00:00:00Z")))
    return repo, ledger, provider, clock, policy


def test_a73_scheduler_does_not_charge_banned_customer() -> None:
    async def scenario() -> None:
        repo, ledger, provider, clock, policy = await banned()
        res = await scheduler.tick(scheduler.SchedulerTickInput(provider=provider, repo=repo, policy=policy, ledger=ledger,
                                                                clock=clock, ids=SequentialIdGen("id_")))
        assert [e.code for e in res.errors] == ["customer_banned"]
        assert provider.order_ids == []
        assert await repo.payments.list() == []

    asyncio.run(scenario())


def test_a73_reactivate_refused_for_banned_customer() -> None:
    async def scenario() -> None:
        repo, ledger, provider, clock, policy = await banned("2026-04-20T00:00:00Z")
        stored = await repo.subscriptions.get("s1")
        await repo.subscriptions.put(dataclasses.replace(stored, status="canceled"))
        stored = await repo.subscriptions.get("s1")
        assert await code(reactivate(ReactivateInput(sub=stored, policy=policy, provider=provider, ledger=ledger, repo=repo,
                                                     clock=clock))) == "customer_banned"
        assert (await repo.subscriptions.get("s1")).status == "canceled"

    asyncio.run(scenario())


class OnPaymentProvider(FakeNativeProvider):
    def capabilities(self):  # type: ignore[no-untyped-def]
        return dataclasses.replace(super().capabilities(), upgrade_grant="on_payment")


def _pay(pid: str, amount: int) -> Payment:
    return Payment(id=pid, customer_id="c1", provider="stripe", provider_ref=f"ref_{pid}", subscription_id="s1",
                   amount=Money(amount_minor=amount, currency="KRW"), status="succeeded", kind="subscription", period=None,
                   occurred_at=d("2026-04-11T00:00:00Z"), failure=None, cash_receipt=None)


def test_a77_on_payment_upgrade_grants_when_change_order_paid() -> None:
    async def scenario() -> None:
        repo, ledger, _provider, clock, _ = await base("2026-04-11T00:00:00Z")
        policy = resolve_policy({"upgrade": {"mode": "immediate_prorate_keep_anchor"}})
        sub = Subscription(
            id="s1", customer_id="c1", plan_id="basic", provider="stripe", provider_ref="ps_1", status="active",
            current_period=Period(start=d("2026-04-01T00:00:00Z"), end=d("2026-05-01T00:00:00Z")), anchor_day=1,
            cancel_at_period_end=False, grace_until=None, billing_key=None, scheduled_plan_id=None, currency="KRW",
            version=0, created_at=d("2026-04-01T00:00:00Z"))
        await repo.subscriptions.put(sub)

        async def paid(p: Payment) -> None:
            await on_renewal_paid(OnRenewalPaidInput(sub=await repo.subscriptions.get("s1"), payment=p, policy=policy,  # type: ignore[arg-type]
                                                     ledger=ledger, repo=repo, clock=clock))

        async def balance() -> int:
            return (await ledger.balance("c1", "paid", clock.now())).available

        cycle = _pay("pay_cycle", 9900)
        await paid(cycle)
        provider = OnPaymentProvider()
        provider.set_dummy_sub(sub)
        res = await upgrade(UpgradeInput(sub=await repo.subscriptions.get("s1"), new_plan=PRO, policy=policy, provider=provider,  # type: ignore[arg-type]
                                         ledger=ledger, repo=repo, clock=clock, ids=SequentialIdGen("id_")))
        assert res.grant is None and await balance() == 1000
        await paid(cycle)
        assert await balance() == 1000
        change = _pay("pay_change", 6666)
        await paid(change)
        await paid(change)
        assert await balance() == 3000

    asyncio.run(scenario())


def test_a82_change_order_paid_before_change_returns_still_grants_once() -> None:
    async def scenario() -> None:
        repo, ledger, _provider, clock, _ = await base("2026-04-11T00:00:00Z")
        policy = resolve_policy({"upgrade": {"mode": "immediate_prorate_keep_anchor"}})
        sub = Subscription(
            id="s1", customer_id="c1", plan_id="basic", provider="stripe", provider_ref="ps_1", status="active",
            current_period=Period(start=d("2026-04-01T00:00:00Z"), end=d("2026-05-01T00:00:00Z")), anchor_day=1,
            cancel_at_period_end=False, grace_until=None, billing_key=None, scheduled_plan_id=None, currency="KRW",
            version=0, created_at=d("2026-04-01T00:00:00Z"))
        await repo.subscriptions.put(sub)

        async def paid(p: Payment) -> None:
            await on_renewal_paid(OnRenewalPaidInput(sub=await repo.subscriptions.get("s1"), payment=p, policy=policy,  # type: ignore[arg-type]
                                                     ledger=ledger, repo=repo, clock=clock))

        await paid(_pay("pay_cycle", 9900))

        class EarlyWebhookProvider(OnPaymentProvider):
            async def change_subscription(self, ref, **kw):  # type: ignore[no-untyped-def,override]
                await paid(_pay("pay_change", 6666))  # the change order's webhook lands mid-call
                return await super().change_subscription(ref, **kw)

        provider = EarlyWebhookProvider()
        provider.set_dummy_sub(sub)
        await upgrade(UpgradeInput(sub=await repo.subscriptions.get("s1"), new_plan=PRO, policy=policy, provider=provider,  # type: ignore[arg-type]
                                   ledger=ledger, repo=repo, clock=clock, ids=SequentialIdGen("id_")))
        assert (await ledger.balance("c1", "paid", clock.now())).available == 3000

    asyncio.run(scenario())
