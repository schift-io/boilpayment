"""spec: packages/lifecycle/spec/lifecycle.pseudo.md [EC:A1] [EC:A2] [EC:F]"""

from __future__ import annotations

import asyncio
import dataclasses
from datetime import UTC, datetime

import pytest
from boilpayment_core import (
    CollectingNotifier,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    LedgerReference,
    Money,
    NewLedgerEntry,
    Operation,
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
    UpgradeInput,
    on_renewal_paid,
    upgrade,
)
from boilpayment_lifecycle.dunning import OnPaymentFailedInput, on_payment_failed
from boilpayment_lifecycle.upgrade import (
    pending_upgrade_grant_key,
    upgrade_anchor_intent_key,
)
from helpers import FakeNativeProvider, FakeSelfSchedulingProvider

PLAN_A = Plan(
    id="plan_a",
    name="Plan A",
    interval="month",
    credits_per_period=100,
    usage_included=0,
    trial_days=0,
    prices=[PlanPrice(currency="USD", amount_minor=1000)],
)
PLAN_B = Plan(
    id="plan_b",
    name="Plan B",
    interval="month",
    credits_per_period=300,
    usage_included=0,
    trial_days=0,
    prices=[PlanPrice(currency="USD", amount_minor=3000)],
)


def run(coro):
    return asyncio.run(coro)


def mk_sub(**overrides) -> Subscription:
    base = {
        "id": "sub_1",
        "customer_id": "cust_1",
        "plan_id": PLAN_A.id,
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


async def setup():
    clock = FixedClock(
        datetime(2024, 1, 16, tzinfo=UTC)
    )  # day 16 of a 31-day Jan period
    ledger = InMemoryLedger(SequentialIdGen("led_"))
    repo = InMemoryRepo()
    ids = SequentialIdGen("id_")
    await repo.plans.put(PLAN_A)
    await repo.plans.put(PLAN_B)
    return clock, ledger, repo, ids


def test_sb_11_stripe_grants_full_delta_immediately_without_anchor_invoice_regrant():
    async def scenario():
        clock, ledger, repo, ids = await setup()
        sub = mk_sub()
        await repo.subscriptions.put(sub)
        await ledger.append(
            NewLedgerEntry(
                customer_id=sub.customer_id,
                pool="paid",
                kind="grant",
                amount=PLAN_A.credits_per_period,
                expires_at=sub.current_period.end,
                source="subscription",
                reference=LedgerReference(
                    subscription_id=sub.id, period_start=sub.current_period.start
                ),
                idempotency_key=f"grant:{sub.id}:{sub.current_period.start.isoformat()}",
                actor="system",
                reason="initial period",
            )
        )
        reset_period = Period(
            start=clock.now(), end=datetime(2024, 2, 16, tzinfo=UTC)
        )
        provider = FakeNativeProvider()
        provider.set_dummy_sub(
            dataclasses.replace(
                sub, plan_id=PLAN_B.id, anchor_day=16, current_period=reset_period
            )
        )

        upgraded = await upgrade(
            UpgradeInput(
                sub=sub,
                new_plan=PLAN_B,
                policy=resolve_policy(),
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )

        assert upgraded.credit_delta == 200
        assert upgraded.sub.current_period == reset_period
        assert upgraded.sub.anchor_day == 16
        assert (await ledger.balance(sub.customer_id, "paid", clock.now())).available == 300

        anchor_invoice = Payment(
            id="pay_upgrade_anchor",
            customer_id=sub.customer_id,
            provider="stripe",
            provider_ref="in_upgrade_anchor",
            subscription_id=sub.id,
            amount=Money(amount_minor=2000, currency="USD"),
            status="succeeded",
            kind="subscription",
            period=reset_period,
            occurred_at=clock.now(),
            failure=None,
        )
        await on_renewal_paid(
            OnRenewalPaidInput(
                sub=upgraded.sub,
                payment=anchor_invoice,
                policy=resolve_policy(),
                ledger=ledger,
                repo=repo,
                clock=clock,
            )
        )

        assert (await ledger.balance(sub.customer_id, "paid", clock.now())).available == 300
        attribution = next(
            entry for entry in await ledger.entries(sub.customer_id)
            if entry.reason == "SB-11 upgrade_invoice_attribution"
        )
        assert attribution.reference.payment_id == anchor_invoice.id
        assert attribution.reference.grant_id == upgraded.grant.id
        assert [
            op.status for op in await repo.operations.list(kind="lifecycle.upgrade_anchor")
        ] == ["done"]

    run(scenario())


def test_sb_11_stripe_anchor_invoice_does_not_grant_full_plan_after_immediate_delta():
    async def scenario():
        clock, ledger, repo, _ids = await setup()
        reset_period = Period(
            start=clock.now(), end=datetime(2024, 2, 16, tzinfo=UTC)
        )
        sub = mk_sub(
            plan_id=PLAN_B.id,
            anchor_day=16,
            current_period=reset_period,
            version=0,
        )
        await repo.subscriptions.put(sub)
        await ledger.append(
            NewLedgerEntry(
                customer_id=sub.customer_id,
                pool="paid",
                kind="grant",
                amount=100,
                expires_at=reset_period.end,
                source="subscription",
                reference=LedgerReference(subscription_id=sub.id),
                idempotency_key="seed:old-plan",
                actor="system",
                reason="old plan",
            )
        )
        await ledger.append(
            NewLedgerEntry(
                customer_id=sub.customer_id,
                pool="paid",
                kind="grant",
                amount=200,
                expires_at=reset_period.end,
                source="subscription",
                reference=LedgerReference(
                    subscription_id=sub.id, period_start=reset_period.start
                ),
                idempotency_key=f"grant:{sub.id}:2024-01-16T00:00:00.000Z",
                actor="system",
                reason="upgrade:plan_a->plan_b",
            )
        )
        anchor_invoice = Payment(
            id="pay_upgrade_anchor",
            customer_id=sub.customer_id,
            provider="stripe",
            provider_ref="in_upgrade_anchor",
            subscription_id=sub.id,
            amount=Money(amount_minor=2000, currency="USD"),
            status="succeeded",
            kind="subscription",
            period=reset_period,
            occurred_at=clock.now(),
            failure=None,
        )

        await on_renewal_paid(
            OnRenewalPaidInput(
                sub=sub,
                payment=anchor_invoice,
                policy=resolve_policy(),
                ledger=ledger,
                repo=repo,
                clock=clock,
            )
        )

        assert (await ledger.balance(sub.customer_id, "paid", clock.now())).available == 300

    run(scenario())


class PolarProvider(FakeNativeProvider):
    def capabilities(self):
        return dataclasses.replace(super().capabilities(), upgrade_grant="on_payment")


def test_sb_13_polar_payment_failure_restores_old_plan_and_fails_pending_operation():
    async def scenario():
        clock, ledger, repo, ids = await setup()
        sub = mk_sub(provider="polar", provider_ref="polar_sub_1")
        await repo.subscriptions.put(sub)
        provider = PolarProvider()
        provider.set_dummy_sub(sub)
        policy = resolve_policy({"upgrade": {"mode": "immediate_prorate_keep_anchor"}})
        upgraded = await upgrade(
            UpgradeInput(
                sub=sub,
                new_plan=PLAN_B,
                policy=policy,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )
        pending_key = (
            f"upgrade-grant:{sub.id}:"
            f"{sub.current_period.start.strftime('%Y-%m-%dT%H:%M:%S.000Z')}"
        )
        assert (await repo.operations.get(pending_key)).status == "in_progress"

        await on_payment_failed(
            OnPaymentFailedInput(
                sub=upgraded.sub,
                policy=policy,
                ledger=ledger,
                repo=repo,
                notifier=CollectingNotifier(),
                clock=clock,
            )
        )

        assert (await repo.subscriptions.get(sub.id)).plan_id == PLAN_A.id
        assert (await repo.operations.get(pending_key)).status == "failed"
        assert (await ledger.balance(sub.customer_id, "paid", clock.now())).available == 0

    run(scenario())


def test_sb_11_sb_13_polar_paid_upgrade_is_not_reverted_by_later_dunning():
    async def scenario():
        clock, ledger, repo, ids = await setup()
        sub = mk_sub(provider="polar", provider_ref="polar_sub_1")
        await repo.subscriptions.put(sub)
        await ledger.append(NewLedgerEntry(
            customer_id=sub.customer_id,
            pool="paid",
            kind="grant",
            amount=PLAN_A.credits_per_period,
            source="subscription",
            expires_at=sub.current_period.end,
            reference=LedgerReference(
                subscription_id=sub.id,
                period_start=sub.current_period.start,
                payment_id="pay_initial",
            ),
            idempotency_key=f"grant:{sub.id}:{sub.current_period.start.isoformat()}",
            actor="system",
            reason="initial period",
        ))
        provider = PolarProvider()
        provider.set_dummy_sub(dataclasses.replace(sub, plan_id=PLAN_B.id))

        upgraded = await upgrade(UpgradeInput(
            sub=sub,
            new_plan=PLAN_B,
            policy=resolve_policy(),
            provider=provider,
            ledger=ledger,
            repo=repo,
            clock=clock,
            ids=ids,
        ))

        assert upgraded.sub.current_period == sub.current_period
        assert upgraded.sub.anchor_day == sub.anchor_day
        assert upgraded.grant is None
        assert (await ledger.balance(sub.customer_id, "paid", clock.now())).available == 100

        paid_order = Payment(
            id="pay_polar_upgrade",
            customer_id=sub.customer_id,
            provider="polar",
            provider_ref="order_upgrade",
            subscription_id=sub.id,
            amount=Money(amount_minor=2000, currency="USD"),
            status="succeeded",
            kind="subscription",
            period=sub.current_period,
            occurred_at=clock.now(),
            failure=None,
        )
        await on_renewal_paid(OnRenewalPaidInput(
            sub=upgraded.sub,
            payment=paid_order,
            policy=resolve_policy(),
            ledger=ledger,
            repo=repo,
            clock=clock,
        ))

        assert (await ledger.balance(sub.customer_id, "paid", clock.now())).available == 300
        paid_sub = await repo.subscriptions.get(sub.id)
        await on_payment_failed(OnPaymentFailedInput(
            sub=paid_sub,
            policy=resolve_policy(),
            ledger=ledger,
            repo=repo,
            notifier=CollectingNotifier(),
            clock=clock,
        ))
        assert (await repo.subscriptions.get(sub.id)).plan_id == PLAN_B.id
        pending_key = pending_upgrade_grant_key(sub.id, sub.current_period.start)
        assert (await repo.operations.get(pending_key)).status == "done"

    run(scenario())


def test_sb_11_stripe_webhook_race_grants_only_delta_with_payment_attribution():
    async def scenario():
        clock, ledger, repo, ids = await setup()
        sub = mk_sub(version=0)
        await repo.subscriptions.put(sub)
        await ledger.append(NewLedgerEntry(
            customer_id=sub.customer_id,
            pool="paid",
            kind="grant",
            amount=PLAN_A.credits_per_period,
            expires_at=sub.current_period.end,
            source="subscription",
            reference=LedgerReference(
                subscription_id=sub.id,
                period_start=sub.current_period.start,
                payment_id="pay_initial",
            ),
            idempotency_key=f"grant:{sub.id}:{sub.current_period.start.isoformat()}",
            actor="system",
            reason="initial period",
        ))
        reset_period = Period(
            start=clock.now(), end=datetime(2024, 2, 16, tzinfo=UTC)
        )
        invoice = Payment(
            id="pay_racing_anchor",
            customer_id=sub.customer_id,
            provider="stripe",
            provider_ref="in_racing_anchor",
            subscription_id=sub.id,
            amount=Money(amount_minor=2000, currency="USD"),
            status="succeeded",
            kind="subscription",
            period=reset_period,
            occurred_at=clock.now(),
            failure=None,
        )

        class RacingProvider(FakeNativeProvider):
            async def change_subscription(self, provider_ref: str, **kwargs):
                await on_renewal_paid(OnRenewalPaidInput(
                    sub=sub,
                    payment=invoice,
                    policy=resolve_policy(),
                    ledger=ledger,
                    repo=repo,
                    clock=clock,
                ))
                return dataclasses.replace(
                    sub, plan_id=PLAN_B.id, anchor_day=16,
                    current_period=reset_period,
                )

        upgraded = await upgrade(UpgradeInput(
            sub=sub,
            new_plan=PLAN_B,
            policy=resolve_policy(),
            provider=RacingProvider(),
            ledger=ledger,
            repo=repo,
            clock=clock,
            ids=ids,
        ))

        assert upgraded.credit_delta == 200
        assert upgraded.grant.reference.payment_id == invoice.id
        assert (await ledger.balance(sub.customer_id, "paid", clock.now())).available == 300
        assert len(await ledger.entries(sub.customer_id, kind="grant")) == 2
        assert [
            op.status for op in await repo.operations.list(kind="lifecycle.upgrade_anchor")
        ] == ["done"]

    run(scenario())


def test_sb_11_different_target_cannot_reuse_same_period_anchor_intent():
    async def scenario():
        clock, ledger, repo, ids = await setup()
        sub = mk_sub(version=0)
        await repo.subscriptions.put(sub)
        key = upgrade_anchor_intent_key(sub.id, sub.current_period.start)
        await repo.operations.put(Operation(
            id=key,
            key=key,
            kind="lifecycle.upgrade_anchor",
            payload_hash="",
            status="in_progress",
            result={
                "subId": sub.id,
                "fromPlanId": PLAN_A.id,
                "toPlanId": "plan_c",
                "delta": 400,
                "sourcePeriodStart": sub.current_period.start.strftime(
                    "%Y-%m-%dT%H:%M:%S.000Z"
                ),
                "sourcePeriodEnd": sub.current_period.end.strftime(
                    "%Y-%m-%dT%H:%M:%S.000Z"
                ),
            },
            error=None,
            created_at=clock.now(),
            completed_at=None,
            attempts=0,
        ))
        provider = FakeNativeProvider()

        with pytest.raises(PaymentKitError) as exc:
            await upgrade(UpgradeInput(
                sub=sub,
                new_plan=PLAN_B,
                policy=resolve_policy(),
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
                ids=ids,
            ))

        assert exc.value.code == "upgrade_payment_pending"
        assert provider.change_subscription_called == 0
        assert (await repo.operations.get(key)).result["toPlanId"] == "plan_c"
        assert (await repo.operations.get(key)).result["delta"] == 400

    run(scenario())


def test_sb_11_native_reset_anchor_keeps_provider_period_and_grants_full_delta():
    async def scenario():
        clock, ledger, repo, ids = await setup()
        sub = mk_sub()
        await repo.subscriptions.put(sub)
        provider = FakeNativeProvider()
        provider.set_dummy_sub(dataclasses.replace(sub, anchor_day=16, current_period=Period(
            start=datetime(2024, 1, 16, tzinfo=UTC), end=datetime(2024, 2, 16, tzinfo=UTC))))
        policy = resolve_policy()

        res = await upgrade(
            UpgradeInput(
                sub=sub,
                new_plan=PLAN_B,
                policy=policy,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )
        assert res.credit_delta == 200
        assert res.sub.anchor_day == 16
        assert res.sub.current_period.start == datetime(2024, 1, 16, tzinfo=UTC)
        assert res.sub.current_period.end == datetime(2024, 2, 16, tzinfo=UTC)
        assert res.sub.plan_id == PLAN_B.id
        assert provider.change_subscription_called == 1
        bal = await ledger.balance("cust_1", None, clock.now())
        assert bal.available == 200

    run(scenario())


def test_immediate_prorate_keep_anchor_full_delta():
    async def scenario():
        clock, ledger, repo, ids = await setup()
        sub = mk_sub()
        await repo.subscriptions.put(sub)
        provider = FakeNativeProvider()
        provider.set_dummy_sub(sub)
        policy = resolve_policy({"upgrade": {"mode": "immediate_prorate_keep_anchor"}})

        res = await upgrade(
            UpgradeInput(
                sub=sub,
                new_plan=PLAN_B,
                policy=policy,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )
        assert res.credit_delta == 200
        assert res.sub.anchor_day == 1
        assert res.sub.current_period == sub.current_period
        assert provider.change_subscription_called == 1

    run(scenario())


def test_immediate_prorate_keep_anchor_prorated_delta():
    async def scenario():
        clock, ledger, repo, ids = await setup()
        sub = mk_sub()
        await repo.subscriptions.put(sub)
        provider = FakeNativeProvider()
        provider.set_dummy_sub(sub)
        policy = resolve_policy({"upgrade": {"mode": "immediate_prorate_keep_anchor", "creditDelta": "prorated_delta"}})

        res = await upgrade(
            UpgradeInput(
                sub=sub,
                new_plan=PLAN_B,
                policy=policy,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )
        assert res.credit_delta == 103  # floor(200 * 16/31)

    run(scenario())


def test_next_period_defers_the_switch():
    async def scenario():
        clock, ledger, repo, ids = await setup()
        sub = mk_sub()
        await repo.subscriptions.put(sub)
        provider = FakeNativeProvider()  # must NOT be called
        policy = resolve_policy({"upgrade": {"mode": "next_period"}})

        res = await upgrade(
            UpgradeInput(
                sub=sub,
                new_plan=PLAN_B,
                policy=policy,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )
        assert res.credit_delta == 0
        assert res.grant is None
        assert res.sub.scheduled_plan_id == PLAN_B.id
        assert res.sub.plan_id == PLAN_A.id
        assert provider.change_subscription_called == 0
        bal = await ledger.balance("cust_1", None, clock.now())
        assert bal.available == 0

    run(scenario())


def test_ec_f_self_scheduling_upgrade_charges_prorated_money_delta():
    async def scenario():
        clock, ledger, repo, ids = await setup()
        sub = mk_sub(
            id="sub_toss_1",
            customer_id="cust_toss_1",
            provider="toss",
            provider_ref="toss_sub_1",
            billing_key="bk_toss_1",
        )
        await repo.subscriptions.put(sub)
        provider = FakeSelfSchedulingProvider()
        policy = resolve_policy({"upgrade": {"mode": "immediate_prorate_keep_anchor"}})

        res = await upgrade(
            UpgradeInput(
                sub=sub,
                new_plan=PLAN_B,
                policy=policy,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )
        assert res.credit_delta == 200
        assert provider.last_charge is not None
        assert provider.last_charge["amount_minor"] == 1032
        assert provider.last_charge["currency"] == "USD"
        bal = await ledger.balance("cust_toss_1", None, clock.now())
        assert bal.available == 200

    run(scenario())


def test_ec_f_self_scheduling_upgrade_without_billing_key_raises():
    async def scenario():
        clock, ledger, repo, ids = await setup()
        sub = mk_sub(
            id="sub_toss_2",
            customer_id="cust_toss_2",
            provider="toss",
            provider_ref="toss_sub_2",
            billing_key=None,
        )
        await repo.subscriptions.put(sub)
        provider = FakeSelfSchedulingProvider()
        policy = resolve_policy()

        with pytest.raises(Exception):  # noqa: B017 -- fake raises a bare Exception on purpose
            await upgrade(
                UpgradeInput(
                    sub=sub,
                    new_plan=PLAN_B,
                    policy=policy,
                    provider=provider,
                    ledger=ledger,
                    repo=repo,
                    clock=clock,
                    ids=ids,
                )
            )

    run(scenario())


def test_j1_calling_upgrade_twice_with_default_key_grants_exactly_once():
    async def scenario():
        clock, ledger, repo, ids = await setup()
        sub = mk_sub()
        await repo.subscriptions.put(sub)
        provider = FakeNativeProvider()
        provider.set_dummy_sub(sub)
        policy = resolve_policy({"upgrade": {"mode": "immediate_prorate_keep_anchor"}})

        first = await upgrade(
            UpgradeInput(
                sub=sub,
                new_plan=PLAN_B,
                policy=policy,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )
        second = await upgrade(
            UpgradeInput(
                sub=sub,
                new_plan=PLAN_B,
                policy=policy,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
                ids=ids,
            )
        )

        assert second.credit_delta == first.credit_delta
        assert second.sub == first.sub
        assert (
            provider.change_subscription_called == 1
        )  # not re-charged at the provider
        bal = await ledger.balance("cust_1", None, clock.now())
        assert bal.available == 200  # granted exactly once, not 400

    run(scenario())


def test_j2_retried_upgrade_with_same_key_but_different_new_plan_raises_idempotency_key_reused():
    import dataclasses

    from boilpayment_core import PaymentKitError

    async def scenario():
        clock, ledger, repo, ids = await setup()
        sub = mk_sub()
        await repo.subscriptions.put(sub)
        provider = FakeNativeProvider()
        provider.set_dummy_sub(sub)
        policy = resolve_policy()

        await upgrade(
            UpgradeInput(
                sub=sub,
                new_plan=PLAN_B,
                policy=policy,
                provider=provider,
                ledger=ledger,
                repo=repo,
                clock=clock,
                ids=ids,
                idempotency_key="upgrade:fixed",
            )
        )

        plan_c = dataclasses.replace(PLAN_B, id="plan_c", credits_per_period=500)
        try:
            await upgrade(
                UpgradeInput(
                    sub=sub,
                    new_plan=plan_c,
                    policy=policy,
                    provider=provider,
                    ledger=ledger,
                    repo=repo,
                    clock=clock,
                    ids=ids,
                    idempotency_key="upgrade:fixed",
                )
            )
            raise AssertionError("expected idempotency_key_reused")
        except PaymentKitError as err:
            assert err.code == "idempotency_key_reused"

    run(scenario())
