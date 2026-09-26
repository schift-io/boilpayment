"""Round-4 audit regressions (bp-audit4.md): EC:A37 A38 A39 A40 A41. Mirrors test/round4.test.ts."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from boilpayment_core import (
    CollectingNotifier,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    OutboxItem,
    Period,
    Plan,
    PlanPrice,
    SequentialIdGen,
    Subscription,
    resolve_policy,
)
from boilpayment_lifecycle import CancelInput, cancel, dunning, scheduler
from helpers import FakeSelfSchedulingProvider

RENEWAL_KEY = "charge:sub_1:2024-02-01T00:00:00.000Z"


def d(s: str) -> datetime:
    return datetime.fromisoformat(s).astimezone(UTC)


BASIC = Plan(id="basic", name="Basic", interval="month", credits_per_period=100, usage_included=0, trial_days=0,
             prices=[PlanPrice(currency="KRW", amount_minor=5000, provider_price_refs={})])


def mk_sub() -> Subscription:
    return Subscription(id="sub_1", customer_id="c1", plan_id="basic", provider="toss", provider_ref=None, status="active",
                        current_period=Period(start=d("2024-01-01T00:00:00Z"), end=d("2024-02-01T00:00:00Z")), anchor_day=1,
                        cancel_at_period_end=False, grace_until=None, billing_key="bk", scheduled_plan_id=None, version=0,
                        currency="KRW", created_at=d("2024-01-01T00:00:00Z"))


class T:
    def __init__(self) -> None:
        self.repo = InMemoryRepo()
        self.ledger = InMemoryLedger(SequentialIdGen("l_"))
        self.notifier = CollectingNotifier()
        self.provider = FakeSelfSchedulingProvider()
        self.provider.lookups = []
        self.policy = resolve_policy()

    async def init(self) -> T:
        await self.repo.plans.put(BASIC)
        await self.repo.subscriptions.put(mk_sub())
        return self

    async def tick(self, at: str):  # type: ignore[no-untyped-def]
        return await scheduler.tick(scheduler.SchedulerTickInput(provider=self.provider, repo=self.repo, ledger=self.ledger, policy=self.policy,
                                                                clock=FixedClock(d(at)), ids=SequentialIdGen("i_"), notifier=self.notifier))

    async def retries(self, at: str) -> list[str]:
        out = []
        for item in await dunning.retry_due(dunning.RetryDueInput(repo=self.repo, clock=FixedClock(d(at)))):
            r = await dunning.run_retry(dunning.RunRetryInput(item=item, provider=self.provider, repo=self.repo, ledger=self.ledger,
                                                              policy=self.policy, notifier=self.notifier, clock=FixedClock(d(at))))
            out.append(r.outcome)
        return out

    async def sweep(self, at: str) -> None:
        for s in await self.repo.subscriptions.list(status="past_due"):
            if s.grace_until and s.grace_until <= d(at):
                await dunning.on_grace_expired(dunning.OnGraceExpiredInput(sub=s, policy=self.policy, ledger=self.ledger, repo=self.repo,
                                                                           notifier=self.notifier, clock=FixedClock(d(at))))

    async def sub(self) -> Subscription:
        s = await self.repo.subscriptions.get("sub_1")
        assert s is not None
        return s

    async def usable(self, at: str) -> int:
        return (await self.ledger.balance("c1", None, d(at))).available

    def kinds(self) -> list[str]:
        return [n.payload.get("kind") for n in self.notifier.sent if isinstance(n.payload, dict) and n.payload.get("kind")]


def test_a38_late_success_after_grace_is_recorded_once() -> None:
    asyncio.run(_test_a38_late_success_after_grace_is_recorded_once())


async def _test_a38_late_success_after_grace_is_recorded_once() -> None:
    t = await T().init()
    t.provider.next_charge_status = "pending"
    await t.tick("2024-02-01T01:00:00Z")
    await t.sweep("2024-02-09T01:00:00Z")
    assert (await t.sub()).status == "expired"
    t.provider.settle(RENEWAL_KEY, "succeeded")
    r1 = await t.tick("2024-02-10T01:00:00Z")
    await t.tick("2024-02-11T01:00:00Z")
    assert [p.status for p in await t.repo.payments.list()] == ["succeeded"]
    assert await t.usable("2024-02-11T02:00:00Z") == 100
    assert (await t.sub()).status == "expired"
    assert t.kinds().count("renewal_settled_after_end") == 1
    assert r1.errors == []
    assert len(t.provider.order_ids) == 1


def test_a38_unknown_order_closed_as_failed() -> None:
    asyncio.run(_test_a38_unknown_order_closed_as_failed())


async def _test_a38_unknown_order_closed_as_failed() -> None:
    t = await T().init()
    t.provider.next_charge_throws = True
    await t.tick("2024-02-01T01:00:00Z")
    await t.sweep("2024-02-09T01:00:00Z")
    t.provider.next_charge_throws = False
    await t.tick("2024-02-10T01:00:00Z")
    assert [p.status for p in await t.repo.payments.list()] == ["failed"]
    assert len(t.provider.money_moved) == 0


def test_a40_canceled_while_past_due_is_not_charged() -> None:
    asyncio.run(_test_a40_canceled_while_past_due_is_not_charged())


async def _test_a40_canceled_while_past_due_is_not_charged() -> None:
    t = await T().init()
    t.provider.next_charge_status = "failed"
    await t.tick("2024-02-01T01:00:00Z")
    await cancel(CancelInput(sub=await t.sub(), policy=t.policy, provider=t.provider, ledger=t.ledger, repo=t.repo,
                             clock=FixedClock(d("2024-02-01T02:00:00Z"))))
    t.provider.next_charge_status = "succeeded"
    assert await t.retries("2024-02-02T02:00:00Z") == ["skipped"]
    await t.tick("2024-03-01T01:00:00Z")
    assert len(t.provider.money_moved) == 0
    assert (await t.sub()).status == "canceled"


def test_a41_unresolved_then_declined_starts_dunning() -> None:
    asyncio.run(_test_a41_unresolved_then_declined_starts_dunning())


async def _test_a41_unresolved_then_declined_starts_dunning() -> None:
    t = await T().init()
    t.provider.next_charge_status = "pending"
    await t.tick("2024-02-01T01:00:00Z")
    t.provider.settle(RENEWAL_KEY, "failed")
    await t.tick("2024-02-01T05:00:00Z")
    items = await t.repo.outbox.list()
    assert [i.id for i in items if i.status == "pending"] == ["dunning-retry-item:sub_1:1"]
    t.provider.next_charge_status = "succeeded"
    outcomes: list[str] = []
    for at in ["2024-02-02T06:00:00Z", "2024-02-04T06:00:00Z", "2024-02-07T06:00:00Z"]:
        await t.tick(at)
        outcomes += await t.retries(at)
    assert "recovered" in outcomes
    assert (await t.sub()).status == "active"
    assert len(t.provider.money_moved) == 1


def test_a37_two_concurrent_ticks_charge_once() -> None:
    asyncio.run(_test_a37_two_concurrent_ticks_charge_once())


async def _test_a37_two_concurrent_ticks_charge_once() -> None:
    t = await T().init()
    await asyncio.gather(t.tick("2024-02-01T01:00:00Z"), t.tick("2024-02-01T01:00:00Z"))
    assert len(t.provider.order_ids) == 1
    assert [p.status for p in await t.repo.payments.list()] == ["succeeded"]
    assert await t.usable("2024-02-01T02:00:00Z") == 100


def _legacy_item(created: str) -> OutboxItem:
    return OutboxItem(id="dunning-retry-item:sub_1:1", kind="dunning.retry", payload={"subscription_id": "sub_1", "attempt": 1},
                      status="sent", attempts=1, next_attempt_at=d("2024-02-02T01:00:00Z"), created_at=d(created))


def test_a39_legacy_dunning_charge_pays_the_period() -> None:
    asyncio.run(_test_a39_legacy_dunning_charge_pays_the_period())


async def _test_a39_legacy_dunning_charge_pays_the_period() -> None:
    t = await T().init()
    await t.repo.outbox.put(_legacy_item("2024-02-01T01:00:00Z"))
    t.provider.seed_order("dunning-retry:sub_1:1", "succeeded")
    await t.tick("2024-02-02T03:00:00Z")
    assert t.provider.order_ids == []
    assert (await t.sub()).current_period.end == d("2024-03-01T00:00:00Z")
    assert await t.usable("2024-02-02T04:00:00Z") == 100
    await t.tick("2024-03-01T01:00:00Z")
    assert len(t.provider.order_ids) == 1


def test_a39_unverifiable_legacy_charge_blocks_and_reports() -> None:
    asyncio.run(_test_a39_unverifiable_legacy_charge_blocks_and_reports())


async def _test_a39_unverifiable_legacy_charge_blocks_and_reports() -> None:
    t = await T().init()
    await t.repo.outbox.put(_legacy_item("2024-02-01T01:00:00Z"))
    t.provider.lookup_throws = True
    r = await t.tick("2024-02-02T03:00:00Z")
    assert [e.code for e in r.errors] == ["legacy_dunning_unverified"]
    r2 = await t.tick("2024-02-20T03:00:00Z")
    assert [e.code for e in r2.errors] == ["legacy_dunning_unverified"]
    assert t.provider.order_ids == []
    t.provider.lookup_throws = False
    await t.tick("2024-02-21T03:00:00Z")
    assert len(t.provider.order_ids) == 1
