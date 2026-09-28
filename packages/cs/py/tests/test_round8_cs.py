"""Round-8 audit regressions (bp-audit8.md): A8-9 (EC:A66 a ban ends the customer's subscriptions) and
A8-7 (EC:A65 A67 Toss checkout registration). Mirrors ts/test/round8-cs.test.ts."""

from __future__ import annotations

import asyncio
import dataclasses
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import pytest
from boilpayment_core import (
    Checkout,
    CollectingNotifier,
    Customer,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    Money,
    NormalizedEvent,
    Payment,
    PaymentKitError,
    Period,
    Plan,
    PlanPrice,
    ProviderCapabilities,
    ProviderRef,
    SequentialIdGen,
    Subscription,
    resolve_policy,
)
from boilpayment_cs import (
    DisputeInput,
    RegisterCompletedCheckoutInput,
    StartCheckoutInput,
    dispute,
    register_completed_checkout,
    start_checkout,
)

NOW = datetime(2026, 2, 20, tzinfo=UTC)
CLOCK = FixedClock(NOW)


def sub(sid: str, provider: str, provider_ref: str | None) -> Subscription:
    return Subscription(id=sid, customer_id="c1", plan_id="basic", provider=provider, provider_ref=provider_ref,  # type: ignore[arg-type]
                        status="active", current_period=Period(start=datetime(2026, 2, 1, tzinfo=UTC), end=datetime(2026, 3, 1, tzinfo=UTC)),
                        anchor_day=1, cancel_at_period_end=False, grace_until=None, billing_key=None if provider_ref else "bk1",
                        scheduled_plan_id=None, version=0, created_at=NOW)


async def lost_dispute(provider: Any = None):  # type: ignore[no-untyped-def]
    repo, ids = InMemoryRepo(), SequentialIdGen("id_")
    ledger, notifier, policy = InMemoryLedger(ids), CollectingNotifier(), resolve_policy()
    await repo.customers.put(Customer(id="c1", email=None, provider_refs=[ProviderRef(provider="stripe", ref="cus_1")],
                                      status="active", created_at=NOW))
    await repo.subscriptions.put(sub("s_stripe", "stripe", "sub_st"))
    await repo.subscriptions.put(sub("s_toss", "toss", None))

    def ev(type_: str, outcome: str | None = None) -> NormalizedEvent:
        return NormalizedEvent(id=f"evt_{type_}", provider="stripe", type=type_, occurred_at=NOW, customer_ref="c1",  # type: ignore[arg-type]
                               subscription_ref=None, payment_ref="pi_1", amount=None, raw={}, dispute_outcome=outcome)  # type: ignore[arg-type]

    for event in (ev("dispute.opened"), ev("dispute.closed", "lost")):
        await dispute(DisputeInput(event=event, policy=policy, ledger=ledger, repo=repo, notifier=notifier, clock=CLOCK, ids=ids, provider=provider))
    return repo, notifier


def told(notifier: CollectingNotifier) -> list[str]:
    return [n.payload["subscriptionId"] for n in notifier.sent if n.payload.get("kind") == "banned_customer_subscription"]


def test_a66_ban_cancels_at_the_provider_and_locally() -> None:
    canceled: list[str] = []

    async def cancel_subscription(ref: str, *, at_period_end: bool) -> Subscription:
        canceled.append(ref)
        return sub("x", "stripe", ref)

    stripe = SimpleNamespace(name="stripe", cancel_subscription=cancel_subscription, capabilities=lambda: ProviderCapabilities(
        native_subscriptions=True, partial_refund=True, meters=False, scheduling="provider", webhook_signature=True))

    async def scenario() -> None:
        repo, notifier = await lost_dispute(stripe)
        assert (await repo.customers.get("c1")).status == "banned"
        assert sorted((s.id, s.status) for s in await repo.subscriptions.list()) == [("s_stripe", "canceled"), ("s_toss", "canceled")]
        assert canceled == ["sub_st"]
        assert told(notifier) == []

    asyncio.run(scenario())


def test_a66_ban_without_the_provider_tells_a_person() -> None:
    async def scenario() -> None:
        repo, notifier = await lost_dispute()
        assert all(s.status == "canceled" for s in await repo.subscriptions.list())
        assert told(notifier) == ["s_stripe"]

    asyncio.run(scenario())


async def toss_setup(interval: str | None):  # type: ignore[no-untyped-def]
    repo, ids = InMemoryRepo(), SequentialIdGen("id_")
    await repo.customers.put(Customer(id="u1", email=None, provider_refs=[ProviderRef(provider="toss", ref="toss_u1")], status="active", created_at=NOW))
    await repo.plans.put(Plan(id="p", name="p", interval=interval, credits_per_period=1000, usage_included=0, trial_days=0,  # type: ignore[arg-type]
                              prices=[PlanPrice(currency="KRW", amount_minor=9900)]))
    live = Payment(id="x", customer_id="", provider="toss", provider_ref="pk_1", subscription_id=None, amount=Money(amount_minor=9900, currency="KRW"),
                   status="succeeded", kind="topup", period=None, occurred_at=NOW, failure=None, cash_receipt=None, raw={"orderId": "ord_checkout_1"})

    async def create_checkout(input: Any) -> Checkout:
        return Checkout(id="ord_checkout_1", url="https://example.test/pay", provider_ref="ord_checkout_1")

    async def get_payment(ref: str) -> Payment:
        return live

    async def list_payments(**kwargs: Any) -> list[Payment]:
        return []  # Toss's transaction list lags a fresh payment

    toss = SimpleNamespace(name="toss", capabilities=lambda: SimpleNamespace(native_subscriptions=False), create_checkout=create_checkout, get_payment=get_payment, list_payments=list_payments)
    deps = {"policy": resolve_policy(), "providers": {"toss": toss}, "ledger": InMemoryLedger(ids), "repo": repo, "clock": CLOCK, "ids": ids}
    await start_checkout(StartCheckoutInput(**deps, customer_id="u1", plan_id="p", provider="toss", currency="KRW", request_id="r1",
                                            success_url="https://x/ok", cancel_url="https://x/no"))
    return deps


def test_a67_toss_topup_registers_without_the_lagging_list() -> None:
    async def scenario() -> None:
        deps = await toss_setup(None)
        payment = await register_completed_checkout(RegisterCompletedCheckoutInput(**deps, customer_id="u1", checkout_id="ord_checkout_1", payment_ref="pk_1"))
        assert payment.kind == "topup"

    asyncio.run(scenario())


def test_a65_a74_toss_subscription_plan_is_refused_at_checkout() -> None:
    async def scenario() -> None:
        try:
            await toss_setup("month")
        except PaymentKitError as err:
            assert err.code == "use_start_subscription"
        else:
            raise AssertionError("expected use_start_subscription")

    asyncio.run(scenario())


@pytest.mark.parametrize("status", ["banned", "frozen"])
def test_a73_banned_or_frozen_customer_cannot_checkout(status: str) -> None:
    async def scenario() -> None:
        deps = await toss_setup(None)
        owner = await deps["repo"].customers.get("u1")
        await deps["repo"].customers.put(dataclasses.replace(owner, status=status))
        try:
            await start_checkout(StartCheckoutInput(**deps, customer_id="u1", plan_id="p", provider="toss", currency="KRW", request_id="r2",
                                                    success_url="https://x/ok", cancel_url="https://x/no"))
        except PaymentKitError as err:
            assert err.code == f"customer_{status}"
        else:
            raise AssertionError("expected refusal")

    asyncio.run(scenario())
