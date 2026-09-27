"""spec: packages/lifecycle/spec/lifecycle.pseudo.md — EC:F (Toss/Portone self-scheduling)"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field

from boilpayment_core import (
    Clock,
    IdGen,
    LedgerStore,
    Money,
    NoopNotifier,
    Notification,
    Notifier,
    PaymentKitError,
    PaymentProvider,
    Policy,
    Repo,
    Subscription,
)

from .charge_attempt import (
    ChargeAttemptInput,
    attempt_key_of,
    attempts_for,
    charge_attempt,
    is_legacy_attempt,
    is_under_review,
    iso_z,
    mark_unresolved,
    renewal_attempt_key,
)
from .dunning import OnPaymentFailedInput, on_payment_failed
from .internal import price_for_subscription, renewal_plan_id
from .legacy_attempts import (
    check_legacy_dunning,
    settle_legacy_ended,
    settle_orphan_attempts,
)
from .missed_periods import apply_missed_periods, settle_open_attempt_if_behind
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
        # EC:A34 A36 -- past_due rows too: an attempt of theirs with no answer is re-driven here.
        if s.status in ("active", "past_due")
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
class SchedulerTickError:
    subscription_id: str
    code: str
    message: str


@dataclass(kw_only=True, slots=True)
class SchedulerTickResult:
    charged: list[Subscription] = field(default_factory=list)
    failed: list[Subscription] = field(default_factory=list)
    # EC:A30 -- one subscription's failure never stops the others; each is reported here.
    errors: list[SchedulerTickError] = field(default_factory=list)


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
        return SchedulerTickResult(charged=[], failed=[], errors=[])

    # No provider termination webhook exists for locally scheduled cancellations.
    cancellations = [
        sub for sub in await repo.subscriptions.list()
        if sub.provider == provider.name and sub.status in ("active", "past_due")
        and sub.cancel_at_period_end and sub.current_period.end <= clock.now()
    ]
    for pending_cancel in cancellations:
        async def _finish_cancel(pending_cancel: Subscription = pending_cancel) -> None:
            sub = await repo.subscriptions.get(pending_cancel.id)
            if (
                sub is None or sub.provider != provider.name or sub.status not in ("active", "past_due")
                or not sub.cancel_at_period_end or sub.current_period.end > clock.now()
            ):
                return
            # EC:A40 -- a past_due subscription canceled at period end ends too; dunning stops.
            await repo.subscriptions.put(dataclasses.replace(
                sub, status="canceled", cancel_at_period_end=False, grace_until=None,
            ))

        await retry_on_version_conflict(_finish_cancel)

    due = await due_subscriptions(DueSubscriptionsInput(repo=repo, clock=clock))
    charged: list[Subscription] = []
    failed: list[Subscription] = []
    errors: list[SchedulerTickError] = []

    for due_sub in due:
        # Keep the original period key across retries and revalidate cancellation/period changes.
        async def _attempt(due_sub: Subscription = due_sub) -> tuple[str, Subscription] | None:
            correlation_id = f"corr_sched_{due_sub.id}_{iso_z(due_sub.current_period.end)}"
            sub = await repo.subscriptions.get(due_sub.id)
            # Never charge a newer period, or a subscription canceled/removed by another writer.
            if (
                sub is None
                or sub.status not in ("active", "past_due")
                or sub.cancel_at_period_end
                or sub.provider != provider.name
                or not sub.billing_key
                or sub.current_period.end > clock.now()
                or sub.current_period.end != due_sub.current_period.end
            ):
                return None
            # EC:A29 -- the plan the subscription renews INTO; EC:A28 -- in its currency.
            plan = await repo.plans.get(renewal_plan_id(sub))
            price = price_for_subscription(plan, sub) if plan is not None else None
            if plan is None or price is None:
                if sub.status != "active":
                    return None  # already in dunning; its retries tell a person
                # EC:A31 -- a configuration fault: no charge; dunning (past_due, grace) and a person told.
                await notifier.send(Notification(type="cs.needs_human", customer_id=sub.customer_id, payload={
                    "kind": "plan_price_missing", "subscription_id": sub.id,
                    "plan_id": renewal_plan_id(sub), "currency": sub.currency}))
                missing = await on_payment_failed(OnPaymentFailedInput(
                    sub=sub, policy=policy, repo=repo, notifier=notifier, clock=clock,
                ))
                return ("failed", missing.sub)
            charged_period = next_period(
                sub.current_period,
                plan.interval or "month",
                sub.anchor_day,
                policy.period.timezone,
                policy.period.month_end_anchor,
            )
            # EC:A34 -- one (subscription, period) is charged at most once: a succeeded attempt
            # finishes the renewal, an attempt with no answer is re-driven with its own key, and a new
            # charge is started only for an active subscription.
            expected = Money(amount_minor=price.amount_minor, currency=price.currency)
            attempts = await attempts_for(repo, sub, charged_period)
            paid = next((p for p in attempts if p.status == "succeeded"), None)
            if paid is not None:
                resumed = await on_renewal_paid(OnRenewalPaidInput(
                    sub=sub, payment=paid, policy=policy, ledger=ledger, repo=repo, clock=clock,
                ))
                return ("charged", resumed.sub)
            legacy_open = any(p.status != "failed" and is_legacy_attempt(p) for p in attempts)
            open_row = next((p for p in attempts if p.status != "failed" and not is_legacy_attempt(p)), None)
            if open_row is not None and not is_under_review(open_row):
                # EC:A47 (A6-4) -- an open attempt for a period that already ended, more periods behind: ask first.
                now_row = await settle_open_attempt_if_behind(provider=provider, repo=repo, clock=clock, notifier=notifier,
                                                              sub=sub, plan=plan, policy=policy, open_row=open_row)
                if now_row.status == "succeeded":
                    resumed = await on_renewal_paid(OnRenewalPaidInput(
                        sub=sub, payment=now_row, policy=policy, ledger=ledger, repo=repo, clock=clock,
                    ))
                    return ("charged", resumed.sub)
                if now_row.status == "failed":
                    open_row = None
            if open_row is None and not legacy_open and sub.status != "active":
                return None  # every attempt answered: dunning owns the next charge
            if open_row is None:
                # EC:A39 -- a dunning charge of an earlier release (no row) may already have paid this period.
                legacy = await check_legacy_dunning(provider=provider, repo=repo, clock=clock, sub=sub, period=charged_period,
                                                    price=expected, notifier=notifier)
                if legacy.kind == "paid" and legacy.payment is not None:
                    resumed = await on_renewal_paid(OnRenewalPaidInput(
                        sub=sub, payment=legacy.payment, policy=policy, ledger=ledger, repo=repo, clock=clock,
                    ))
                    return ("charged", resumed.sub)
                if legacy.kind == "unverified":
                    raise PaymentKitError(
                        "An earlier release may already have charged this period; not charging until the provider confirms",
                        "legacy_dunning_unverified", {"subscription_id": sub.id, "order_ids": legacy.order_ids})
            if open_row is None:
                # EC:A47 (A5-1) -- more than one period behind: never bill missed periods one tick at a time.
                missed = await apply_missed_periods(sub=sub, plan=plan, policy=policy, repo=repo, notifier=notifier, clock=clock)
                if missed.kind == "parked" and missed.sub is not None:
                    return ("failed", missed.sub)
                if missed.kind == "skipped" and missed.sub is not None and missed.target is not None:
                    sub = missed.sub
                    charged_period = missed.target
                    attempts = await attempts_for(repo, sub, charged_period)
                    paid_target = next((p for p in attempts if p.status == "succeeded"), None)
                    if paid_target is not None:
                        resumed = await on_renewal_paid(OnRenewalPaidInput(
                            sub=sub, payment=paid_target, policy=policy, ledger=ledger, repo=repo, clock=clock,
                        ))
                        return ("charged", resumed.sub)
                    open_row = next((p for p in attempts if p.status != "failed" and not is_legacy_attempt(p)), None)
            attempt_key = (attempt_key_of(open_row) if open_row else None) or renewal_attempt_key(sub, charged_period)
            charge = await charge_attempt(ChargeAttemptInput(
                provider=provider, repo=repo, clock=clock, sub=sub, price=price,
                period=charged_period, attempt_key=attempt_key, correlation_id=correlation_id, notifier=notifier,
            ))
            if charge.kind == "in_flight":
                return None  # EC:A37 -- another worker is charging this attempt right now
            if charge.kind == "succeeded":
                result = await on_renewal_paid(OnRenewalPaidInput(
                    sub=sub, payment=charge.payment, policy=policy, ledger=ledger, repo=repo, clock=clock,
                ))
                return ("charged", result.sub)
            if charge.kind == "declined":
                if sub.status != "active":
                    # EC:A41 -- the scheduler's own attempt, unresolved until now, declined: dunning takes over once.
                    if not charge.fresh or attempt_key_of(charge.payment) != renewal_attempt_key(sub, charged_period):
                        return ("failed", sub)
                    started = await on_payment_failed(OnPaymentFailedInput(
                        sub=sub, policy=policy, repo=repo, notifier=notifier, clock=clock,
                    ))
                    return ("failed", started.sub)
                failed_result = await on_payment_failed(OnPaymentFailedInput(
                    sub=sub, policy=policy, repo=repo, notifier=notifier, clock=clock,
                ))
                return ("failed", failed_result.sub)
            # EC:A36 -- past the period end with no answer: grace, one notice, reported every tick.
            await mark_unresolved(sub=sub, repo=repo, notifier=notifier, clock=clock,
                                  grace_days=policy.dunning.grace_days, payment=charge.payment, reason=charge.reason)
            raise PaymentKitError(
                f"Renewal charge requires reconciliation: {charge.reason}", "scheduler_charge_unresolved",
                {"subscription_id": sub.id, "payment_id": charge.payment.id, "status": charge.payment.status,
                 "attempt_key": attempt_key, "reason": charge.reason},
            )

        # EC:A30 -- isolate each subscription: an unresolved charge or a local failure is reported
        # and the loop moves on, so one row can never stall every renewal after it.
        try:
            outcome = await retry_on_version_conflict(_attempt)
        except Exception as err:  # noqa: BLE001 -- reported per subscription, see EC:A30
            errors.append(SchedulerTickError(
                subscription_id=due_sub.id,
                code=err.code if isinstance(err, PaymentKitError) else "scheduler_error",
                message=str(err),
            ))
            continue
        if outcome is None:
            continue
        kind, result_sub = outcome
        if kind == "charged":
            charged.append(result_sub)
        else:
            failed.append(result_sub)

    # EC:A38 -- attempts left pending by subscriptions that ended meanwhile are settled by lookup.
    _settled, unresolved = await settle_orphan_attempts(
        provider=provider, repo=repo, ledger=ledger, policy=policy, clock=clock, notifier=notifier,
    )
    for u in unresolved:
        errors.append(SchedulerTickError(
            subscription_id=u.subscription_id, code="renewal_charge_unresolved",
            message=f"attempt {u.payment_id} still has no answer from the provider",
        ))
    # EC:A39 (A5-3) -- an ended subscription whose earlier-release dunning charge may have moved money.
    try:
        await settle_legacy_ended(provider=provider, repo=repo, ledger=ledger, policy=policy, clock=clock, notifier=notifier)
    except Exception as err:  # noqa: BLE001 -- reported, never stops the tick
        errors.append(SchedulerTickError(subscription_id="*", code="legacy_settlement_error", message=str(err)))

    return SchedulerTickResult(charged=charged, failed=failed, errors=errors)

