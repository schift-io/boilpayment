"""Native subscription mutations need a remote ID; self scheduling does not."""
from __future__ import annotations

import asyncio
from datetime import UTC, datetime

import pytest
from helpers import FakeNativeProvider, FakeSelfSchedulingProvider
from schift_payment_kit_core import (
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    PaymentKitError,
    Period,
    Plan,
    PlanPrice,
    SequentialIdGen,
    Subscription,
    resolve_policy,
)
from schift_payment_kit_lifecycle import (
    CancelInput,
    DowngradeInput,
    ReactivateInput,
    UpgradeInput,
    cancel,
    downgrade,
    reactivate,
    upgrade,
)


@pytest.mark.parametrize("action", ["cancel", "upgrade", "downgrade", "reactivate", "self_cancel"])
def test_provider_reference_requirement(action):
    async def scenario():
        repo = InMemoryRepo()
        clock = FixedClock(datetime(2026, 1, 15, tzinfo=UTC))
        self_scheduled = action == "self_cancel"
        sub = Subscription(id="sub", customer_id="customer", plan_id="plan", provider="toss" if self_scheduled else "stripe", provider_ref=None, status="active", current_period=Period(start=datetime(2026, 1, 1, tzinfo=UTC), end=datetime(2026, 2, 1, tzinfo=UTC)), anchor_day=1, cancel_at_period_end=not self_scheduled, grace_until=None, billing_key="billing-key", scheduled_plan_id=None, created_at=clock.now())
        plan = Plan(id="plan", name="Plan", interval="month", credits_per_period=100, usage_included=0, trial_days=0, prices=[PlanPrice(currency="USD", amount_minor=1000)])
        await repo.plans.put(plan)
        await repo.subscriptions.put(sub)
        provider = FakeSelfSchedulingProvider() if self_scheduled else FakeNativeProvider()
        if not self_scheduled:
            provider.set_dummy_sub(sub)
        common = {"repo": repo, "clock": clock, "sub": sub, "ledger": InMemoryLedger(), "policy": resolve_policy({"downgrade": {"mode": "immediate_keep"}}), "provider": provider}
        async def invoke():
            if action in {"cancel", "self_cancel"}:
                return await cancel(CancelInput(**common))
            if action == "upgrade":
                return await upgrade(UpgradeInput(**common, new_plan=plan, ids=SequentialIdGen("id_")))
            if action == "downgrade":
                return await downgrade(DowngradeInput(**common, new_plan=plan, ids=SequentialIdGen("id_")))
            return await reactivate(ReactivateInput(**common))
        if self_scheduled:
            result = await invoke()
            assert result.sub.provider_ref is None
            assert result.sub.cancel_at_period_end
        else:
            with pytest.raises(PaymentKitError) as error:
                await invoke()
            assert error.value.code == "subscription_provider_ref_required"
            assert provider.cancel_subscription_called + provider.change_subscription_called + provider.uncancel_subscription_called == 0
    asyncio.run(scenario())
