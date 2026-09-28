"""spec: packages/lifecycle/spec/lifecycle.pseudo.md — EC:A65. Mirrors start.ts.

Start a self-scheduled subscription (Toss/PortOne) from a billing key the app just issued: the first
period is charged through the same attempt path as renewals, then the subscription goes active and the
period's credits are granted. Hosted-checkout providers (Stripe/Polar) start through checkout.
"""

from __future__ import annotations

import dataclasses
import hashlib
from dataclasses import dataclass

from boilpayment_core import (
    Clock,
    Customer,
    LedgerStore,
    Notifier,
    Payment,
    PaymentKitError,
    PaymentProvider,
    Period,
    Policy,
    ProviderRef,
    Repo,
    Subscription,
    civil_day_of,
)

from .charge_attempt import (
    ChargeAttemptInput,
    charge_attempt,
    renewal_attempt_key,
    with_attempt_lease,
)
from .internal import require_price_for_subscription
from .period import next_period
from .renewal import OnRenewalPaidInput, on_renewal_paid


@dataclass(kw_only=True, slots=True)
class StartSubscriptionInput:
    customer_id: str
    plan_id: str
    currency: str
    # The billing key the provider issued (Toss billing/authorizations/issue, PortOne billing key).
    billing_key: str
    # The app's id for this sign-up; the same id never starts (or charges) twice.
    request_id: str
    provider: PaymentProvider
    policy: Policy
    ledger: LedgerStore
    repo: Repo
    clock: Clock
    # The provider customer key the billing key was issued under (Toss customerKey). Default: customer_id.
    customer_ref: str | None = None
    notifier: Notifier | None = None
    correlation_id: str | None = None


@dataclass(kw_only=True, slots=True)
class StartSubscriptionResult:
    sub: Subscription
    payment: Payment


def started_subscription_id(customer_id: str, request_id: str) -> str:
    """EC:A65 -- the subscription id for one sign-up request (found again on every retry)."""
    return "sub_" + hashlib.sha256(f"start:{customer_id}:{request_id}".encode()).hexdigest()[:24]


async def start_subscription(input: StartSubscriptionInput) -> StartSubscriptionResult:
    """EC:A65 -- the subscription row is written ``incomplete`` before the charge, so a retry with the same
    request_id re-drives the same attempt (lookup first, EC:A49) instead of charging again. A declined
    charge leaves it ``incomplete`` and raises ``subscription_start_declined``; an unknown outcome raises
    ``subscription_start_unresolved`` -- call again with the same request_id."""
    provider, repo, clock, policy = input.provider, input.repo, input.clock, input.policy
    if provider.capabilities().native_subscriptions:
        raise PaymentKitError(f"{provider.name} subscriptions start through checkout", "use_checkout", {"provider": provider.name})
    plan = await repo.plans.get(input.plan_id)
    if plan is None or plan.interval is None:
        raise PaymentKitError(f"not a subscription plan: {input.plan_id}", "plan_not_found", {"plan_id": input.plan_id})
    customer_ref = input.customer_ref or input.customer_id
    await _ensure_customer(repo, clock, input.customer_id, provider.name, customer_ref)

    sub_id = started_subscription_id(input.customer_id, input.request_id)
    sub = await repo.subscriptions.get(sub_id)
    if sub is not None and (sub.plan_id != input.plan_id or sub.billing_key != input.billing_key):
        raise PaymentKitError("this request_id started a different subscription", "idempotency_key_reused", {"subscription_id": sub_id})
    # EC:A72 -- a sign-up whose first charge was declined is closed; a new attempt needs a new request_id.
    if sub is not None and sub.status == "expired":
        raise PaymentKitError("the first charge was declined", "subscription_start_declined", {"subscription_id": sub_id})
    if sub is None:
        # EC:A72 -- under multiple_per_customer=deny the check and the draft write run under one per-customer
        # lease, so two sign-ups at once (different request_ids) cannot both create a live subscription.
        held, value = await with_attempt_lease(repo, clock, f"start:{input.customer_id}",
                                               lambda: _create_draft(input, plan, sub_id, customer_ref))
        if not held:
            raise PaymentKitError("another sign-up of this customer is in progress", "subscription_start_in_flight",
                                  {"customer_id": input.customer_id})
        sub = value
    assert sub is not None
    price = require_price_for_subscription(plan, sub)
    outcome = await charge_attempt(ChargeAttemptInput(
        provider=provider, repo=repo, clock=clock, sub=sub, price=price, period=sub.current_period,
        attempt_key=renewal_attempt_key(sub, sub.current_period), correlation_id=input.correlation_id, notifier=input.notifier,
    ))
    if outcome.kind == "succeeded":
        assert outcome.payment is not None
        if sub.status == "active":
            return StartSubscriptionResult(sub=sub, payment=outcome.payment)
        paid = await on_renewal_paid(OnRenewalPaidInput(
            sub=sub, payment=dataclasses.replace(outcome.payment, period=sub.current_period), policy=policy,
            ledger=input.ledger, repo=repo, clock=clock,
        ))
        started = paid.sub
        if started.status == "incomplete":
            # A retry after the grant was written but the activation was not: finish the write.
            started = dataclasses.replace(started, status="active")
            await repo.subscriptions.put(started)
        return StartSubscriptionResult(sub=started, payment=outcome.payment)
    if outcome.kind == "declined":
        # EC:A72 -- close the declined sign-up so it never becomes the customer's current subscription.
        current = await repo.subscriptions.get(sub_id) or sub
        if current.status == "incomplete":
            await repo.subscriptions.put(dataclasses.replace(current, status="expired"))
        raise PaymentKitError("the first charge was declined", "subscription_start_declined", {"subscription_id": sub_id, "payment": outcome.payment})
    if outcome.kind == "unresolved":
        raise PaymentKitError("the first charge has no answer yet; call again with the same request_id",
                              "subscription_start_unresolved", {"subscription_id": sub_id, "reason": outcome.reason})
    raise PaymentKitError("this sign-up is being charged right now", "subscription_start_in_flight", {"subscription_id": sub_id})


# Statuses that count as a live subscription for multiple_per_customer=deny (EC:A72).
_LIVE = frozenset({"active", "trialing", "past_due", "incomplete"})


async def _create_draft(input: StartSubscriptionInput, plan, sub_id: str, customer_ref: str) -> Subscription:  # type: ignore[no-untyped-def]
    repo, clock, policy, provider = input.repo, input.clock, input.policy, input.provider
    raced = await repo.subscriptions.get(sub_id)
    if raced is not None:
        return raced
    if policy.subscription.multiple_per_customer == "deny":
        live = [s for s in await repo.subscriptions.list(customer_id=input.customer_id) if s.status in _LIVE]
        if live:
            raise PaymentKitError("the customer already has a subscription", "subscription_exists",
                                  {"customer_id": input.customer_id, "subscription_id": live[0].id})
    now = clock.now()
    # EC:A71 -- the anchor is the start's civil day in the policy timezone, so the first period is one interval.
    anchor_day = civil_day_of(now, policy.period.timezone)
    period = next_period(Period(start=now, end=now), plan.interval, anchor_day, policy.period.timezone, policy.period.month_end_anchor)
    draft = Subscription(
        id=sub_id, customer_id=input.customer_id, plan_id=plan.id, provider=provider.name, provider_ref=None,  # type: ignore[arg-type]
        status="incomplete", current_period=period, anchor_day=anchor_day, cancel_at_period_end=False, grace_until=None,
        billing_key=input.billing_key, billing_customer_ref=customer_ref, scheduled_plan_id=None, currency=input.currency,
        version=0, created_at=now,
    )
    require_price_for_subscription(plan, draft)  # a plan without a price in this currency is refused before any write
    await repo.subscriptions.put(draft)
    stored = await repo.subscriptions.get(sub_id)
    assert stored is not None
    return stored


async def _ensure_customer(repo: Repo, clock: Clock, customer_id: str, provider: str, ref: str) -> None:
    existing = await repo.customers.get(customer_id)
    if existing is None:
        await repo.customers.put(Customer(id=customer_id, email=None, provider_refs=[ProviderRef(provider=provider, ref=ref)],  # type: ignore[arg-type]
                                          status="active", created_at=clock.now()))
        return
    # EC:A66 -- a frozen (open dispute) or banned customer does not start a new subscription.
    if existing.status != "active":
        raise PaymentKitError(f"customer is {existing.status}", f"customer_{existing.status}", {"customer_id": customer_id})
    if not any(r.provider == provider for r in existing.provider_refs):
        await repo.customers.put(dataclasses.replace(existing, provider_refs=[*existing.provider_refs,
                                                                              ProviderRef(provider=provider, ref=ref)]))  # type: ignore[arg-type]
