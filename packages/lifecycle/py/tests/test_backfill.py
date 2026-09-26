"""spec: packages/lifecycle/spec/lifecycle.pseudo.md [EC:M1-M4] -- mirrors ts/test/backfill.test.ts"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime

import pytest
from boilpayment_core import (
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    Period,
    Plan,
    PlanPrice,
    SequentialIdGen,
    Subscription,
)
from boilpayment_lifecycle import (
    BACKFILL_COLUMNS,
    BackfillInput,
    BackfillRow,
    backfill,
    parse_backfill_file,
)
from helpers import FakeNativeProvider, FakeSelfSchedulingProvider

NOW = datetime(2026, 3, 10, tzinfo=UTC)
PLAN = Plan(
    id="pro",
    name="Pro",
    interval="month",
    credits_per_period=100,
    usage_included=0,
    trial_days=0,
    prices=[PlanPrice(currency="USD", amount_minor=1000)],
)


def run(coro):
    return asyncio.run(coro)


def remote(ref: str, customer_ref: str, status: str = "active") -> Subscription:
    return Subscription(
        id=ref,
        customer_id=customer_ref,
        plan_id="",
        provider="stripe",
        provider_ref=ref,
        status=status,  # type: ignore[arg-type]
        current_period=Period(
            start=datetime(2026, 3, 1, tzinfo=UTC), end=datetime(2026, 4, 1, tzinfo=UTC)
        ),
        anchor_day=1,
        cancel_at_period_end=False,
        grace_until=None,
        billing_key=None,
        scheduled_plan_id=None,
        version=0,
        created_at=NOW,
    )


class RemoteSubs(FakeNativeProvider):
    def __init__(self) -> None:
        super().__init__()
        self.subs: dict[str, Subscription] = {}

    async def get_subscription(self, provider_ref: str) -> Subscription:
        return self.subs[provider_ref]


def row(**p) -> BackfillRow:
    base = {
        "customer_id": "u1",
        "email": "u1@example.com",
        "provider": "stripe",
        "customer_ref": "cus_1",
    }
    base.update(p)
    return BackfillRow(**base)


async def setup():
    repo = InMemoryRepo()
    await repo.plans.put(PLAN)
    ledger = InMemoryLedger(SequentialIdGen("led_"))
    stripe = RemoteSubs()
    stripe.subs = {
        "sub_1": remote("sub_1", "cus_1"),
        "sub_other": remote("sub_other", "cus_someone_else"),
        "sub_dead": remote("sub_dead", "cus_1", "canceled"),
    }
    deps = {
        "repo": repo,
        "ledger": ledger,
        "providers": {"stripe": stripe, "toss": FakeSelfSchedulingProvider()},
        "clock": FixedClock(NOW),
        "ids": SequentialIdGen("sub_local_"),
    }
    return deps


def go(deps, rows):
    return backfill(BackfillInput(rows=rows, **deps))


def test_native_subscription_state_comes_from_provider():
    async def body():
        d = await setup()
        report = await go(d, [row(subscription_ref="sub_1", plan_id="pro", credits=40)])
        assert (report.ok, report.errors) == (1, 0)
        r = report.results[0]
        assert (r.customer, r.subscription, r.credits) == (
            "created",
            "created",
            "created",
        )
        [sub] = await d["repo"].subscriptions.list(
            provider="stripe", provider_ref="sub_1"
        )
        assert (sub.customer_id, sub.plan_id, sub.status, sub.anchor_day) == (
            "u1",
            "pro",
            "active",
            1,
        )
        assert sub.current_period.end == datetime(2026, 4, 1, tzinfo=UTC)
        assert (await d["ledger"].balance("u1", "paid", NOW)).available == 40

    run(body())


def test_rerun_writes_nothing_new():
    async def body():
        d = await setup()
        rows = [row(subscription_ref="sub_1", plan_id="pro", credits=40)]
        await go(d, rows)
        r = (await go(d, rows)).results[0]
        assert (r.status, r.customer, r.subscription, r.credits) == (
            "ok",
            "skipped",
            "skipped",
            "skipped",
        )
        assert len(await d["repo"].subscriptions.list()) == 1
        assert (await d["ledger"].balance("u1", "paid", NOW)).available == 40

    run(body())


def test_self_scheduled_uses_billing_key_and_file_period():
    async def body():
        d = await setup()
        r = row(
            provider="toss",
            customer_ref="ck_1",
            billing_key="bk_1",
            plan_id="pro",
            period_start=datetime(2026, 3, 5, tzinfo=UTC),
            period_end=datetime(2026, 4, 5, tzinfo=UTC),
        )
        assert (await go(d, [r])).results[0].subscription == "created"
        [sub] = await d["repo"].subscriptions.list(customer_id="u1", provider="toss")
        assert (sub.provider_ref, sub.billing_key, sub.status, sub.anchor_day) == (
            None,
            "bk_1",
            "active",
            5,
        )
        assert (await go(d, [r])).results[0].subscription == "skipped"

    run(body())


def test_second_provider_adds_provider_ref():
    async def body():
        d = await setup()
        await go(d, [row(credits=5)])
        r = (await go(d, [row(provider="toss", customer_ref="ck_1")])).results[0]
        assert r.customer == "updated"
        assert len((await d["repo"].customers.get("u1")).provider_refs) == 2

    run(body())


@pytest.mark.parametrize(
    ("patch", "reason"),
    [
        ({"subscription_ref": "sub_1", "plan_id": "enterprise"}, "unknown_plan"),
        ({"subscription_ref": "sub_1"}, "missing_plan_id"),
        (
            {"subscription_ref": "sub_other", "plan_id": "pro"},
            "provider_customer_mismatch",
        ),
        ({"subscription_ref": "sub_dead", "plan_id": "pro"}, "subscription_not_live"),
        (
            {"provider": "polar", "subscription_ref": "x", "plan_id": "pro"},
            "provider_not_configured",
        ),
        (
            {"billing_key": "bk", "plan_id": "pro"},
            "billing_key_needs_self_scheduled_provider",
        ),
        (
            {"provider": "toss", "subscription_ref": "x", "plan_id": "pro"},
            "provider_has_no_native_subscriptions",
        ),
        ({"provider": "toss", "billing_key": "bk", "plan_id": "pro"}, "invalid_period"),
        ({"credits": -3}, "invalid_credits"),
    ],
)
def test_refused_rows_write_nothing(patch, reason):
    async def body():
        d = await setup()
        patch.setdefault("credits", 10)
        r = (await go(d, [row(**patch)])).results[0]
        assert (r.status, r.reason, r.customer, r.credits) == (
            "error",
            reason,
            "none",
            "none",
        )
        assert await d["repo"].customers.get("u1") is None
        assert (await d["ledger"].balance("u1", "paid", NOW)).available == 0

    run(body())


def test_subscription_owned_by_other_customer_is_refused():
    async def body():
        d = await setup()
        await go(d, [row(subscription_ref="sub_1", plan_id="pro")])
        r = (
            await go(
                d, [row(customer_id="u2", subscription_ref="sub_1", plan_id="pro")]
            )
        ).results[0]
        assert (r.status, r.reason) == ("error", "subscription_owned_by_other_customer")

    run(body())


def test_parses_csv_and_json():
    csv_text = (
        ",".join(BACKFILL_COLUMNS)
        + '\nu1,a@b.co,stripe,cus_1,sub_1,pro,,,,"12",2026-12-31T00:00:00Z\n'
    )
    [c] = parse_backfill_file(csv_text)
    assert (c.customer_id, c.subscription_ref, c.billing_key, c.credits) == (
        "u1",
        "sub_1",
        None,
        12,
    )
    assert c.credits_expire_at == datetime(2026, 12, 31, tzinfo=UTC)
    [j] = parse_backfill_file(
        json.dumps(
            [
                {
                    "customer_id": "u2",
                    "provider": "toss",
                    "customer_ref": "ck",
                    "billing_key": "bk",
                    "period_start": "2026-03-01",
                    "period_end": "2026-04-01",
                }
            ]
        )
    )
    assert (j.customer_id, j.provider, j.billing_key, j.credits) == (
        "u2",
        "toss",
        "bk",
        None,
    )


def test_ec_a28_backfill_sets_subscription_currency():
    import dataclasses

    async def run():
        deps = await setup()
        deps["providers"]["stripe"].subs["sub_1"] = dataclasses.replace(remote("sub_1", "cus_1"), currency="KRW")
        period = {"period_start": datetime(2026, 3, 1, tzinfo=UTC), "period_end": datetime(2026, 4, 1, tzinfo=UTC)}
        await go(deps, [
            row(subscription_ref="sub_1", plan_id="pro"),
            row(customer_id="u2", customer_ref="ck_2", provider="toss", plan_id="pro", billing_key="bk_2", **period),
            row(customer_id="u3", customer_ref="ck_3", provider="toss", plan_id="pro", billing_key="bk_3", currency="EUR", **period),
        ])
        return {s.customer_id: s.currency for s in await deps["repo"].subscriptions.list()}

    assert asyncio.run(run()) == {"u1": "KRW", "u2": "USD", "u3": "EUR"}
