"""spec: packages/lifecycle/spec/lifecycle.pseudo.md — EC:F (Toss/Portone self-scheduling)"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field
from typing import assert_never

from boilpayment_core import (
    Clock,
    IdGen,
    LedgerStore,
    Money,
    NoopNotifier,
    Notifier,
    Payment,
    PaymentKitError,
    PaymentProvider,
    Period,
    Policy,
    Repo,
    Subscription,
)

from .dunning import OnPaymentFailedInput, on_payment_failed
from .internal import scope_provider
from .period import next_period
from .renewal import OnRenewalPaidInput, on_renewal_paid
from .retry import retry_on_version_conflict


@dataclass(kw_only=True, slots=True)
class DueSubscriptionsInput:
    repo: Repo
    clock: Clock


# EC:F — subscriptions whose current period has elapsed and which carry a billing key
# (self-scheduling providers: Toss/Portone have no native subscription/scheduler).
async def due_subscriptions(input: DueSubscriptionsInput) -> list[Subscription]:
    now = input.clock.now()
    all_subs = await input.repo.subscriptions.list()
    return [
        s
        for s in all_subs
        if s.status == "active"
        and not s.cancel_at_period_end
        and s.billing_key is not None
        and s.current_period.end <= now
    ]


@dataclass(kw_only=True, slots=True)
class SchedulerTickInput:
    provider: PaymentProvider
    repo: Repo
    policy: Policy
    ledger: LedgerStore
    clock: Clock
    ids: IdGen
    notifier: Notifier | None = (
        None  # not in the ARCHITECTURE.md signature; defaults to a no-op notifier
    )


@dataclass(kw_only=True, slots=True)
class SchedulerTickResult:
    charged: list[Subscription] = field(default_factory=list)
    failed: list[Subscription] = field(default_factory=list)


# EC:F — charge every due self-scheduled subscription and drive the renewal/dunning outcome.
# Only runs for providers whose capabilities().scheduling == 'self' (Toss). Providers with
# scheduling == 'provider' (PortOne's own schedule API, Stripe/Polar's native billing) manage
# their own renewal timing and notify us via the payment.succeeded webhook -> on_renewal_paid
# instead; calling tick() for one of those is a deliberate no-op, not an error.
async def tick(input: SchedulerTickInput) -> SchedulerTickResult:
    provider, repo, policy, ledger, clock = (
        input.provider,
        input.repo,
        input.policy,
        input.ledger,
        input.clock,
    )
    notifier = input.notifier or NoopNotifier()

    if provider.capabilities().scheduling != "self":
        return SchedulerTickResult(charged=[], failed=[])

    # No provider termination webhook exists for locally scheduled cancellations.
    cancellations = [
        sub for sub in await repo.subscriptions.list()
        if sub.provider == provider.name and sub.status == "active"
        and sub.cancel_at_period_end and sub.current_period.end <= clock.now()
    ]
    for pending_cancel in cancellations:
        async def _finish_cancel(pending_cancel: Subscription = pending_cancel) -> None:
            sub = await repo.subscriptions.get(pending_cancel.id)
            if (
                sub is None or sub.provider != provider.name or sub.status != "active"
                or not sub.cancel_at_period_end or sub.current_period.end > clock.now()
            ):
                return
            await repo.subscriptions.put(dataclasses.replace(
                sub, status="canceled", cancel_at_period_end=False,
            ))

        await retry_on_version_conflict(_finish_cancel)

    due = await due_subscriptions(DueSubscriptionsInput(repo=repo, clock=clock))
    charged: list[Subscription] = []
    failed: list[Subscription] = []

    for due_sub in due:
        # Keep the original period key across retries and revalidate cancellation/period changes.
        async def _attempt(due_sub: Subscription = due_sub) -> tuple[str, Subscription] | None:
            idempotency_key = f"charge:{due_sub.id}:{due_sub.current_period.end.isoformat()}"
            correlation_id = f"corr_sched_{due_sub.id}_{due_sub.current_period.end.isoformat()}"
            sub = await repo.subscriptions.get(due_sub.id)
            if (
                sub is None
                or sub.status != "active"
                or sub.cancel_at_period_end
                or sub.provider != provider.name
                or not sub.billing_key
                or sub.current_period.end > clock.now()
                or sub.current_period.end != due_sub.current_period.end
            ):
                return None
            plan = await repo.plans.get(sub.plan_id)
            if plan is None or not plan.prices:
                return ("failed", sub)
            price = plan.prices[0]
            # Transport errors and local persistence errors do not prove a declined charge.
            # Propagate them for reconciliation instead of starting customer dunning.
            payment = await scope_provider(provider, correlation_id).charge_billing_key(
                billing_key=sub.billing_key,
                amount=Money(amount_minor=price.amount_minor, currency=price.currency),
                order_id=idempotency_key,
                customer_ref=sub.customer_id,
                idempotency_key=idempotency_key,
            )
            match payment.status:
                case "succeeded":
                    charged_period = next_period(
                        sub.current_period,
                        plan.interval or "month",
                        sub.anchor_day,
                        policy.period.timezone,
                        policy.period.month_end_anchor,
                    )
                    stored = await _record_renewal_payment(
                        repo=repo, ids=input.ids, sub=sub, payment=payment, period=charged_period
                    )
                    result = await on_renewal_paid(OnRenewalPaidInput(
                        sub=sub, payment=stored,
                        policy=policy, ledger=ledger, repo=repo, clock=clock,
                    ))
                    return ("charged", result.sub)
                case "failed":
                    failed_result = await on_payment_failed(OnPaymentFailedInput(
                        sub=sub, policy=policy, repo=repo, notifier=notifier, clock=clock,
                    ))
                    return ("failed", failed_result.sub)
                case "pending" | "requires_action" | "refunded" | "partially_refunded" | "disputed":
                    raise PaymentKitError(
                        "Renewal charge requires reconciliation", "scheduler_charge_unresolved",
                        {"subscription_id": sub.id, "payment_id": payment.id,
                         "status": payment.status, "idempotency_key": idempotency_key},
                    )
                case unreachable:
                    assert_never(unreachable)

        outcome = await retry_on_version_conflict(_attempt)
        if outcome is None:
            continue
        kind, result_sub = outcome
        if kind == "charged":
            charged.append(result_sub)
        else:
            failed.append(result_sub)

    return SchedulerTickResult(charged=charged, failed=failed)


async def _record_renewal_payment(
    *, repo: Repo, ids: IdGen, sub: Subscription, payment: Payment, period: Period
) -> Payment:
    """EC:A26 -- a self-scheduled renewal has no webhook to create its payment row (Toss sends none
    for billing payments), so store it here. A retried charge returns the same provider payment,
    so an existing (provider, provider_ref) row is reused rather than duplicated."""
    existing = await repo.payments.list(provider=payment.provider, provider_ref=payment.provider_ref)
    row = dataclasses.replace(
        payment,
        id=existing[0].id if existing else ids.new_id(),
        customer_id=sub.customer_id,
        subscription_id=sub.id,
        kind="subscription",
        period=period,
    )
    await repo.payments.put(row)
    return row
