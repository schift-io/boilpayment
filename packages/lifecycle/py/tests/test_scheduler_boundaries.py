"""EC:F — unknown outcomes cannot be treated as confirmed failed payments."""

from dataclasses import replace
from datetime import UTC, datetime
from unittest.mock import AsyncMock

import pytest
from helpers import FakeSelfSchedulingProvider
from schift_payment_kit_core import (
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    PaymentKitError,
    Period,
    SequentialIdGen,
    resolve_policy,
)
from schift_payment_kit_lifecycle.scheduler import (
    DueSubscriptionsInput,
    SchedulerTickInput,
    due_subscriptions,
    tick,
)
from test_scheduler import PLAN, mk_sub, run


async def setup() -> SchedulerTickInput:
    repo = InMemoryRepo()
    await repo.plans.put(PLAN)
    await repo.subscriptions.put(mk_sub())
    return SchedulerTickInput(
        repo=repo,
        provider=FakeSelfSchedulingProvider(),
        policy=resolve_policy(),
        ledger=InMemoryLedger(SequentialIdGen("led_")),
        clock=FixedClock(datetime(2024, 2, 1, tzinfo=UTC)),
        ids=SequentialIdGen("id_"),
    )


def test_scheduled_cancel_is_not_due():
    async def scenario():
        input = await setup()
        sub = await input.repo.subscriptions.get("sub_1")
        await input.repo.subscriptions.put(replace(sub, cancel_at_period_end=True))
        assert await due_subscriptions(DueSubscriptionsInput(repo=input.repo, clock=input.clock)) == []
        result = await tick(input)
        assert result.charged == result.failed == []
        assert input.provider.last_charge is None
        canceled = await input.repo.subscriptions.get("sub_1")
        assert canceled.status == "canceled"
        assert canceled.cancel_at_period_end is False
        await tick(input)
        assert await input.repo.subscriptions.get("sub_1") == canceled
        assert input.provider.last_charge is None

    run(scenario())


@pytest.mark.parametrize("change", ["canceled", "advanced", "wrong_provider", "deleted"])
def test_revalidates_current_row_before_charge(change, monkeypatch):
    async def scenario():
        input = await setup()
        sub = mk_sub()
        current = None if change == "deleted" else replace(
            sub,
            cancel_at_period_end=change == "canceled",
            provider="stripe" if change == "wrong_provider" else sub.provider,
            current_period=Period(start=sub.current_period.end, end=datetime(2024, 3, 1, tzinfo=UTC))
            if change == "advanced" else sub.current_period,
        )
        monkeypatch.setattr(input.repo.subscriptions, "get", AsyncMock(return_value=current))
        result = await tick(input)
        assert result.charged == result.failed == []
        assert input.provider.last_charge is None

    run(scenario())


def test_pending_charge_does_not_start_dunning():
    async def scenario():
        input = await setup()
        input.provider.next_charge_status = "pending"
        with pytest.raises(PaymentKitError) as exc:
            await tick(input)
        assert exc.value.code == "scheduler_charge_unresolved"
        assert (await input.repo.subscriptions.get("sub_1")).status == "active"
        assert await input.repo.outbox.list() == []

    run(scenario())


@pytest.mark.parametrize("failure", ["ledger", "repository"])
def test_post_charge_persistence_failure_does_not_start_dunning(failure, monkeypatch):
    async def scenario():
        input = await setup()
        error = PaymentKitError("storage unavailable", "storage_unavailable")
        target, method = (input.ledger, "append") if failure == "ledger" else (input.repo.subscriptions, "put")
        monkeypatch.setattr(target, method, AsyncMock(side_effect=error))
        with pytest.raises(PaymentKitError) as exc:
            await tick(input)
        assert exc.value is error
        assert input.provider.last_charge is not None
        assert (await input.repo.subscriptions.get("sub_1")).status == "active"
        assert await input.repo.outbox.list() == []

    run(scenario())


def test_recovers_already_granted_renewal_after_failed_subscription_write(monkeypatch):
    async def scenario():
        input = await setup()
        original_put = input.repo.subscriptions.put
        monkeypatch.setattr(input.repo.subscriptions, "put", AsyncMock(
            side_effect=PaymentKitError("storage unavailable", "storage_unavailable")))
        with pytest.raises(PaymentKitError):
            await tick(input)
        first_charge = input.provider.last_charge
        monkeypatch.setattr(input.repo.subscriptions, "put", original_put)
        result = await tick(input)
        assert result.charged[0].current_period.start == datetime(2024, 2, 1, tzinfo=UTC)
        assert (await input.repo.subscriptions.get("sub_1")).current_period.start == datetime(2024, 2, 1, tzinfo=UTC)
        assert input.provider.last_charge == first_charge
        assert (await input.ledger.balance("cust_1", None, input.clock.now())).available == 100

    run(scenario())


def test_finalizes_cancellation_without_billing_key_after_version_conflict(monkeypatch):
    async def scenario():
        input = await setup()
        sub = await input.repo.subscriptions.get("sub_1")
        await input.repo.subscriptions.put(replace(sub, cancel_at_period_end=True, billing_key=None))
        original_put = input.repo.subscriptions.put
        calls = 0

        async def conflicting_put(row):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise PaymentKitError("concurrent write", "subscription_version_conflict")
            await original_put(row)

        monkeypatch.setattr(input.repo.subscriptions, "put", conflicting_put)
        get = AsyncMock(wraps=input.repo.subscriptions.get)
        monkeypatch.setattr(input.repo.subscriptions, "get", get)
        await tick(input)
        assert calls == 2
        assert get.await_count >= 2
        assert (await input.repo.subscriptions.get("sub_1")).status == "canceled"
        assert input.provider.last_charge is None

    run(scenario())


@pytest.mark.parametrize("condition", ["future", "other_provider"])
def test_does_not_finalize_future_or_other_provider_cancellation(condition):
    async def scenario():
        input = await setup()
        sub = await input.repo.subscriptions.get("sub_1")
        await input.repo.subscriptions.put(replace(
            sub, cancel_at_period_end=True,
            provider="stripe" if condition == "other_provider" else sub.provider,
            current_period=Period(start=sub.current_period.start, end=datetime(2024, 3, 1, tzinfo=UTC))
            if condition == "future" else sub.current_period,
        ))
        await tick(input)
        assert (await input.repo.subscriptions.get("sub_1")).status == "active"
        assert input.provider.last_charge is None

    run(scenario())
