"""spec: packages/lifecycle/spec/lifecycle.pseudo.md [EC:A5] [EC:A6] [EC:F]"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

import pytest
from helpers import FakeNativeProvider, FakeSelfSchedulingProvider
from schift_payment_kit_core import (
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    LedgerReference,
    NewLedgerEntry,
    PaymentKitError,
    Period,
    SequentialIdGen,
    Subscription,
    resolve_policy,
)
from schift_payment_kit_lifecycle import CancelInput, cancel


def run(coro):
    return asyncio.run(coro)


def mk_sub(**overrides) -> Subscription:
    base = {
        "id": "sub_1",
        "customer_id": "cust_1",
        "plan_id": "plan_a",
        "provider": "stripe",
        "provider_ref": "stripe_sub_1",
        "status": "active",
        "current_period": Period(
            start=datetime(2024, 1, 1, tzinfo=UTC), end=datetime(2024, 2, 1, tzinfo=UTC)
        ),
        "anchor_day": 1,
        "cancel_at_period_end": False,
        "grace_until": None,
        "billing_key": None,
        "scheduled_plan_id": None,
        "created_at": datetime(2024, 1, 1, tzinfo=UTC),
    }
    base.update(overrides)
    return Subscription(**base)


async def setup(paid_balance: int):
    clock = FixedClock(datetime(2024, 1, 16, tzinfo=UTC))
    ledger = InMemoryLedger(SequentialIdGen("led_"))
    repo = InMemoryRepo()
    if paid_balance > 0:
        await ledger.append(
            NewLedgerEntry(
                customer_id="cust_1",
                pool="paid",
                kind="grant",
                amount=paid_balance,
                source="subscription",
                reference=LedgerReference(),
                idempotency_key="seed_grant",
                actor="system",
            )
        )
    return clock, ledger, repo


def test_end_of_period_default_marks_cancel_at_period_end():
    async def scenario():
        clock, ledger, repo = await setup(100)
        sub = mk_sub()
        await repo.subscriptions.put(sub)
        provider = FakeNativeProvider()
        provider.set_dummy_sub(sub)
        policy = resolve_policy()

        res = await cancel(
            CancelInput(
                sub=sub,
                policy=policy,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
            )
        )
        assert res.sub.status == "active"
        assert res.sub.cancel_at_period_end is True
        assert provider.cancel_subscription_called == 1

    run(scenario())


def test_immediate_cancels_now():
    async def scenario():
        clock, ledger, repo = await setup(100)
        sub = mk_sub()
        await repo.subscriptions.put(sub)
        provider = FakeNativeProvider()
        provider.set_dummy_sub(sub)
        policy = resolve_policy({"cancel": {"mode": "immediate"}})

        res = await cancel(
            CancelInput(
                sub=sub,
                policy=policy,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
            )
        )
        assert res.sub.status == "canceled"
        assert res.sub.cancel_at_period_end is False
        assert provider.cancel_subscription_called == 1

    run(scenario())


def test_ec_a6_keep_until_period_end_default_leaves_balance_untouched():
    async def scenario():
        clock, ledger, repo = await setup(100)
        sub = mk_sub()
        await repo.subscriptions.put(sub)
        provider = FakeNativeProvider()
        provider.set_dummy_sub(sub)
        policy = resolve_policy()

        res = await cancel(
            CancelInput(
                sub=sub,
                policy=policy,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
            )
        )
        assert res.revoked is None
        bal = await ledger.balance("cust_1", None, clock.now())
        assert bal.available == 100

    run(scenario())


def test_ec_a6_revoke_immediately_claws_back_full_balance():
    async def scenario():
        clock, ledger, repo = await setup(100)
        sub = mk_sub()
        await repo.subscriptions.put(sub)
        provider = FakeNativeProvider()
        provider.set_dummy_sub(sub)
        policy = resolve_policy({"cancel": {"credits": "revoke_immediately"}})

        res = await cancel(
            CancelInput(
                sub=sub,
                policy=policy,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
            )
        )
        assert res.revoked.revoked == 100
        bal = await ledger.balance("cust_1", None, clock.now())
        assert bal.available == 0

    run(scenario())


def test_ec_f_self_scheduling_cancel_never_calls_cancel_subscription():
    async def scenario():
        clock, ledger, repo = await setup(0)
        sub = mk_sub(
            id="sub_toss_1",
            customer_id="cust_toss_1",
            provider="toss",
            provider_ref="toss_sub_1",
        )
        await repo.subscriptions.put(sub)
        provider = (
            FakeSelfSchedulingProvider()
        )  # cancel_subscription raises 'unsupported' if called
        policy = resolve_policy({"cancel": {"mode": "immediate"}})

        res = await cancel(
            CancelInput(
                sub=sub,
                policy=policy,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
            )
        )
        assert res.sub.status == "canceled"

    run(scenario())


def test_ec_a6_rejects_keep_forever_before_any_cancellation_mutation():
    async def scenario():
        clock, ledger, repo = await setup(100)
        sub = mk_sub()
        await repo.subscriptions.put(sub)
        before = await repo.subscriptions.get(sub.id)
        provider = FakeNativeProvider()
        provider.set_dummy_sub(sub)
        policy = resolve_policy({"cancel": {"credits": "keep_forever"}})
        with pytest.raises(PaymentKitError) as exc:
            await cancel(CancelInput(
                sub=sub, policy=policy, provider=provider, ledger=ledger,
                repo=repo, clock=clock,
            ))
        assert exc.value.code == "unsupported"
        assert provider.cancel_subscription_called == 0
        assert await repo.subscriptions.get(sub.id) == before
        assert await repo.operations.list() == []
        assert (await ledger.balance(sub.customer_id, None, clock.now())).available == 100

    run(scenario())
