"""spec: packages/lifecycle/spec/lifecycle.pseudo.md [EC:A23]"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

import pytest
from helpers import (
    FakeCorrelatingProvider,
    FakeNativeProvider,
    FakeSelfSchedulingProvider,
)
from schift_payment_kit_core import (
    CollectingLogger,
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
from schift_payment_kit_lifecycle import (
    CancelInput,
    ReactivateInput,
    cancel,
    reactivate,
)


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
        "version": 0,
        "created_at": datetime(2024, 1, 1, tzinfo=UTC),
    }
    base.update(overrides)
    return Subscription(**base)


async def setup(paid_balance: int, now: datetime | None = None):
    clock = FixedClock(now or datetime(2024, 1, 16, tzinfo=UTC))
    ledger = InMemoryLedger(SequentialIdGen("led_"))
    repo = InMemoryRepo()
    if paid_balance > 0:
        await ledger.append(
            NewLedgerEntry(
                customer_id="cust_1",
                pool="paid",
                kind="grant",
                amount=paid_balance,
                unit_price_minor=5,
                currency="USD",
                source="subscription",
                reference=LedgerReference(),
                idempotency_key="seed_grant",
                actor="system",
            )
        )
    return clock, ledger, repo


def test_cancel_at_period_end_true_clears_it_status_stays_active():
    async def scenario():
        clock, ledger, repo = await setup(0)
        sub = mk_sub(status="active", cancel_at_period_end=True)
        await repo.subscriptions.put(sub)
        provider = FakeNativeProvider()
        provider.set_dummy_sub(sub)
        policy = resolve_policy()

        res = await reactivate(
            ReactivateInput(
                sub=sub,
                policy=policy,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
            )
        )
        assert res.sub.status == "active"
        assert res.sub.cancel_at_period_end is False
        assert provider.uncancel_subscription_called == 1
        assert res.provider_notified is True

    run(scenario())


def test_status_canceled_and_now_before_period_end_goes_active():
    async def scenario():
        clock, ledger, repo = await setup(0)
        sub = mk_sub(status="canceled", cancel_at_period_end=False)
        await repo.subscriptions.put(sub)
        provider = FakeNativeProvider()
        provider.set_dummy_sub(sub)
        policy = resolve_policy()

        res = await reactivate(
            ReactivateInput(
                sub=sub,
                policy=policy,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
            )
        )
        assert res.sub.status == "active"
        assert res.sub.cancel_at_period_end is False
        assert res.provider_notified is True

    run(scenario())


def test_native_provider_unsupported_repo_repair_still_happens_not_notified():
    async def scenario():
        clock, ledger, repo = await setup(0)
        sub = mk_sub(status="active", cancel_at_period_end=True)
        await repo.subscriptions.put(sub)
        provider = FakeNativeProvider()
        provider.set_dummy_sub(sub)
        provider.next_uncancel_throws = PaymentKitError(
            "uncancel not implemented for this adapter", "unsupported"
        )
        policy = resolve_policy()

        res = await reactivate(
            ReactivateInput(
                sub=sub,
                policy=policy,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
            )
        )
        assert res.sub.status == "active"
        assert res.sub.cancel_at_period_end is False
        assert res.provider_notified is False
        stored = await repo.subscriptions.get(sub.id)
        assert stored.cancel_at_period_end is False

    run(scenario())


def test_native_provider_not_reactivatable_propagates_no_repo_write():
    async def scenario():
        clock, ledger, repo = await setup(0)
        sub = mk_sub(status="active", cancel_at_period_end=True)
        await repo.subscriptions.put(sub)
        provider = FakeNativeProvider()
        provider.set_dummy_sub(sub)
        provider.next_uncancel_throws = PaymentKitError(
            "stripe subscription sub_1 is fully canceled and cannot be reactivated (status=canceled)",
            "not_reactivatable",
        )
        policy = resolve_policy()

        with pytest.raises(PaymentKitError) as exc_info:
            await reactivate(
                ReactivateInput(
                    sub=sub,
                    policy=policy,
                    provider=provider,
                    ledger=ledger,
                    repo=repo,
                    clock=clock,
                )
            )
        assert exc_info.value.code == "not_reactivatable"
        stored = await repo.subscriptions.get(sub.id)
        assert stored.cancel_at_period_end is True

    run(scenario())


def test_correlation_id_scopes_uncancel_subscription_call_reaching_logger():
    async def scenario():
        clock, ledger, repo = await setup(0)
        sub = mk_sub(status="active", cancel_at_period_end=True)
        await repo.subscriptions.put(sub)
        logger = CollectingLogger()
        provider = FakeCorrelatingProvider(logger)
        provider.set_dummy_sub(sub)
        policy = resolve_policy()

        await reactivate(
            ReactivateInput(
                sub=sub,
                policy=policy,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
                correlation_id="corr_reactivate_1",
            )
        )
        entry = next(e for e in logger.entries if e["event"] == "provider.request")
        assert entry["correlationId"] == "corr_reactivate_1"

    run(scenario())


def test_status_expired_raises_not_reactivatable():
    async def scenario():
        clock, ledger, repo = await setup(0)
        sub = mk_sub(status="expired", cancel_at_period_end=False)
        await repo.subscriptions.put(sub)
        provider = FakeNativeProvider()
        policy = resolve_policy()

        with pytest.raises(PaymentKitError) as exc_info:
            await reactivate(
                ReactivateInput(
                    sub=sub,
                    policy=policy,
                    provider=provider,
                    ledger=ledger,
                    repo=repo,
                    clock=clock,
                )
            )
        assert exc_info.value.code == "not_reactivatable"

    run(scenario())


def test_period_already_ended_raises_not_reactivatable():
    async def scenario():
        clock, ledger, repo = await setup(0, now=datetime(2024, 3, 1, tzinfo=UTC))
        sub = mk_sub(status="canceled", cancel_at_period_end=False)
        await repo.subscriptions.put(sub)
        provider = FakeNativeProvider()
        policy = resolve_policy()

        with pytest.raises(PaymentKitError) as exc_info:
            await reactivate(
                ReactivateInput(
                    sub=sub,
                    policy=policy,
                    provider=provider,
                    ledger=ledger,
                    repo=repo,
                    clock=clock,
                )
            )
        assert exc_info.value.code == "not_reactivatable"

    run(scenario())


def test_active_with_no_pending_cancellation_raises_not_reactivatable():
    async def scenario():
        clock, ledger, repo = await setup(0)
        sub = mk_sub(status="active", cancel_at_period_end=False)
        await repo.subscriptions.put(sub)
        provider = FakeNativeProvider()
        policy = resolve_policy()

        with pytest.raises(PaymentKitError) as exc_info:
            await reactivate(
                ReactivateInput(
                    sub=sub,
                    policy=policy,
                    provider=provider,
                    ledger=ledger,
                    repo=repo,
                    clock=clock,
                )
            )
        assert exc_info.value.code == "not_reactivatable"

    run(scenario())


def test_self_scheduling_provider_never_gets_a_provider_call():
    async def scenario():
        clock, ledger, repo = await setup(0)
        sub = mk_sub(
            id="sub_toss_1",
            customer_id="cust_toss_1",
            provider="toss",
            provider_ref="toss_sub_1",
            status="canceled",
        )
        await repo.subscriptions.put(sub)
        provider = (
            FakeSelfSchedulingProvider()
        )  # every method not exercised raises loudly
        policy = resolve_policy()

        res = await reactivate(
            ReactivateInput(
                sub=sub,
                policy=policy,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
            )
        )
        assert res.sub.status == "active"
        assert res.provider_notified is False
        stored = await repo.subscriptions.get(sub.id)
        assert stored.status == "active"

    run(scenario())


def test_cancel_revoke_immediately_then_reactivate_restores_per_bucket_with_original_expiry():
    async def scenario():
        clock, ledger, repo = await setup(0)
        in_a = datetime(2024, 1, 20, tzinfo=UTC)
        in_b = datetime(2024, 1, 25, tzinfo=UTC)
        await ledger.append(
            NewLedgerEntry(
                customer_id="cust_1",
                pool="paid",
                kind="grant",
                amount=40,
                unit_price_minor=2,
                currency="USD",
                expires_at=in_a,
                source="subscription",
                reference=LedgerReference(),
                idempotency_key="grantA",
                actor="system",
            )
        )
        await ledger.append(
            NewLedgerEntry(
                customer_id="cust_1",
                pool="paid",
                kind="grant",
                amount=60,
                unit_price_minor=3,
                currency="USD",
                expires_at=in_b,
                source="subscription",
                reference=LedgerReference(),
                idempotency_key="grantB",
                actor="system",
            )
        )

        sub = mk_sub()
        await repo.subscriptions.put(sub)
        provider = FakeNativeProvider()
        provider.set_dummy_sub(sub)
        policy = resolve_policy({"cancel": {"credits": "revoke_immediately"}})

        cancel_res = await cancel(
            CancelInput(
                sub=sub,
                policy=policy,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
            )
        )
        assert cancel_res.revoked.revoked == 100
        assert (await ledger.balance("cust_1", None, now=clock.now())).available == 0

        canceled_sub = cancel_res.sub
        reactivate_res = await reactivate(
            ReactivateInput(
                sub=canceled_sub,
                policy=policy,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
            )
        )
        assert reactivate_res.sub.status == "active"
        assert reactivate_res.restored.restored == 100

        bal_after = await ledger.balance("cust_1", None, now=clock.now())
        assert bal_after.available == 100

        paid_entries = await ledger.entries("cust_1", pool="paid")
        restore_entries = [
            e
            for e in paid_entries
            if e.idempotency_key.startswith("restore:reactivate:")
        ]
        by_expiry: dict[float, int] = {}
        for e in restore_entries:
            key = e.expires_at.timestamp() if e.expires_at else 0
            by_expiry[key] = by_expiry.get(key, 0) + e.amount
        assert by_expiry[in_a.timestamp()] == 40
        assert by_expiry[in_b.timestamp()] == 60

    run(scenario())


def test_reactivate_is_idempotent_no_double_restore():
    async def scenario():
        clock, ledger, repo = await setup(100)
        sub = mk_sub()
        await repo.subscriptions.put(sub)
        provider = FakeNativeProvider()
        provider.set_dummy_sub(sub)
        policy = resolve_policy({"cancel": {"credits": "revoke_immediately"}})

        cancel_res = await cancel(
            CancelInput(
                sub=sub,
                policy=policy,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
            )
        )
        canceled_sub = cancel_res.sub

        first = await reactivate(
            ReactivateInput(
                sub=canceled_sub,
                policy=policy,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
            )
        )
        assert first.restored.restored == 100

        second = await reactivate(
            ReactivateInput(
                sub=canceled_sub,
                policy=policy,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
            )
        )
        assert second.sub.status == "active"
        assert (await ledger.balance("cust_1", None, now=clock.now())).available == 100

    run(scenario())
