"""spec: packages/lifecycle/spec/lifecycle.pseudo.md — EC:A13 A16 A17 A24"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta

from boilpayment_core import (
    Clock,
    IdGen,
    LedgerEntry,
    LedgerReference,
    LedgerStore,
    NewLedgerEntry,
    Notification,
    Notifier,
    OutboxItem,
    Payment,
    PaymentKitError,
    PaymentProvider,
    Policy,
    Repo,
    Subscription,
)
from boilpayment_credits import (
    GrantForPeriodInput,
    GrantResult,
    grant_for_period,
)

from .charge_attempt import (
    ChargeAttemptInput,
    ChargeAttemptOutcome,
    attempt_key_of,
    attempts_for,
    charge_attempt,
    dunning_attempt_key,
    iso_z,
)
from .internal import price_for_subscription, renewal_plan_id, replace_sub
from .period import next_period
from .renewal import OnRenewalPaidInput, on_renewal_paid
from .retry import retry_on_version_conflict

_HOUR = timedelta(hours=1)

# EC:A24 — outbox item kind used to schedule a smart-retry charge attempt inside the grace window.
_RETRY_KIND = "dunning.retry"


def _retry_gap_hours(attempt_number: int, intervals: list[int]) -> int:
    """Hours to wait before attempt N (1-based); a shorter `intervals` than the configured
    retry_attempts repeats its last value for the remaining attempts."""
    if not intervals:
        return 0
    idx = min(attempt_number - 1, len(intervals) - 1)
    return intervals[idx]


def _retry_outbox_id(sub_id: str, attempt: int) -> str:
    # Deterministic — a redelivered failure webhook re-schedules the SAME attempt-1 item instead
    # of piling up duplicates (repo.outbox.put is keyed by id).
    return f"dunning-retry-item:{sub_id}:{attempt}"


async def _schedule_retry(
    repo: Repo, sub_id: str, attempt: int, from_: datetime, intervals: list[int]
) -> OutboxItem:
    due_at = from_ + _retry_gap_hours(attempt, intervals) * _HOUR
    item = OutboxItem(
        id=_retry_outbox_id(sub_id, attempt),
        kind=_RETRY_KIND,
        # EC:A42 -- the same payload keys as the TS kit, so either can run the other's items.
        payload={
            "subscriptionId": sub_id,
            "attempt": attempt,
            "dueAt": iso_z(due_at),
        },
        status="pending",
        attempts=0,
        next_attempt_at=due_at,
        created_at=from_,
    )
    return await repo.outbox.put(item)


@dataclass(kw_only=True, slots=True)
class OnPaymentFailedInput:
    sub: Subscription
    policy: Policy
    repo: Repo
    notifier: Notifier
    clock: Clock


@dataclass(kw_only=True, slots=True)
class OnPaymentFailedResult:
    sub: Subscription


# EC:A13 — start grace period.
async def on_payment_failed(input: OnPaymentFailedInput) -> OnPaymentFailedResult:
    sub, policy, repo, notifier, clock = (
        input.sub,
        input.policy,
        input.repo,
        input.notifier,
        input.clock,
    )
    # EC:A27 -- an incomplete subscription never paid: a failed first payment has no access to
    # keep, so no grace period, retries or notices.
    if sub.status == "incomplete":
        return OnPaymentFailedResult(sub=sub)
    now = clock.now()
    grace_days = policy.dunning.grace_days
    grace_until = now + timedelta(days=grace_days) if grace_days > 0 else now

    updated = replace_sub(sub, status="past_due", grace_until=grace_until)
    await repo.subscriptions.put(updated)

    await notifier.send(
        Notification(
            type="payment.failed",
            customer_id=sub.customer_id,
            payload={"subscription_id": sub.id, "grace_until": grace_until.isoformat()},
        )
    )
    if grace_days > 0:
        await notifier.send(
            Notification(
                type="grace.started",
                customer_id=sub.customer_id,
                payload={
                    "subscription_id": sub.id,
                    "grace_until": grace_until.isoformat(),
                },
            )
        )

    # EC:A24 — schedule the first smart-retry attempt inside the grace window. retry_attempts=0
    # (not the default) means "only the provider's own dunning", so nothing is scheduled.
    if policy.dunning.retry_attempts > 0:
        await _schedule_retry(repo, sub.id, 1, now, policy.dunning.retry_interval_hours)

    return OnPaymentFailedResult(sub=updated)


@dataclass(kw_only=True, slots=True)
class OnGraceExpiredInput:
    sub: Subscription
    policy: Policy
    ledger: LedgerStore
    repo: Repo
    notifier: Notifier
    clock: Clock


@dataclass(kw_only=True, slots=True)
class OnGraceExpiredResult:
    sub: Subscription
    revoked: list[LedgerEntry] = field(default_factory=list)


# EC:A16 — grace period ended without payment; resolve outstanding credits per policy.
async def on_grace_expired(input: OnGraceExpiredInput) -> OnGraceExpiredResult:
    sub, policy, ledger, repo, notifier, clock = (
        input.sub,
        input.policy,
        input.ledger,
        input.repo,
        input.notifier,
        input.clock,
    )
    now = clock.now()
    revoked: list[LedgerEntry] = []

    if policy.dunning.on_final_failure == "revoke_unpaid_period":
        period_key = f"grant:{sub.id}:{sub.current_period.start.isoformat()}"
        all_entries = await ledger.entries(sub.customer_id)
        grant = next(
            (
                e
                for e in all_entries
                if e.kind == "grant" and e.idempotency_key == period_key
            ),
            None,
        )
        if grant is not None:
            used = sum(
                e.amount
                for e in all_entries
                if e.kind in ("consume", "revoke") and e.reference.grant_id == grant.id
            )
            remaining = max(0, grant.amount + used)
            if remaining > 0:
                result = await ledger.append(
                    NewLedgerEntry(
                        customer_id=sub.customer_id,
                        pool="paid",
                        kind="revoke",
                        amount=-remaining,
                        unit_price_minor=None,
                        currency=None,
                        expires_at=None,
                        source="subscription",
                        reference=LedgerReference(
                            subscription_id=sub.id,
                            period_start=sub.current_period.start,
                            grant_id=grant.id,
                        ),
                        idempotency_key=f"revoke:dunning:{sub.id}:{sub.current_period.start.isoformat()}",
                        actor="system",
                        reason="grace_expired_unpaid",
                    )
                )
                revoked.append(result.entry)
    elif policy.dunning.on_final_failure == "revoke_all":
        balance = await ledger.balance(sub.customer_id, "paid", now)
        if balance.available > 0:
            result = await ledger.append(
                NewLedgerEntry(
                    customer_id=sub.customer_id,
                    pool="paid",
                    kind="revoke",
                    amount=-balance.available,
                    unit_price_minor=None,
                    currency=None,
                    expires_at=None,
                    source="subscription",
                    reference=LedgerReference(subscription_id=sub.id),
                    idempotency_key=f"revoke:dunning-all:{sub.id}:{sub.current_period.start.isoformat()}",
                    actor="system",
                    reason="grace_expired_unpaid_all",
                )
            )
            revoked.append(result.entry)
    # 'keep' — no-op

    updated = replace_sub(sub, status="expired", grace_until=None)
    await repo.subscriptions.put(updated)
    await notifier.send(
        Notification(
            type="grace.ending",
            customer_id=sub.customer_id,
            payload={"subscription_id": sub.id},
        )
    )

    return OnGraceExpiredResult(sub=updated, revoked=revoked)


@dataclass(kw_only=True, slots=True)
class OnRecoveredInput:
    sub: Subscription
    payment: Payment
    policy: Policy
    ledger: LedgerStore
    repo: Repo
    clock: Clock


@dataclass(kw_only=True, slots=True)
class OnRecoveredResult:
    sub: Subscription
    grants: list[GrantResult] = field(default_factory=list)


# EC:A17 — payment recovered after grace/final-failure.
async def on_recovered(input: OnRecoveredInput) -> OnRecoveredResult:
    sub, payment, policy, ledger, repo, clock = (
        input.sub,
        input.payment,
        input.policy,
        input.ledger,
        input.repo,
        input.clock,
    )
    grants: list[GrantResult] = []

    if policy.dunning.on_recovery == "no_regrant":
        updated = replace_sub(sub, status="active", grace_until=None)
        await repo.subscriptions.put(updated)
        return OnRecoveredResult(sub=updated, grants=grants)

    # EC:A29 -- recovery completes the renewal into the plan it was renewing to (a scheduled change).
    plan = await repo.plans.get(renewal_plan_id(sub))
    if plan is None:
        raise PaymentKitError(f"plan not found: {renewal_plan_id(sub)}", "plan_not_found")

    # 'regrant_current_period' and 'regrant_all_missed' both regrant the current period here;
    # multi-period backfill needs a paid-period history the Repo doesn't track yet (spec note #3).
    active_sub = replace_sub(sub, plan_id=plan.id, status="active")
    g = await grant_for_period(
        GrantForPeriodInput(
            sub=active_sub,
            plan=plan,
            period=sub.current_period,
            payment=payment,
            policy=policy,
            ledger=ledger,
            clock=clock,
        )
    )
    grants.append(g)

    updated = replace_sub(sub, plan_id=plan.id, scheduled_plan_id=None, status="active", grace_until=None)
    await repo.subscriptions.put(updated)

    return OnRecoveredResult(sub=updated, grants=grants)


# ── EC:A24 smart retry ──────────────────────────────────────────────────────────────────────


@dataclass(kw_only=True, slots=True)
class RetryDueInput:
    repo: Repo
    clock: Clock
    limit: int | None = None


# EC:A24 — 'dunning.retry' outbox items whose scheduled attempt time has arrived.
async def retry_due(input: RetryDueInput) -> list[OutboxItem]:
    now = input.clock.now()
    pending = await input.repo.outbox.list(kind=_RETRY_KIND, status="pending")
    due = sorted(
        (item for item in pending if item.next_attempt_at <= now),
        key=lambda item: item.next_attempt_at,
    )
    return due[: input.limit] if input.limit is not None else due


@dataclass(kw_only=True, slots=True)
class RunRetryInput:
    item: OutboxItem
    provider: PaymentProvider
    repo: Repo
    ledger: LedgerStore
    policy: Policy
    notifier: Notifier
    clock: Clock
    # Reserved for future use — retry bookkeeping uses deterministic outbox ids, not ids.new_id().
    ids: IdGen | None = None


@dataclass(kw_only=True, slots=True)
class RunRetryResult:
    outcome: str  # 'recovered' | 'failed' | 'unresolved' | 'skipped' | 'deferred_to_provider'
    sub: Subscription | None
    grants: list[GrantResult] = field(default_factory=list)


# EC:A24 — execute one scheduled dunning-retry attempt.
async def run_retry(input: RunRetryInput) -> RunRetryResult:
    item, provider, repo, ledger, policy, notifier, clock = (
        input.item,
        input.provider,
        input.repo,
        input.ledger,
        input.policy,
        input.notifier,
        input.clock,
    )
    payload = item.payload
    # EC:A42 -- the TS key (subscriptionId) is what both kits write; snake_case from earlier Python
    # releases is still read so a shared database keeps working.
    sub_id = payload.get("subscriptionId", payload.get("subscription_id"))
    attempt = payload["attempt"]

    async def _attempt() -> RunRetryResult:
        # EC:K1 — re-read on every attempt; another writer (webhook, scheduler tick, a manual
        # cancel) may have touched this row since the item was scheduled.
        sub = await repo.subscriptions.get(sub_id)
        if sub is None or sub.status != "past_due":
            # Already recovered (e.g. the provider's own dunning succeeded first via webhook),
            # canceled, or expired — this scheduled attempt no longer applies.
            item.status = "sent"
            item.attempts += 1
            await repo.outbox.put(item)
            return RunRetryResult(outcome="skipped", sub=sub, grants=[])

        # EC:A40 -- canceled (at period end) while past_due: dunning stops, the subscription ends.
        if sub.cancel_at_period_end:
            item.status = "sent"
            item.attempts += 1
            await repo.outbox.put(item)
            ended = replace_sub(sub, status="canceled", cancel_at_period_end=False, grace_until=None)
            await repo.subscriptions.put(ended)
            return RunRetryResult(outcome="skipped", sub=ended, grants=[])

        can_charge = (
            provider.capabilities().scheduling == "self" and sub.billing_key is not None
        )
        if not can_charge:
            # Provider-scheduled dunning (Stripe/Polar/PortOne's own schedule) drives the actual
            # charge and reports its outcome via webhook. We only advance our own attempt counter
            # here so grace.ending still fires on schedule if the provider's own retries never
            # recover it.
            item.status = "sent"
            item.attempts += 1
            await repo.outbox.put(item)
            if attempt < policy.dunning.retry_attempts:
                await _schedule_retry(
                    repo,
                    sub.id,
                    attempt + 1,
                    clock.now(),
                    policy.dunning.retry_interval_hours,
                )
            return RunRetryResult(outcome="deferred_to_provider", sub=sub, grants=[])

        plan = await repo.plans.get(renewal_plan_id(sub))  # EC:A29
        price = price_for_subscription(plan, sub) if plan is not None else None  # EC:A28
        if plan is None or price is None:
            # EC:A31 -- a configuration fault, not a decline: tell a person and keep the retry
            # schedule so a fixed plan price is charged on the next attempt.
            item.status = "sent"
            item.attempts += 1
            await repo.outbox.put(item)
            await notifier.send(Notification(type="cs.needs_human", customer_id=sub.customer_id, payload={
                "kind": "plan_price_missing", "subscription_id": sub.id,
                "plan_id": renewal_plan_id(sub), "currency": sub.currency}))
            if attempt < policy.dunning.retry_attempts:
                await _schedule_retry(repo, sub.id, attempt + 1, clock.now(), policy.dunning.retry_interval_hours)
            return RunRetryResult(outcome="failed", sub=sub, grants=[])
        # EC:A34 -- the retry pays for the renewal that failed: the period after the current one. A
        # succeeded attempt (this one, or an earlier one whose local steps failed) completes the
        # renewal through on_renewal_paid, which grants THAT period (usable) and advances the
        # subscription, so the next tick has nothing left to charge for it.
        charged_period = next_period(
            sub.current_period, plan.interval or "month", sub.anchor_day,
            policy.period.timezone, policy.period.month_end_anchor,
        )
        attempts = await attempts_for(repo, sub, charged_period)
        earlier = next((p for p in attempts if p.status == "succeeded"), None)
        open_row = next((p for p in attempts if p.status not in ("failed", "succeeded")), None)
        attempt_key = (attempt_key_of(open_row) if open_row else None) or dunning_attempt_key(sub, charged_period, attempt)
        charge = (
            ChargeAttemptOutcome(kind="succeeded", payment=earlier)
            if earlier is not None
            else await charge_attempt(ChargeAttemptInput(
                provider=provider, repo=repo, clock=clock, sub=sub, price=price,
                period=charged_period, attempt_key=attempt_key,
            ))
        )
        if charge.kind == "in_flight":
            # EC:A37 -- another worker holds this attempt: look again shortly, not counted.
            item.next_attempt_at = clock.now() + timedelta(hours=1)
            await repo.outbox.put(item)
            return RunRetryResult(outcome="skipped", sub=sub, grants=[])
        item.attempts += 1

        if charge.kind == "succeeded":
            item.status = "sent"
            await repo.outbox.put(item)
            renewed = await on_renewal_paid(OnRenewalPaidInput(
                sub=sub, payment=charge.payment, policy=policy, ledger=ledger, repo=repo, clock=clock,
            ))
            return RunRetryResult(outcome="recovered", sub=renewed.sub, grants=[renewed.grant])

        if charge.kind == "unresolved":
            # EC:A34 A36 (N11) -- no answer is not a decline: the same attempt is re-driven later with
            # the same key (never a new charge while this one may have moved money). One notice.
            item.next_attempt_at = clock.now() + max(1, _retry_gap_hours(attempt, policy.dunning.retry_interval_hours)) * _HOUR
            await repo.outbox.put(item)
            if charge.first:
                await notifier.send(Notification(type="cs.needs_human", customer_id=sub.customer_id, payload={
                    "kind": "renewal_charge_unresolved", "subscription_id": sub.id,
                    "payment_id": charge.payment.id, "reason": charge.reason}))
            return RunRetryResult(outcome="unresolved", sub=sub, grants=[])

        item.status = "sent"
        await repo.outbox.put(item)
        await notifier.send(
            Notification(
                type="payment.failed",
                customer_id=sub.customer_id,
                payload={"subscription_id": sub.id, "attempt": attempt},
            )
        )

        if attempt < policy.dunning.retry_attempts:
            await _schedule_retry(
                repo,
                sub.id,
                attempt + 1,
                clock.now(),
                policy.dunning.retry_interval_hours,
            )
        else:
            # Retries exhausted — the existing grace_until-driven on_grace_expired path finishes it.
            await notifier.send(
                Notification(
                    type="grace.ending",
                    customer_id=sub.customer_id,
                    payload={"subscription_id": sub.id},
                )
            )

        return RunRetryResult(outcome="failed", sub=sub, grants=[])

    return await retry_on_version_conflict(_attempt)
