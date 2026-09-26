"""Smoke test -- real code path (no mocks of our own modules), only fake PaymentProviders
and a fake lifecycle dep. Run: .venv/bin/python packages/webhook/py/examples/smoke.py
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
from datetime import UTC, datetime

from schift_payment_kit_core import (
    DEFAULT_POLICY,
    FixedClock,
    InMemoryRepo,
    Money,
    NormalizedEvent,
    Notification,
    Payment,
    Period,
    ProviderCapabilities,
    SequentialIdGen,
    Subscription,
    WebhookSignatureError,
)
from schift_payment_kit_webhook import (
    default_handlers,
    get_grants_for_checkout,
    process,
    receive,
)

ids = SequentialIdGen("id_")
clock = FixedClock(datetime(2026, 2, 2, tzinfo=UTC))
repo = InMemoryRepo()
policy = DEFAULT_POLICY

fixed_period = Period(
    start=datetime(2026, 2, 1, tzinfo=UTC),
    end=datetime(2026, 3, 1, tzinfo=UTC),
)
fixed_payment = Payment(
    id="pay_1",
    customer_id="cust_1",
    provider="stripe",
    provider_ref="pi_1",
    subscription_id="sub_1",
    amount=Money(amount_minor=2900, currency="USD"),
    status="succeeded",
    kind="subscription",
    period=fixed_period,
    occurred_at=clock.now(),
    failure=None,
)
fixed_sub = Subscription(
    id="sub_1",
    customer_id="cust_1",
    plan_id="plan_pro",
    provider="stripe",
    provider_ref="sub_stripe_1",
    status="active",
    current_period=fixed_period,
    anchor_day=1,
    cancel_at_period_end=False,
    grace_until=None,
    billing_key=None,
    scheduled_plan_id=None,
    created_at=datetime(2026, 1, 1, tzinfo=UTC),
)


class FakeProvider:
    """EC:E4 -- accepts header x-sig: ok, else raises WebhookSignatureError. Parses raw_body JSON.
    get_payment/get_subscription stamp id/customer_id blank -- provider-adapter best-effort values
    that handlers must NOT trust as local identity (per team-lead)."""

    name = "stripe"

    def capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            native_subscriptions=True,
            partial_refund=True,
            meters=False,
            scheduling="provider",
            webhook_signature=True,
        )

    async def get_payment(self, provider_ref: str) -> Payment:
        return dataclasses.replace(fixed_payment, id="", customer_id="")

    async def get_subscription(self, provider_ref: str) -> Subscription:
        return dataclasses.replace(fixed_sub, id="", customer_id="")

    async def verify_webhook(
        self, *, headers: dict[str, str], raw_body: str
    ) -> NormalizedEvent:
        if headers.get("x-sig") != "ok":
            raise WebhookSignatureError()
        parsed = json.loads(raw_body)
        return NormalizedEvent(
            id=parsed["id"],
            provider="stripe",
            type=parsed["type"],
            occurred_at=datetime.fromisoformat(parsed["occurredAt"]),
            customer_ref=parsed.get("customerRef"),
            subscription_ref=parsed.get("subscriptionRef"),
            payment_ref=parsed.get("paymentRef"),
            amount=None,
            raw=parsed,
        )


provider = FakeProvider()


class TossLikeProvider(FakeProvider):
    """EC:F -- no native provider-side subscription; get_subscription must never be called."""

    name = "toss"

    def capabilities(self) -> ProviderCapabilities:
        return dataclasses.replace(super().capabilities(), native_subscriptions=False)

    async def get_subscription(self, provider_ref: str) -> Subscription:
        raise RuntimeError("unsupported: toss has no native subscription")


toss_provider = TossLikeProvider()

lifecycle_calls: list[str] = []


class FakeLifecycleDunning:
    async def on_payment_failed(self, *, sub, policy, repo, notifier, clock):
        lifecycle_calls.append(f"onPaymentFailed({sub.id})")


class FakeLifecycle:
    def __init__(self) -> None:
        self.dunning = FakeLifecycleDunning()

    async def on_renewal_paid(self, *, sub, payment, policy, ledger, repo, clock):
        lifecycle_calls.append(f"onRenewalPaid({sub.id})")


notifications: list[Notification] = []


class CollectingNotifier:
    async def send(self, n: Notification):
        notifications.append(n)


class FakeLedger:
    async def entries(self, customer_id, **filter):
        return []


def _to_dict(obj):
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return {f.name: _to_dict(getattr(obj, f.name)) for f in dataclasses.fields(obj)}
    if isinstance(obj, datetime):
        return obj.isoformat()
    return obj


async def main() -> None:
    await repo.subscriptions.put(fixed_sub)
    await repo.payments.put(
        fixed_payment
    )  # local row must pre-exist -- handlers no longer trust provider-guessed ids

    good_body = json.dumps(
        {
            "id": "evt_1",
            "type": "payment.succeeded",
            "occurredAt": clock.now().isoformat(),
            "subscriptionRef": fixed_sub.provider_ref,
            "paymentRef": fixed_payment.provider_ref,
        }
    )

    # -- EC:E4 -- bad signature -> 400, nothing stored --
    bad = await receive(
        provider=provider,
        headers={"x-sig": "nope"},
        raw_body=good_body,
        repo=repo,
        clock=clock,
    )
    print("[receive bad sig]", json.dumps(_to_dict(bad)))

    # -- EC:E5 -- good signature -> 200, stored --
    ok = await receive(
        provider=provider,
        headers={"x-sig": "ok"},
        raw_body=good_body,
        repo=repo,
        clock=clock,
    )
    print("[receive ok]", json.dumps(_to_dict(ok)))
    stored = await repo.webhook_events.get(ok.event_id)
    print("[stored record status]", stored.status if stored else None)

    # -- EC:E5 -- same event id again -> 200, duplicated --
    dup = await receive(
        provider=provider,
        headers={"x-sig": "ok"},
        raw_body=good_body,
        repo=repo,
        clock=clock,
    )
    print("[receive dup]", json.dumps(_to_dict(dup)))

    # -- EC:E3 -- process(): local repo rows resolved by provider_ref, verified via re-fetch, handler called --
    handlers = default_handlers(
        policy=policy,
        ledger=FakeLedger(),
        repo=repo,
        notifier=CollectingNotifier(),
        clock=clock,
        ids=ids,
        lifecycle=FakeLifecycle(),
    )
    await process(
        event_id=ok.event_id,
        providers={"stripe": provider},
        handlers=handlers,
        repo=repo,
        clock=clock,
    )
    processed = await repo.webhook_events.get(ok.event_id)
    print(
        "[process] record status:",
        processed.status if processed else None,
        "lifecycle calls:",
        lifecycle_calls,
        "(sub id is the LOCAL id, not the blank one the provider returned)",
    )

    # -- unknown_provider_ref -- event references a provider_ref with no local repo row --
    stray_body = json.dumps(
        {
            "id": "evt_stray",
            "type": "payment.succeeded",
            "occurredAt": clock.now().isoformat(),
            "subscriptionRef": "sub_stripe_UNKNOWN",
            "paymentRef": "pi_UNKNOWN",
        }
    )
    stray_ok = await receive(
        provider=provider,
        headers={"x-sig": "ok"},
        raw_body=stray_body,
        repo=repo,
        clock=clock,
    )
    await process(
        event_id=stray_ok.event_id,
        providers={"stripe": provider},
        handlers=handlers,
        repo=repo,
        clock=clock,
    )
    stray_record = await repo.webhook_events.get(stray_ok.event_id)
    print(
        "[unknown_provider_ref] record status:",
        stray_record.status if stray_record else None,
        "error:",
        stray_record.error if stray_record else None,
        "notifications:",
        json.dumps([_to_dict(n) for n in notifications]),
    )

    # -- EC:F -- Toss-like provider: native_subscriptions=False, get_subscription must not be called --
    toss_sub = dataclasses.replace(
        fixed_sub, id="sub_2", provider_ref="toss_sub_2", provider="toss"
    )
    toss_payment = dataclasses.replace(
        fixed_payment,
        id="pay_2",
        provider_ref="toss_pi_2",
        provider="toss",
        subscription_id=toss_sub.id,
    )
    await repo.subscriptions.put(toss_sub)
    await repo.payments.put(toss_payment)
    toss_body = json.dumps(
        {
            "id": "evt_toss",
            "type": "payment.succeeded",
            "occurredAt": clock.now().isoformat(),
            "subscriptionRef": toss_sub.provider_ref,
            "paymentRef": toss_payment.provider_ref,
        }
    )
    toss_ok = await receive(
        provider=toss_provider,
        headers={"x-sig": "ok"},
        raw_body=toss_body,
        repo=repo,
        clock=clock,
    )
    await process(
        event_id=toss_ok.event_id,
        providers={"toss": toss_provider},
        handlers=handlers,
        repo=repo,
        clock=clock,
    )
    toss_record = await repo.webhook_events.get(toss_ok.event_id)
    print(
        "[toss native_subscriptions=False] record status:",
        toss_record.status if toss_record else None,
        "(no throw even though get_subscription() would have thrown)",
        "lifecycle calls:",
        lifecycle_calls,
    )

    # -- EC:E13 -- get_grants_for_checkout polling helper --
    grants = await get_grants_for_checkout(
        checkout_id_or_payment_ref=fixed_payment.provider_ref,
        repo=repo,
        ledger=FakeLedger(),
    )
    print("[get_grants_for_checkout]", json.dumps(_to_dict(grants)))

    print("\nsmoke: OK")


if __name__ == "__main__":
    asyncio.run(main())
