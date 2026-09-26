"""[EC:A34 A35 A36] Self-scheduled renewal + dunning as one charge state machine per (subscription,
period). Ported from the round-3 audit PoCs (POC10, POC8a/b/c, toss-orderid, N11). Mirrors
test/renewal-attempts.test.ts."""

from __future__ import annotations

import asyncio
import re
from datetime import UTC, datetime

from boilpayment_core import (
    CollectingNotifier,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    SequentialIdGen,
    resolve_policy,
)
from boilpayment_lifecycle import provider_order_id
from boilpayment_lifecycle.dunning import (
    RetryDueInput,
    RunRetryInput,
    retry_due,
    run_retry,
)
from boilpayment_lifecycle.scheduler import SchedulerTickInput, tick
from helpers import FakeSelfSchedulingProvider
from test_scheduler import PLAN, mk_sub


def _at(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


class _Env:
    def __init__(self) -> None:
        self.repo = InMemoryRepo()
        self.ledger = InMemoryLedger(SequentialIdGen("l_"))
        self.notifier = CollectingNotifier()
        self.provider = FakeSelfSchedulingProvider()
        self.policy = resolve_policy()

    async def init(self) -> _Env:
        await self.repo.plans.put(PLAN)
        await self.repo.subscriptions.put(mk_sub())
        return self

    async def tick(self, at: str):
        return await tick(
            SchedulerTickInput(
                provider=self.provider,
                repo=self.repo,
                policy=self.policy,
                ledger=self.ledger,
                clock=FixedClock(_at(at)),
                ids=SequentialIdGen("i_"),
                notifier=self.notifier,
            )
        )

    async def usable(self, at: str) -> int:
        return (await self.ledger.balance("cust_1", None, _at(at))).available

    async def retry(self, at: str):
        clock = FixedClock(_at(at))
        [item] = await retry_due(RetryDueInput(repo=self.repo, clock=clock))
        return await run_retry(
            RunRetryInput(
                item=item,
                provider=self.provider,
                repo=self.repo,
                ledger=self.ledger,
                policy=self.policy,
                notifier=self.notifier,
                clock=clock,
            )
        )


def test_ec_a34_poc10_dunning_recovery_pays_for_and_grants_the_renewal_period() -> None:
    async def run():
        env = await _Env().init()
        env.provider.next_charge_status = "failed"
        await env.tick("2024-02-01T01:00:00Z")
        env.provider.next_charge_status = "succeeded"
        r = await env.retry("2024-02-02T02:00:00Z")
        sub = await env.repo.subscriptions.get("sub_1")
        rows = sorted(
            (p.status, p.period.start.isoformat())
            for p in await env.repo.payments.list()
        )
        usable = await env.usable("2024-02-02T03:00:00Z")
        t = await env.tick("2024-02-02T04:00:00Z")
        return (
            r.outcome,
            sub.status,
            sub.current_period.start.isoformat(),
            sub.current_period.end.isoformat(),
            usable,
            rows,
            len(t.charged),
            len(env.provider.money_moved),
        )

    assert asyncio.run(run()) == (
        "recovered",
        "active",
        "2024-02-01T00:00:00+00:00",
        "2024-03-01T00:00:00+00:00",
        100,
        [
            ("failed", "2024-02-01T00:00:00+00:00"),
            ("succeeded", "2024-02-01T00:00:00+00:00"),
        ],
        0,
        1,
    )


def test_ec_a34_poc8b_payment_row_write_fails_after_money_moved() -> None:
    async def run():
        env = await _Env().init()
        put = env.repo.payments.put
        calls = {"n": 0}

        async def flaky(p):
            calls["n"] += 1
            if calls["n"] == 2:  # the write after the charge
                raise RuntimeError("db down")
            return await put(p)

        env.repo.payments.put = flaky  # type: ignore[method-assign]
        first = await env.tick("2024-02-01T01:00:00Z")
        await env.tick("2024-02-02T01:00:00Z")
        await env.tick("2024-02-03T01:00:00Z")
        return (
            [e.code for e in first.errors],
            len(env.provider.money_moved),
            [p.status for p in await env.repo.payments.list()],
            await env.usable("2024-02-03T02:00:00Z"),
        )

    assert asyncio.run(run()) == (["scheduler_error"], 1, ["succeeded"], 100)


def test_ec_a36_poc8c_pending_enters_grace_once_and_is_redriven() -> None:
    async def run():
        env = await _Env().init()
        env.provider.next_charge_status = "pending"
        first = await env.tick("2024-02-01T01:00:00Z")
        sub = await env.repo.subscriptions.get("sub_1")
        await env.tick("2024-02-02T01:00:00Z")
        await env.tick("2024-02-03T01:00:00Z")
        ids = {p.id for p in await env.repo.payments.list()}
        human = [m for m in env.notifier.sent if m.type == "cs.needs_human"]
        failed_notices = [m for m in env.notifier.sent if m.type == "payment.failed"]
        env.provider.settle(env.provider.last_charge["idempotency_key"], "succeeded")
        done = await env.tick("2024-02-04T01:00:00Z")
        final = await env.repo.subscriptions.get("sub_1")
        return (
            [e.code for e in first.errors],
            sub.status,
            sub.grace_until.isoformat(),
            len(ids),
            len(human),
            len(failed_notices),
            len(done.charged),
            final.status,
            len(env.provider.money_moved),
            await env.usable("2024-02-04T02:00:00Z"),
        )

    assert asyncio.run(run()) == (
        ["scheduler_charge_unresolved"],
        "past_due",
        "2024-02-08T01:00:00+00:00",
        1,
        1,
        0,
        1,
        "active",
        1,
        100,
    )


def test_ec_a34_n11_dunning_retry_without_answer_is_not_a_decline() -> None:
    async def run():
        env = await _Env().init()
        env.provider.next_charge_status = "failed"
        await env.tick("2024-02-01T01:00:00Z")
        before = len([m for m in env.notifier.sent if m.type == "payment.failed"])
        env.provider.next_charge_throws = True
        r = await env.retry("2024-02-02T02:00:00Z")
        after = len([m for m in env.notifier.sent if m.type == "payment.failed"])
        items = [(i.status, i.payload["attempt"]) for i in await env.repo.outbox.list()]
        first_key = env.provider.last_charge["idempotency_key"]
        env.provider.next_charge_throws = False
        env.provider.next_charge_status = "succeeded"
        r2 = await env.retry("2024-02-05T02:00:00Z")
        return (
            r.outcome,
            after - before,
            items,
            r2.outcome,
            env.provider.last_charge["idempotency_key"] == first_key,
            len(env.provider.money_moved),
        )

    assert asyncio.run(run()) == (
        "unresolved",
        0,
        [("pending", 1)],
        "recovered",
        True,
        1,
    )


def test_ec_a34_provider_4xx_is_a_decline_5xx_is_not() -> None:
    async def run():
        env = await _Env().init()
        env.provider.next_charge_http_error = 503
        first = await env.tick("2024-02-01T01:00:00Z")
        after_503 = [p.status for p in await env.repo.payments.list()]
        env.provider.next_charge_http_error = 400
        await env.tick("2024-02-02T01:00:00Z")
        return (
            [e.code for e in first.errors],
            after_503,
            [p.status for p in await env.repo.payments.list()],
        )

    assert asyncio.run(run()) == (
        ["scheduler_charge_unresolved"],
        ["pending"],
        ["failed"],
    )


def test_ec_a35_order_ids_fit_toss_and_portone() -> None:
    async def run():
        env = await _Env().init()
        env.provider.next_charge_status = "failed"
        await env.tick("2024-02-01T01:00:00Z")
        await env.retry("2024-02-02T02:00:00Z")
        return env.provider.order_ids

    ids = asyncio.run(run())
    assert len(ids) == 2
    assert all(re.fullmatch(r"[A-Za-z0-9_-]{6,64}", i) for i in ids)
    # Same key -> same orderId as the TS kit.
    assert provider_order_id(
        "charge:sub_7f3c2a1e-5b7d-4c1a-9a55-2f0d7e6b1c42:2024-02-01T00:00:00.000Z"
    ).startswith("ord_")
