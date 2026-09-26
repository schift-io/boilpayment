"""[EC:A28] Renewals, dunning retries and upgrade proration charge the plan price in the
subscription's currency; a plan without that currency is refused."""
from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from boilpayment_core import (
    CollectingNotifier,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    Period,
    Plan,
    PlanPrice,
    SequentialIdGen,
    Subscription,
    resolve_policy,
)
from boilpayment_lifecycle.dunning import (
    OnPaymentFailedInput,
    RetryDueInput,
    RunRetryInput,
    on_payment_failed,
    retry_due,
    run_retry,
)
from boilpayment_lifecycle.internal import resolve_price_ref
from boilpayment_lifecycle.scheduler import SchedulerTickInput, tick
from boilpayment_lifecycle.upgrade import UpgradeInput, upgrade
from helpers import FakeSelfSchedulingProvider

PLAN_A = Plan(id="plan_a", name="A", interval="month", credits_per_period=100, usage_included=0, trial_days=0,
              prices=[PlanPrice(currency="USD", amount_minor=1000, provider_price_refs={"stripe": "price_a_usd"}),
                      PlanPrice(currency="KRW", amount_minor=13000, provider_price_refs={"stripe": "price_a_krw"})])
PLAN_B = Plan(id="plan_b", name="B", interval="month", credits_per_period=300, usage_included=0, trial_days=0,
              prices=[PlanPrice(currency="USD", amount_minor=3000, provider_price_refs={"stripe": "price_b_usd"}),
                      PlanPrice(currency="KRW", amount_minor=39000, provider_price_refs={"stripe": "price_b_krw"})])


def mk_sub(**o) -> Subscription:
    base = {"id": "sub_1", "customer_id": "cust_1", "plan_id": "plan_a", "provider": "toss", "provider_ref": None,
            "status": "active", "current_period": Period(start=datetime(2024, 1, 1, tzinfo=UTC), end=datetime(2024, 2, 1, tzinfo=UTC)),
            "anchor_day": 1, "cancel_at_period_end": False, "grace_until": None, "billing_key": "bk_1",
            "scheduled_plan_id": None, "currency": "KRW", "created_at": datetime(2024, 1, 1, tzinfo=UTC)}
    base.update(o)
    return Subscription(**base)


async def _repo():
    repo = InMemoryRepo()
    await repo.plans.put(PLAN_A)
    await repo.plans.put(PLAN_B)
    return repo


def test_ec_a28_renewal_and_missing_currency() -> None:
    async def run():
        out = []
        for cur in ("KRW", "EUR"):
            repo = await _repo()
            await repo.subscriptions.put(mk_sub(currency=cur))
            p = FakeSelfSchedulingProvider()
            res = await tick(SchedulerTickInput(provider=p, repo=repo, policy=resolve_policy(), ledger=InMemoryLedger(SequentialIdGen("l_")),
                                                clock=FixedClock(datetime(2024, 2, 1, tzinfo=UTC)), ids=SequentialIdGen("id_")))
            out.append((p.last_charge and (p.last_charge["currency"], p.last_charge["amount_minor"]), len(res.failed)))
        return out

    assert asyncio.run(run()) == [(("KRW", 13000), 0), (None, 1)]


def test_ec_a28_dunning_retry_and_upgrade_use_krw() -> None:
    async def run():
        repo = await _repo()
        sub = mk_sub(status="past_due")
        await repo.subscriptions.put(sub)
        policy = resolve_policy({"dunning": {"retryAttempts": 3, "retryIntervalHours": [24]}})
        notifier = CollectingNotifier()
        await on_payment_failed(OnPaymentFailedInput(sub=sub, policy=policy, repo=repo, notifier=notifier, clock=FixedClock(datetime(2024, 1, 16, tzinfo=UTC))))
        clock2 = FixedClock(datetime(2024, 1, 17, 0, 0, 0, 1000, tzinfo=UTC))
        [item] = await retry_due(RetryDueInput(repo=repo, clock=clock2))
        p = FakeSelfSchedulingProvider()
        await run_retry(RunRetryInput(item=item, provider=p, repo=repo, ledger=InMemoryLedger(SequentialIdGen("l_")), policy=policy, notifier=notifier, clock=clock2))
        retry = (p.last_charge["currency"], p.last_charge["amount_minor"])
        repo2 = await _repo()
        sub2 = mk_sub()
        await repo2.subscriptions.put(sub2)
        p2 = FakeSelfSchedulingProvider()
        await upgrade(UpgradeInput(sub=sub2, new_plan=PLAN_B, policy=resolve_policy(), provider=p2, ledger=InMemoryLedger(SequentialIdGen("l_")),
                                   repo=repo2, clock=FixedClock(datetime(2024, 1, 16, tzinfo=UTC)), ids=SequentialIdGen("id_")))
        return retry, p2.last_charge["currency"]

    assert asyncio.run(run()) == (("KRW", 13000), "KRW")


def test_ec_a28_price_ref_follows_currency() -> None:
    assert [resolve_price_ref(PLAN_B, "stripe", "KRW"), resolve_price_ref(PLAN_B, "stripe", "USD"), resolve_price_ref(PLAN_B, "stripe")] == [
        "price_b_krw", "price_b_usd", "price_b_usd"]
