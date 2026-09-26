"""Runs the real lifecycle.* (+ transitively credits.*) code path against core's in-memory
reference implementations. No test framework — prints balances/state at each step; compare
byte-for-byte against ts/examples/smoke.ts's stdout.

Run: .venv/bin/python packages/lifecycle/py/examples/smoke.py
"""

from __future__ import annotations

import asyncio
import dataclasses
from datetime import UTC, datetime, timedelta
from typing import Any

from schift_payment_kit_core import (
    Checkout,
    CollectingNotifier,
    CreateCheckoutInput,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    Money,
    NormalizedEvent,
    Payment,
    PaymentFailure,
    PaymentKitError,
    Period,
    Plan,
    PlanPrice,
    ProviderCapabilities,
    Refund,
    SequentialIdGen,
    Subscription,
    resolve_policy,
)
from schift_payment_kit_credits import (
    ConsumeCreditsInput,
    ManualAdjustInput,
    NotifyExpiringInput,
    consume,
    manual_revoke,
    notify_expiring,
)
from schift_payment_kit_lifecycle import (
    DowngradeInput,
    OnRenewalPaidInput,
    UpgradeInput,
    downgrade,
    on_renewal_paid,
    upgrade,
)
from schift_payment_kit_lifecycle.dunning import (
    OnPaymentFailedInput,
    OnRecoveredInput,
    RetryDueInput,
    RunRetryInput,
    on_payment_failed,
    on_recovered,
    retry_due,
    run_retry,
)

DUMMY_SUB: Subscription | None = None  # assigned once `sub` exists, in main()


class FakeSelfSchedulingProvider:
    """EC:F — Toss-shaped self-scheduling provider: no native subscription tracking.
    get_subscription/change_subscription/cancel_subscription raise exactly like the real
    Toss/PortOne provider implementations do, so if lifecycle.upgrade ever regressed into calling
    change_subscription for a non-native provider, this smoke would fail loudly instead of
    silently passing."""

    name = "toss"

    def __init__(self) -> None:
        self.last_charge: dict[str, Any] | None = None
        self.next_charge_status: str = (
            "succeeded"  # EC:A24 smoke steps flip this to force a retry
        )

    def capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            native_subscriptions=False,
            partial_refund=True,
            meters=False,
            scheduling="self",
            webhook_signature=False,
        )

    async def create_customer(self, **kwargs: Any) -> dict[str, str]:
        return {"ref": "cus_toss_fake"}

    async def create_checkout(self, input: CreateCheckoutInput) -> Checkout:
        raise NotImplementedError("not used in this scenario")

    async def get_payment(self, provider_ref: str) -> Payment:
        raise NotImplementedError("not used in this scenario")

    async def list_payments(self, **kwargs: Any) -> list[Payment]:
        return []

    async def get_subscription(self, provider_ref: str) -> Subscription:
        raise PaymentKitError("unsupported", "unsupported")

    async def change_subscription(
        self, provider_ref: str, **kwargs: Any
    ) -> Subscription:
        raise PaymentKitError("unsupported", "unsupported")

    async def cancel_subscription(
        self, provider_ref: str, **kwargs: Any
    ) -> Subscription:
        raise PaymentKitError("unsupported", "unsupported")

    async def charge_billing_key(self, **kwargs: Any) -> Payment:
        amount: Money = kwargs["amount"]
        self.last_charge = {
            "amount_minor": amount.amount_minor,
            "currency": amount.currency,
        }
        return Payment(
            id=f"pay_{kwargs['idempotency_key']}",
            customer_id=kwargs["customer_ref"],
            provider="toss",
            provider_ref=kwargs["order_id"],
            subscription_id=None,
            amount=amount,
            status=self.next_charge_status,
            kind="subscription",
            period=None,
            occurred_at=datetime.now(UTC),
            failure=PaymentFailure(
                code="card_declined",
                provider_code=None,
                retryable=True,
                user_message="declined",
            )
            if self.next_charge_status == "failed"
            else None,
        )

    async def refund(self, **kwargs: Any) -> Refund:
        raise NotImplementedError("not used in this scenario")

    async def report_usage(self, **kwargs: Any) -> None:
        return None

    async def verify_webhook(self, **kwargs: Any) -> NormalizedEvent:
        raise NotImplementedError("not used in this scenario")


class FakeProvider:
    """Minimal canned PaymentProvider — only change_subscription is actually invoked by this
    scenario (upgrade/downgrade), and its return value is discarded by lifecycle. Everything else
    raises if hit, so a real call site accidentally exercising it would fail loudly."""

    name = "stripe"

    def capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            native_subscriptions=True,
            partial_refund=True,
            meters=False,
            scheduling="provider",
            webhook_signature=True,
        )

    async def create_customer(self, **kwargs: Any) -> dict[str, str]:
        return {"ref": "cus_fake"}

    async def create_checkout(self, input: CreateCheckoutInput) -> Checkout:
        raise NotImplementedError("not used in this scenario")

    async def get_payment(self, provider_ref: str) -> Payment:
        raise NotImplementedError("not used in this scenario")

    async def list_payments(self, **kwargs: Any) -> list[Payment]:
        return []

    async def get_subscription(self, provider_ref: str) -> Subscription:
        raise NotImplementedError("not used in this scenario")

    async def change_subscription(
        self, provider_ref: str, **kwargs: Any
    ) -> Subscription:
        assert DUMMY_SUB is not None
        return DUMMY_SUB

    async def cancel_subscription(
        self, provider_ref: str, **kwargs: Any
    ) -> Subscription:
        assert DUMMY_SUB is not None
        return DUMMY_SUB

    async def charge_billing_key(self, **kwargs: Any) -> Payment:
        raise NotImplementedError("not used in this scenario")

    async def refund(self, **kwargs: Any) -> Refund:
        raise NotImplementedError("not used in this scenario")

    async def report_usage(self, **kwargs: Any) -> None:
        return None

    async def verify_webhook(self, **kwargs: Any) -> NormalizedEvent:
        raise NotImplementedError("not used in this scenario")


async def main() -> None:
    global DUMMY_SUB

    clock = FixedClock(datetime(2024, 1, 1, tzinfo=UTC))
    ledger = InMemoryLedger(SequentialIdGen("led_"))
    repo = InMemoryRepo()
    notifier = CollectingNotifier()
    provider = FakeProvider()
    ids = SequentialIdGen("id_")
    policy = resolve_policy()  # DEFAULT_POLICY

    plan_a = Plan(
        id="plan_a",
        name="Plan A",
        interval="month",
        credits_per_period=100,
        usage_included=0,
        trial_days=0,
        prices=[PlanPrice(currency="USD", amount_minor=1000)],
    )
    plan_b = Plan(
        id="plan_b",
        name="Plan B",
        interval="month",
        credits_per_period=300,
        usage_included=0,
        trial_days=0,
        prices=[PlanPrice(currency="USD", amount_minor=3000)],
    )
    await repo.plans.put(plan_a)
    await repo.plans.put(plan_b)

    sub = Subscription(
        id="sub_1",
        customer_id="cust_1",
        plan_id=plan_a.id,
        provider="stripe",
        provider_ref="stripe_sub_1",
        status="active",
        current_period=Period(
            start=datetime(2024, 1, 1, tzinfo=UTC), end=datetime(2024, 2, 1, tzinfo=UTC)
        ),
        anchor_day=1,
        cancel_at_period_end=False,
        grace_until=None,
        billing_key=None,
        scheduled_plan_id=None,
        created_at=datetime(2024, 1, 1, tzinfo=UTC),
    )
    DUMMY_SUB = sub
    await repo.subscriptions.put(sub)

    async def show(label: str) -> None:
        balance = await ledger.balance(sub.customer_id, None, clock.now())
        print(
            f"{label}: balance={balance.available} status={sub.status} planId={sub.plan_id} periodStart={sub.current_period.start.isoformat()}"
        )

    # 1. on_renewal_paid grants the first period's credits (Jan 1 - Feb 1, plan A, $10 -> 100 credits)
    payment1 = Payment(
        id="pay_1",
        customer_id=sub.customer_id,
        provider="stripe",
        provider_ref="pi_1",
        subscription_id=sub.id,
        amount=Money(amount_minor=1000, currency="USD"),
        status="succeeded",
        kind="subscription",
        period=None,  # falls back to sub.current_period — see renewal.py
        occurred_at=clock.now(),
        failure=None,
    )
    r1 = await on_renewal_paid(
        OnRenewalPaidInput(
            sub=sub,
            payment=payment1,
            policy=policy,
            ledger=ledger,
            repo=repo,
            clock=clock,
        )
    )
    sub = r1.sub
    await show("01_renewal_paid_100")

    # 2. consume 30
    await consume(
        ConsumeCreditsInput(
            customer_id=sub.customer_id,
            amount=30,
            policy=policy,
            ledger=ledger,
            clock=clock,
            idempotency_key="consume_1",
        )
    )
    await show("02_consume_30")

    # 3. mid-cycle upgrade to plan B on Jan 16 (default policy: immediate_prorate_reset_anchor, full_delta)
    clock.advance(15 * 86_400_000)  # Jan 1 -> Jan 16
    u1 = await upgrade(
        UpgradeInput(
            sub=sub,
            new_plan=plan_b,
            policy=policy,
            provider=provider,
            ledger=ledger,
            repo=repo,
            clock=clock,
            ids=ids,
        )
    )
    sub = u1.sub
    print(
        f"03_upgrade_full_delta: creditDelta={u1.credit_delta} anchorDay={sub.anchor_day}"
    )
    await show("03_upgrade_full_delta")

    # 4. consume 250 (leaves only 20 — sets up a clawback shortfall below)
    await consume(
        ConsumeCreditsInput(
            customer_id=sub.customer_id,
            amount=250,
            policy=policy,
            ledger=ledger,
            clock=clock,
            idempotency_key="consume_2",
        )
    )
    await show("04_consume_250")

    # 5. downgrade back to plan A, immediate_clawback (custom policy) — wants to revoke 200 but only
    #    20 is available, so clamp_to_zero clamps the revoke and reports the shortfall.
    policy_clawback = resolve_policy({"downgrade": {"mode": "immediate_clawback"}})
    d1 = await downgrade(
        DowngradeInput(
            sub=sub,
            new_plan=plan_a,
            policy=policy_clawback,
            provider=provider,
            ledger=ledger,
            repo=repo,
            clock=clock,
            ids=ids,
        )
    )
    sub = d1.sub
    revoked = d1.clawback.revoked if d1.clawback else 0
    shortfall = d1.clawback.shortfall if d1.clawback else 0
    print(f"05_downgrade_clawback: revoked={revoked} shortfall={shortfall}")
    await show("05_downgrade_clawback")

    # 6. renewal payment fails -> grace period starts
    f1 = await on_payment_failed(
        OnPaymentFailedInput(
            sub=sub, policy=policy, repo=repo, notifier=notifier, clock=clock
        )
    )
    sub = f1.sub
    print(
        f"06_payment_failed: status={sub.status} graceUntil={sub.grace_until.isoformat() if sub.grace_until else None}"
    )

    # 7. payment recovers -> regrant current period
    payment2 = Payment(
        id="pay_2",
        customer_id=sub.customer_id,
        provider="stripe",
        provider_ref="pi_2",
        subscription_id=sub.id,
        amount=Money(amount_minor=1000, currency="USD"),
        status="succeeded",
        kind="subscription",
        period=None,
        occurred_at=clock.now(),
        failure=None,
    )
    rec1 = await on_recovered(
        OnRecoveredInput(
            sub=sub,
            payment=payment2,
            policy=policy,
            ledger=ledger,
            repo=repo,
            clock=clock,
        )
    )
    sub = rec1.sub
    await show("07_recovered")

    print(f"notifications={','.join(n.type for n in notifier.sent)}")

    # 8. EC:F — mid-cycle upgrade on a self-scheduling (Toss-shaped) provider: native_subscriptions
    #    is False, so upgrade() must NOT call change_subscription (it would raise
    #    PaymentKitError('unsupported') here, exactly like the real Toss/PortOne providers) —
    #    instead it charges the prorated money delta directly via charge_billing_key.
    toss_provider = FakeSelfSchedulingProvider()
    sub_toss = Subscription(
        id="sub_toss_1",
        customer_id="cust_toss_1",
        plan_id=plan_a.id,
        provider="toss",
        provider_ref="toss_sub_1",
        status="active",
        current_period=Period(
            start=datetime(2024, 1, 1, tzinfo=UTC), end=datetime(2024, 2, 1, tzinfo=UTC)
        ),
        anchor_day=1,
        cancel_at_period_end=False,
        grace_until=None,
        billing_key="bk_toss_1",
        scheduled_plan_id=None,
        created_at=datetime(2024, 1, 1, tzinfo=UTC),
    )
    await repo.subscriptions.put(sub_toss)

    payment_toss = Payment(
        id="pay_toss_1",
        customer_id=sub_toss.customer_id,
        provider="toss",
        provider_ref="toss_pi_1",
        subscription_id=sub_toss.id,
        amount=Money(amount_minor=1000, currency="USD"),
        status="succeeded",
        kind="subscription",
        period=None,
        occurred_at=clock.now(),
        failure=None,
    )
    r_toss1 = await on_renewal_paid(
        OnRenewalPaidInput(
            sub=sub_toss,
            payment=payment_toss,
            policy=policy,
            ledger=ledger,
            repo=repo,
            clock=clock,
        )
    )
    sub_toss = r_toss1.sub

    u_toss = await upgrade(
        UpgradeInput(
            sub=sub_toss,
            new_plan=plan_b,
            policy=policy,
            provider=toss_provider,
            ledger=ledger,
            repo=repo,
            clock=clock,
            ids=ids,
        )
    )
    sub_toss = u_toss.sub
    balance_toss = await ledger.balance(sub_toss.customer_id, None, clock.now())
    charged_minor = (
        toss_provider.last_charge["amount_minor"] if toss_provider.last_charge else None
    )
    charged_currency = (
        toss_provider.last_charge["currency"] if toss_provider.last_charge else None
    )
    print(
        f"08_self_scheduling_upgrade: changeSubscription_called=false creditDelta={u_toss.credit_delta} "
        f"balance={balance_toss.available} planId={sub_toss.plan_id} chargedMinor={charged_minor} chargedCurrency={charged_currency}"
    )

    # 9. EC:A24 — smart retry: a fresh past_due Toss subscription with a billing key. First retry
    #    attempt fails, second retry attempt (1 hour later per a custom short interval) succeeds and
    #    routes into dunning.on_recovered.
    retry_provider = FakeSelfSchedulingProvider()
    sub_retry = dataclasses.replace(
        sub_toss,
        id="sub_retry_1",
        customer_id="cust_retry_1",
        status="past_due",
        version=0,
    )
    await repo.subscriptions.put(sub_retry)
    retry_policy = resolve_policy(
        {"dunning": {"retryAttempts": 2, "retryIntervalHours": [1, 1, 1]}}
    )
    await on_payment_failed(
        OnPaymentFailedInput(
            sub=sub_retry,
            policy=retry_policy,
            repo=repo,
            notifier=notifier,
            clock=clock,
        )
    )
    clock.advance(3_600_000)  # +1h — attempt 1 due
    due = await retry_due(RetryDueInput(repo=repo, clock=clock))
    retry_provider.next_charge_status = "failed"
    attempt1 = await run_retry(
        RunRetryInput(
            item=due[0],
            provider=retry_provider,
            repo=repo,
            ledger=ledger,
            policy=retry_policy,
            notifier=notifier,
            clock=clock,
        )
    )
    print(
        f"09a_retry_attempt1: outcome={attempt1.outcome} charged={retry_provider.last_charge is not None}"
    )
    clock.advance(3_600_000)  # +1h — attempt 2 due
    due = await retry_due(RetryDueInput(repo=repo, clock=clock))
    retry_provider.next_charge_status = "succeeded"
    attempt2 = await run_retry(
        RunRetryInput(
            item=due[0],
            provider=retry_provider,
            repo=repo,
            ledger=ledger,
            policy=retry_policy,
            notifier=notifier,
            clock=clock,
        )
    )
    bal_retry = await ledger.balance("cust_retry_1", None, clock.now())
    print(
        f"09b_retry_attempt2: outcome={attempt2.outcome} subStatus={attempt2.sub.status if attempt2.sub else None} balance={bal_retry.available}"
    )

    # 10. EC:B17 — negative balance offset: manual_revoke pushes cust_offset_1 to -30, then a
    #     100-credit grant lands. offset_next_grant (default) settles 30 of the debt and caps the
    #     fresh grant's own bucket to 70 spendable.
    await manual_revoke(
        ManualAdjustInput(
            customer_id="cust_offset_1",
            pool="paid",
            amount=30,
            reason="chargeback",
            actor="admin",
            ledger=ledger,
            clock=clock,
            idempotency_key="debt_offset_1",
        )
    )
    sub_offset = dataclasses.replace(
        sub_toss,
        id="sub_offset_1",
        customer_id="cust_offset_1",
        plan_id=plan_a.id,
        status="active",
        version=0,
    )
    await repo.subscriptions.put(sub_offset)
    payment_offset = dataclasses.replace(
        payment_toss,
        id="pay_offset_1",
        customer_id="cust_offset_1",
        subscription_id=sub_offset.id,
    )
    r_offset = await on_renewal_paid(
        OnRenewalPaidInput(
            sub=sub_offset,
            payment=payment_offset,
            policy=policy,
            ledger=ledger,
            repo=repo,
            clock=clock,
        )
    )
    grant_offset = r_offset.grant
    bal_offset = await ledger.balance("cust_offset_1", None, clock.now())
    print(
        f"10_negative_offset: granted={grant_offset.entry.amount if grant_offset.entry else None} "
        f"offset={grant_offset.offset} balance={bal_offset.available}"
    )

    # 11. EC:B16 — expiry notice: cust_expire_1 has 100 credits expiring in 3 days; a 7-day notice
    #     window picks it up once, then is silent on a same-day rerun.
    sub_expire = dataclasses.replace(
        sub_toss,
        id="sub_expire_1",
        customer_id="cust_expire_1",
        plan_id=plan_a.id,
        status="active",
        version=0,
        current_period=Period(start=clock.now(), end=clock.now() + timedelta(days=3)),
    )
    payment_expire = dataclasses.replace(
        payment_toss,
        id="pay_expire_1",
        customer_id="cust_expire_1",
        subscription_id=sub_expire.id,
    )
    await on_renewal_paid(
        OnRenewalPaidInput(
            sub=sub_expire,
            payment=payment_expire,
            policy=policy,
            ledger=ledger,
            repo=repo,
            clock=clock,
        )
    )
    expiry_policy = resolve_policy({"credits": {"expiryNoticeDays": 7}})
    notice1 = await notify_expiring(
        NotifyExpiringInput(
            customer_id="cust_expire_1",
            ledger=ledger,
            repo=repo,
            notifier=notifier,
            policy=expiry_policy,
            clock=clock,
        )
    )
    notice2 = await notify_expiring(
        NotifyExpiringInput(
            customer_id="cust_expire_1",
            ledger=ledger,
            repo=repo,
            notifier=notifier,
            policy=expiry_policy,
            clock=clock,
        )
    )
    print(
        f"11_expiry_notice: first_pending={len(notice1.pending)} second_pending_same_day={len(notice2.pending)}"
    )


if __name__ == "__main__":
    asyncio.run(main())
