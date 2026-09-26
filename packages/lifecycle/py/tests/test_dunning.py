"""spec: packages/lifecycle/spec/lifecycle.pseudo.md [EC:A13] [EC:A16] [EC:A17] [EC:A24]"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from boilpayment_core import (
    CollectingNotifier,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    LedgerReference,
    Money,
    NewLedgerEntry,
    Payment,
    Period,
    Plan,
    PlanPrice,
    SequentialIdGen,
    Subscription,
    resolve_policy,
)
from boilpayment_lifecycle.dunning import (
    OnGraceExpiredInput,
    OnPaymentFailedInput,
    OnRecoveredInput,
    RetryDueInput,
    RunRetryInput,
    on_grace_expired,
    on_payment_failed,
    on_recovered,
    retry_due,
    run_retry,
)
from helpers import FakeNativeProvider, FakeSelfSchedulingProvider

PLAN = Plan(
    id="plan_a",
    name="Plan A",
    interval="month",
    credits_per_period=100,
    usage_included=0,
    trial_days=0,
    prices=[PlanPrice(currency="USD", amount_minor=1000)],
)
PERIOD = Period(
    start=datetime(2024, 1, 1, tzinfo=UTC), end=datetime(2024, 2, 1, tzinfo=UTC)
)


def run(coro):
    return asyncio.run(coro)


def mk_sub(**overrides) -> Subscription:
    base = {
        "id": "sub_1",
        "customer_id": "cust_1",
        "plan_id": PLAN.id,
        "provider": "stripe",
        "provider_ref": "stripe_sub_1",
        "status": "active",
        "current_period": PERIOD,
        "anchor_day": 1,
        "cancel_at_period_end": False,
        "grace_until": None,
        "billing_key": None,
        "scheduled_plan_id": None,
        "created_at": PERIOD.start,
    }
    base.update(overrides)
    return Subscription(**base)


def mk_payment() -> Payment:
    return Payment(
        id="pay_2",
        customer_id="cust_1",
        provider="stripe",
        provider_ref="pi_2",
        subscription_id="sub_1",
        amount=Money(amount_minor=1000, currency="USD"),
        status="succeeded",
        kind="subscription",
        period=None,
        occurred_at=PERIOD.start,
        failure=None,
    )


def test_ec_a13_on_payment_failed_default_grace_7_days():
    async def scenario():
        clock = FixedClock(datetime(2024, 1, 16, tzinfo=UTC))
        repo = InMemoryRepo()
        notifier = CollectingNotifier()
        sub = mk_sub()
        await repo.subscriptions.put(sub)
        policy = resolve_policy()

        res = await on_payment_failed(
            OnPaymentFailedInput(
                sub=sub, policy=policy, repo=repo, notifier=notifier, clock=clock
            )
        )
        assert res.sub.status == "past_due"
        assert res.sub.grace_until == datetime(2024, 1, 23, tzinfo=UTC)
        assert [n.type for n in notifier.sent] == ["payment.failed", "grace.started"]

    run(scenario())


def test_ec_a13_grace_days_0_no_grace_started_notification():
    async def scenario():
        clock = FixedClock(datetime(2024, 1, 16, tzinfo=UTC))
        repo = InMemoryRepo()
        notifier = CollectingNotifier()
        sub = mk_sub()
        await repo.subscriptions.put(sub)
        policy = resolve_policy({"dunning": {"graceDays": 0}})

        res = await on_payment_failed(
            OnPaymentFailedInput(
                sub=sub, policy=policy, repo=repo, notifier=notifier, clock=clock
            )
        )
        assert res.sub.grace_until == clock.now()
        assert [n.type for n in notifier.sent] == ["payment.failed"]

    run(scenario())


def test_ec_a16_revoke_unpaid_period_default_revokes_current_period_grant():
    async def scenario():
        clock = FixedClock(datetime(2024, 1, 23, tzinfo=UTC))
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        repo = InMemoryRepo()
        notifier = CollectingNotifier()
        sub = mk_sub(status="past_due", grace_until=clock.now())
        await repo.subscriptions.put(sub)
        await ledger.append(
            NewLedgerEntry(
                customer_id="cust_1",
                pool="paid",
                kind="grant",
                amount=100,
                source="subscription",
                reference=LedgerReference(),
                idempotency_key=f"grant:{sub.id}:{PERIOD.start.isoformat()}",
                actor="system",
            )
        )
        policy = resolve_policy()

        res = await on_grace_expired(
            OnGraceExpiredInput(
                sub=sub,
                policy=policy,
                ledger=ledger,
                repo=repo,
                notifier=notifier,
                clock=clock,
            )
        )
        assert res.sub.status == "expired"
        assert len(res.revoked) == 1
        assert res.revoked[0].amount == -100
        bal = await ledger.balance("cust_1", None, clock.now())
        assert bal.available == 0
        assert [n.type for n in notifier.sent] == ["grace.ending"]

    run(scenario())


def test_ec_a16_revoke_all_revokes_entire_paid_balance():
    async def scenario():
        clock = FixedClock(datetime(2024, 1, 23, tzinfo=UTC))
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        repo = InMemoryRepo()
        notifier = CollectingNotifier()
        sub = mk_sub(status="past_due", grace_until=clock.now())
        await repo.subscriptions.put(sub)
        await ledger.append(
            NewLedgerEntry(
                customer_id="cust_1",
                pool="paid",
                kind="grant",
                amount=150,
                source="manual",
                reference=LedgerReference(),
                idempotency_key="extra_grant",
                actor="system",
            )
        )
        policy = resolve_policy({"dunning": {"onFinalFailure": "revoke_all"}})

        res = await on_grace_expired(
            OnGraceExpiredInput(
                sub=sub,
                policy=policy,
                ledger=ledger,
                repo=repo,
                notifier=notifier,
                clock=clock,
            )
        )
        assert res.revoked[0].amount == -150
        bal = await ledger.balance("cust_1", None, clock.now())
        assert bal.available == 0

    run(scenario())


def test_ec_a16_keep_leaves_balance_untouched():
    async def scenario():
        clock = FixedClock(datetime(2024, 1, 23, tzinfo=UTC))
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        repo = InMemoryRepo()
        notifier = CollectingNotifier()
        sub = mk_sub(status="past_due", grace_until=clock.now())
        await repo.subscriptions.put(sub)
        await ledger.append(
            NewLedgerEntry(
                customer_id="cust_1",
                pool="paid",
                kind="grant",
                amount=80,
                source="subscription",
                reference=LedgerReference(),
                idempotency_key="g1",
                actor="system",
            )
        )
        policy = resolve_policy({"dunning": {"onFinalFailure": "keep"}})

        res = await on_grace_expired(
            OnGraceExpiredInput(
                sub=sub,
                policy=policy,
                ledger=ledger,
                repo=repo,
                notifier=notifier,
                clock=clock,
            )
        )
        assert res.revoked == []
        bal = await ledger.balance("cust_1", None, clock.now())
        assert bal.available == 80

    run(scenario())


def test_ec_a17_regrant_current_period_default():
    async def scenario():
        clock = FixedClock(PERIOD.start)
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        repo = InMemoryRepo()
        await repo.plans.put(PLAN)
        sub = mk_sub(status="expired", grace_until=None)
        await repo.subscriptions.put(sub)
        policy = resolve_policy()

        res = await on_recovered(
            OnRecoveredInput(
                sub=sub,
                payment=mk_payment(),
                policy=policy,
                ledger=ledger,
                repo=repo,
                clock=clock,
            )
        )
        assert res.sub.status == "active"
        assert res.sub.grace_until is None
        assert len(res.grants) == 1
        assert res.grants[0].entry.amount == 100
        bal = await ledger.balance("cust_1", None, clock.now())
        assert bal.available == 100

    run(scenario())


def test_ec_a17_no_regrant_just_reactivates():
    async def scenario():
        clock = FixedClock(PERIOD.start)
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        repo = InMemoryRepo()
        await repo.plans.put(PLAN)
        sub = mk_sub(status="expired", grace_until=None)
        await repo.subscriptions.put(sub)
        policy = resolve_policy({"dunning": {"onRecovery": "no_regrant"}})

        res = await on_recovered(
            OnRecoveredInput(
                sub=sub,
                payment=mk_payment(),
                policy=policy,
                ledger=ledger,
                repo=repo,
                clock=clock,
            )
        )
        assert res.sub.status == "active"
        assert res.grants == []
        bal = await ledger.balance("cust_1", None, clock.now())
        assert bal.available == 0

    run(scenario())


def test_ec_a17_regrant_all_missed_single_period_simplification():
    async def scenario():
        clock = FixedClock(PERIOD.start)
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        repo = InMemoryRepo()
        await repo.plans.put(PLAN)
        sub = mk_sub(status="expired", grace_until=None)
        await repo.subscriptions.put(sub)
        policy = resolve_policy({"dunning": {"onRecovery": "regrant_all_missed"}})

        res = await on_recovered(
            OnRecoveredInput(
                sub=sub,
                payment=mk_payment(),
                policy=policy,
                ledger=ledger,
                repo=repo,
                clock=clock,
            )
        )
        assert len(res.grants) == 1
        assert res.grants[0].entry.amount == 100

    run(scenario())


def _dunning_policy(retry_attempts: int, retry_interval_hours: list[int]):
    return resolve_policy(
        {
            "dunning": {
                "retryAttempts": retry_attempts,
                "retryIntervalHours": retry_interval_hours,
            }
        }
    )


def test_ec_a24_on_payment_failed_schedules_attempt_1():
    async def scenario():
        clock = FixedClock(datetime(2024, 1, 16, tzinfo=UTC))
        repo = InMemoryRepo()
        notifier = CollectingNotifier()
        sub = mk_sub()
        await repo.subscriptions.put(sub)
        policy = _dunning_policy(3, [24, 72, 120])

        await on_payment_failed(
            OnPaymentFailedInput(
                sub=sub, policy=policy, repo=repo, notifier=notifier, clock=clock
            )
        )

        due = await retry_due(
            RetryDueInput(
                repo=repo,
                clock=FixedClock(datetime(2024, 1, 17, 0, 0, 0, 1000, tzinfo=UTC)),
            )
        )
        assert len(due) == 1
        assert due[0].payload["subscription_id"] == sub.id
        assert due[0].payload["attempt"] == 1
        assert due[0].next_attempt_at == datetime(2024, 1, 17, tzinfo=UTC)  # +24h

    run(scenario())


def test_ec_a24_retry_attempts_0_schedules_nothing():
    async def scenario():
        clock = FixedClock(datetime(2024, 1, 16, tzinfo=UTC))
        repo = InMemoryRepo()
        notifier = CollectingNotifier()
        sub = mk_sub()
        await repo.subscriptions.put(sub)
        policy = resolve_policy({"dunning": {"retryAttempts": 0}})

        await on_payment_failed(
            OnPaymentFailedInput(
                sub=sub, policy=policy, repo=repo, notifier=notifier, clock=clock
            )
        )

        due = await retry_due(
            RetryDueInput(repo=repo, clock=FixedClock(datetime(2030, 1, 1, tzinfo=UTC)))
        )
        assert due == []

    run(scenario())


def test_ec_a24_retry_due_orders_earliest_first():
    async def scenario():
        repo = InMemoryRepo()
        notifier = CollectingNotifier()
        policy = _dunning_policy(3, [24, 72, 120])
        sub_a = mk_sub(id="sub_a")
        sub_b = mk_sub(id="sub_b")
        await repo.subscriptions.put(sub_a)
        await repo.subscriptions.put(sub_b)
        await on_payment_failed(
            OnPaymentFailedInput(
                sub=sub_a,
                policy=policy,
                repo=repo,
                notifier=notifier,
                clock=FixedClock(datetime(2024, 1, 10, tzinfo=UTC)),
            )
        )  # due 2024-01-11
        await on_payment_failed(
            OnPaymentFailedInput(
                sub=sub_b,
                policy=policy,
                repo=repo,
                notifier=notifier,
                clock=FixedClock(datetime(2024, 1, 9, tzinfo=UTC)),
            )
        )  # due 2024-01-10

        due = await retry_due(
            RetryDueInput(
                repo=repo, clock=FixedClock(datetime(2024, 1, 12, tzinfo=UTC))
            )
        )
        assert [d.payload["subscription_id"] for d in due] == ["sub_b", "sub_a"]

    run(scenario())


def test_ec_a24_shorter_retry_interval_hours_repeats_last_value():
    async def scenario():
        clock = FixedClock(datetime(2024, 1, 16, tzinfo=UTC))
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        repo = InMemoryRepo()
        notifier = CollectingNotifier()
        await repo.plans.put(PLAN)
        sub = mk_sub(status="past_due", billing_key="bk_1", provider="toss")
        await repo.subscriptions.put(sub)
        policy = _dunning_policy(3, [24])  # only one interval value

        await on_payment_failed(
            OnPaymentFailedInput(
                sub=sub, policy=policy, repo=repo, notifier=notifier, clock=clock
            )
        )
        due1 = await retry_due(
            RetryDueInput(
                repo=repo,
                clock=FixedClock(datetime(2024, 1, 17, 0, 0, 0, 1000, tzinfo=UTC)),
            )
        )
        item1 = due1[0]
        assert item1.next_attempt_at == datetime(2024, 1, 17, tzinfo=UTC)  # +24h

        provider = FakeSelfSchedulingProvider()
        provider.next_charge_status = "failed"
        retry_clock = FixedClock(datetime(2024, 1, 17, 0, 0, 0, 1000, tzinfo=UTC))
        await run_retry(
            RunRetryInput(
                item=item1,
                provider=provider,
                repo=repo,
                ledger=ledger,
                policy=policy,
                notifier=notifier,
                clock=retry_clock,
            )
        )

        due2 = await retry_due(
            RetryDueInput(
                repo=repo,
                clock=FixedClock(datetime(2024, 1, 18, 0, 0, 0, 1000, tzinfo=UTC)),
            )
        )
        item2 = due2[0]
        assert item2.payload["attempt"] == 2
        assert item2.next_attempt_at == datetime(
            2024, 1, 18, 0, 0, 0, 1000, tzinfo=UTC
        )  # +24h again

    run(scenario())


def test_ec_a24_failed_charge_notifies_and_schedules_next():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        repo = InMemoryRepo()
        notifier = CollectingNotifier()
        await repo.plans.put(PLAN)
        sub = mk_sub(status="past_due", billing_key="bk_1", provider="toss")
        await repo.subscriptions.put(sub)
        policy = _dunning_policy(3, [24, 72, 120])
        await on_payment_failed(
            OnPaymentFailedInput(
                sub=sub,
                policy=policy,
                repo=repo,
                notifier=notifier,
                clock=FixedClock(datetime(2024, 1, 16, tzinfo=UTC)),
            )
        )

        retry_clock = FixedClock(datetime(2024, 1, 17, 0, 0, 0, 1000, tzinfo=UTC))
        due = await retry_due(RetryDueInput(repo=repo, clock=retry_clock))
        item = due[0]
        provider = FakeSelfSchedulingProvider()
        provider.next_charge_status = "failed"

        result = await run_retry(
            RunRetryInput(
                item=item,
                provider=provider,
                repo=repo,
                ledger=ledger,
                policy=policy,
                notifier=notifier,
                clock=retry_clock,
            )
        )
        assert result.outcome == "failed"
        assert provider.last_charge["idempotency_key"] == f"dunning-retry:{sub.id}:2024-02-01T00:00:00.000Z:1"  # EC:A35 period in the key
        assert "payment.failed" in [n.type for n in notifier.sent]
        assert "grace.ending" not in [
            n.type for n in notifier.sent
        ]  # not the last attempt yet

        next_due = await retry_due(
            RetryDueInput(
                repo=repo, clock=FixedClock(datetime(2024, 1, 20, 1, 0, 0, tzinfo=UTC))
            )
        )  # +72h from retry_clock
        assert len(next_due) == 1
        assert next_due[0].payload["attempt"] == 2

    run(scenario())


def test_ec_a24_retries_exhausted_last_attempt_notifies_grace_ending():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        repo = InMemoryRepo()
        notifier = CollectingNotifier()
        await repo.plans.put(PLAN)
        sub = mk_sub(status="past_due", billing_key="bk_1", provider="toss")
        await repo.subscriptions.put(sub)
        policy = _dunning_policy(1, [24])
        await on_payment_failed(
            OnPaymentFailedInput(
                sub=sub,
                policy=policy,
                repo=repo,
                notifier=notifier,
                clock=FixedClock(datetime(2024, 1, 16, tzinfo=UTC)),
            )
        )

        retry_clock = FixedClock(datetime(2024, 1, 17, 0, 0, 0, 1000, tzinfo=UTC))
        due = await retry_due(RetryDueInput(repo=repo, clock=retry_clock))
        item = due[0]
        provider = FakeSelfSchedulingProvider()
        provider.next_charge_status = "failed"

        result = await run_retry(
            RunRetryInput(
                item=item,
                provider=provider,
                repo=repo,
                ledger=ledger,
                policy=policy,
                notifier=notifier,
                clock=retry_clock,
            )
        )
        assert result.outcome == "failed"
        assert [n.type for n in notifier.sent] == [
            "payment.failed",
            "grace.started",
            "payment.failed",
            "grace.ending",
        ]

        next_due = await retry_due(
            RetryDueInput(repo=repo, clock=FixedClock(datetime(2030, 1, 1, tzinfo=UTC)))
        )
        assert next_due == []  # exhausted — on_grace_expired path finishes it

    run(scenario())


def test_ec_a24_successful_charge_routes_into_on_recovered():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        repo = InMemoryRepo()
        notifier = CollectingNotifier()
        await repo.plans.put(PLAN)
        sub = mk_sub(status="past_due", billing_key="bk_1", provider="toss")
        await repo.subscriptions.put(sub)
        policy = _dunning_policy(3, [24, 72, 120])
        await on_payment_failed(
            OnPaymentFailedInput(
                sub=sub,
                policy=policy,
                repo=repo,
                notifier=notifier,
                clock=FixedClock(datetime(2024, 1, 16, tzinfo=UTC)),
            )
        )

        retry_clock = FixedClock(datetime(2024, 1, 17, 0, 0, 0, 1000, tzinfo=UTC))
        due = await retry_due(RetryDueInput(repo=repo, clock=retry_clock))
        item = due[0]
        provider = FakeSelfSchedulingProvider()
        provider.next_charge_status = "succeeded"

        result = await run_retry(
            RunRetryInput(
                item=item,
                provider=provider,
                repo=repo,
                ledger=ledger,
                policy=policy,
                notifier=notifier,
                clock=retry_clock,
            )
        )
        assert result.outcome == "recovered"
        assert result.sub.status == "active"
        assert len(result.grants) == 1
        bal = await ledger.balance("cust_1", None, retry_clock.now())
        assert bal.available == 100

        next_due = await retry_due(
            RetryDueInput(repo=repo, clock=FixedClock(datetime(2030, 1, 1, tzinfo=UTC)))
        )
        assert next_due == []  # recovered — no more retries scheduled

    run(scenario())


def test_ec_a24_already_recovered_is_skipped_not_double_charged():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        repo = InMemoryRepo()
        notifier = CollectingNotifier()
        sub = mk_sub(status="past_due", billing_key="bk_1", provider="toss")
        await repo.subscriptions.put(sub)
        policy = _dunning_policy(3, [24, 72, 120])
        await on_payment_failed(
            OnPaymentFailedInput(
                sub=sub,
                policy=policy,
                repo=repo,
                notifier=notifier,
                clock=FixedClock(datetime(2024, 1, 16, tzinfo=UTC)),
            )
        )

        retry_clock = FixedClock(datetime(2024, 1, 17, 0, 0, 0, 1000, tzinfo=UTC))
        due = await retry_due(RetryDueInput(repo=repo, clock=retry_clock))
        item = due[0]

        # the provider's own dunning (or a manual retry) already recovered it via a different path
        current = await repo.subscriptions.get(sub.id)
        from dataclasses import replace as dc_replace

        await repo.subscriptions.put(
            dc_replace(current, status="active", grace_until=None)
        )

        provider = (
            FakeSelfSchedulingProvider()
        )  # charge_billing_key raises if called unexpectedly
        result = await run_retry(
            RunRetryInput(
                item=item,
                provider=provider,
                repo=repo,
                ledger=ledger,
                policy=policy,
                notifier=notifier,
                clock=retry_clock,
            )
        )
        assert result.outcome == "skipped"
        assert provider.last_charge is None

    run(scenario())


def test_ec_a24_k1_version_conflict_during_recovery_retries():
    async def scenario():
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        repo = InMemoryRepo()
        notifier = CollectingNotifier()
        await repo.plans.put(PLAN)
        sub = mk_sub(status="past_due", billing_key="bk_1", provider="toss")
        await repo.subscriptions.put(sub)
        policy = _dunning_policy(3, [24, 72, 120])
        await on_payment_failed(
            OnPaymentFailedInput(
                sub=sub,
                policy=policy,
                repo=repo,
                notifier=notifier,
                clock=FixedClock(datetime(2024, 1, 16, tzinfo=UTC)),
            )
        )

        retry_clock = FixedClock(datetime(2024, 1, 17, 0, 0, 0, 1000, tzinfo=UTC))
        due = await retry_due(RetryDueInput(repo=repo, clock=retry_clock))
        item = due[0]

        class ConflictOnceProvider(FakeSelfSchedulingProvider):
            def __init__(self, repo, sub_id: str) -> None:
                super().__init__()
                self._repo = repo
                self._sub_id = sub_id
                self.fired = False

            async def charge_billing_key(self, **kwargs):
                if not self.fired:
                    self.fired = True
                    current = await self._repo.subscriptions.get(self._sub_id)
                    if current is not None:
                        # same version -> VersionedMemTable bumps it, simulating a concurrent writer
                        await self._repo.subscriptions.put(current)
                return await super().charge_billing_key(**kwargs)

        provider = ConflictOnceProvider(repo, sub.id)
        provider.next_charge_status = "succeeded"

        result = await run_retry(
            RunRetryInput(
                item=item,
                provider=provider,
                repo=repo,
                ledger=ledger,
                policy=policy,
                notifier=notifier,
                clock=retry_clock,
            )
        )
        assert result.outcome == "recovered"
        assert result.sub.status == "active"
        assert provider.fired is True

    run(scenario())


def test_ec_a24_provider_scheduled_dunning_only_advances_counter():
    async def scenario():
        repo = InMemoryRepo()
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        notifier = CollectingNotifier()
        sub = mk_sub(
            status="past_due", provider="stripe"
        )  # no billing_key — native provider
        await repo.subscriptions.put(sub)
        policy = _dunning_policy(2, [24, 72])
        await on_payment_failed(
            OnPaymentFailedInput(
                sub=sub,
                policy=policy,
                repo=repo,
                notifier=notifier,
                clock=FixedClock(datetime(2024, 1, 16, tzinfo=UTC)),
            )
        )

        retry_clock = FixedClock(datetime(2024, 1, 17, 0, 0, 0, 1000, tzinfo=UTC))
        due = await retry_due(RetryDueInput(repo=repo, clock=retry_clock))
        item = due[0]
        provider = (
            FakeNativeProvider()
        )  # charge_billing_key raises 'unexpected call' if invoked

        result = await run_retry(
            RunRetryInput(
                item=item,
                provider=provider,
                repo=repo,
                ledger=ledger,
                policy=policy,
                notifier=notifier,
                clock=retry_clock,
            )
        )
        assert result.outcome == "deferred_to_provider"
        assert [n.type for n in notifier.sent] == ["payment.failed", "grace.started"]

        next_due = await retry_due(
            RetryDueInput(
                repo=repo, clock=FixedClock(datetime(2024, 1, 20, 1, 0, 0, tzinfo=UTC))
            )
        )
        assert len(next_due) == 1
        assert next_due[0].payload["attempt"] == 2

    run(scenario())
