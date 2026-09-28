"""EC:A76 (round-9 A9-5) -- a fully refunded upgrade charge puts the subscription back. Mirrors round9-upgrade-refund.test.ts."""

from __future__ import annotations

import asyncio
import dataclasses
from datetime import datetime

from boilpayment_core import InMemoryRepo, Money, Payment, Period, Subscription
from boilpayment_refund import revert_refunded_upgrade

UPGRADED = Subscription(
    id="s1", customer_id="c1", plan_id="pro", provider="portone", provider_ref=None, status="active",
    current_period=Period(start=datetime.fromisoformat("2026-04-11T00:00:00+00:00"), end=datetime.fromisoformat("2026-05-11T00:00:00+00:00")),
    anchor_day=11, cancel_at_period_end=False, grace_until=None, billing_key="bk1", scheduled_plan_id=None, currency="KRW",
    version=0, created_at=datetime.fromisoformat("2026-04-01T00:00:00+00:00"),
)


def row(status: str) -> Payment:
    return Payment(
        id="pay_up_1", customer_id="c1", provider="portone", provider_ref="ord_x", subscription_id="s1",
        amount=Money(amount_minor=13300, currency="KRW"), status=status, kind="subscription", period=None,  # type: ignore[arg-type]
        occurred_at=datetime.fromisoformat("2026-04-11T00:00:00+00:00"), failure=None, cash_receipt=None,
        raw={"boilpaymentUpgrade": {"chargeKey": "k", "planId": "pro", "fromPlanId": "basic", "fromPeriodStart": "2026-04-01T00:00:00.000Z",
                                    "fromPeriodEnd": "2026-05-01T00:00:00.000Z", "fromAnchorDay": 1}},
    )


def test_a76_full_refund_restores_plan_period_anchor() -> None:
    async def scenario() -> None:
        repo = InMemoryRepo()
        await repo.subscriptions.put(UPGRADED)
        await revert_refunded_upgrade(repo, row("refunded"))
        sub = await repo.subscriptions.get("s1")
        assert sub is not None
        assert (sub.plan_id, sub.current_period.start.isoformat(), sub.current_period.end.isoformat(), sub.anchor_day) == (
            "basic", "2026-04-01T00:00:00+00:00", "2026-05-01T00:00:00+00:00", 1)

    asyncio.run(scenario())


def test_a76_partial_or_changed_plan_is_untouched() -> None:
    async def scenario() -> None:
        repo = InMemoryRepo()
        await repo.subscriptions.put(UPGRADED)
        await revert_refunded_upgrade(repo, row("partially_refunded"))
        assert (await repo.subscriptions.get("s1")).plan_id == "pro"  # type: ignore[union-attr]
        await repo.subscriptions.put(dataclasses.replace(await repo.subscriptions.get("s1"), plan_id="max"))  # type: ignore[type-var]
        await revert_refunded_upgrade(repo, row("refunded"))
        assert (await repo.subscriptions.get("s1")).plan_id == "max"  # type: ignore[union-attr]

    asyncio.run(scenario())


def test_a80_refund_after_renewal_keeps_renewed_period() -> None:
    async def scenario() -> None:
        repo = InMemoryRepo()
        renewed = dataclasses.replace(UPGRADED, current_period=Period(
            start=datetime.fromisoformat("2026-05-11T00:00:00+00:00"), end=datetime.fromisoformat("2026-06-11T00:00:00+00:00")))
        await repo.subscriptions.put(renewed)
        await revert_refunded_upgrade(repo, row("refunded"))
        sub = await repo.subscriptions.get("s1")
        assert sub is not None
        assert (sub.plan_id, sub.current_period) == ("pro", renewed.current_period)

    asyncio.run(scenario())
