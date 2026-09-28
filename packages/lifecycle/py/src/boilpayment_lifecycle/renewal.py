"""spec: packages/lifecycle/spec/lifecycle.pseudo.md — EC:A7 A15 A17 A25 B12"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass
from datetime import datetime

from boilpayment_core import (
    Clock,
    LedgerReference,
    LedgerStore,
    NewLedgerEntry,
    Payment,
    PaymentKitError,
    Policy,
    Repo,
    Subscription,
    iso_z,
    key_matches_instant,
)
from boilpayment_credits import (
    GrantForPeriodInput,
    GrantResult,
    RolloverInput,
    RolloverResult,
    grant_for_period,
    rollover_on_renewal,
)

from .internal import replace_sub

_NO_ROLLOVER = RolloverResult(entries=[], banked=0, expired=0)


@dataclass(kw_only=True, slots=True)
class OnRenewalPaidInput:
    sub: Subscription
    payment: Payment
    policy: Policy
    ledger: LedgerStore
    repo: Repo
    clock: Clock


@dataclass(kw_only=True, slots=True)
class OnRenewalPaidResult:
    sub: Subscription
    grant: GrantResult
    rollover: RolloverResult
    duplicated: bool
    recovered: bool


# EC:A7 A15 A17 B12 — apply a successful renewal payment: grant the paid-for period's credits,
# roll over the previous period's leftover, advance the period, clear dunning state.
#
# Which period this payment is for is taken from `payment.period` when the caller (a webhook
# handler or, for self-scheduling providers, lifecycle.scheduler.tick) supplied it; that is the
# unambiguous source of truth. Falling back to `sub.current_period` when it's absent makes
# EC:A7 (same-period reactivation) a no-advance no-op by construction, and avoids the bug of
# rolling over a grant we ourselves just issued in this same call — rollover always looks at
# the period *before* `period`, never at `period` itself.
async def on_renewal_paid(input: OnRenewalPaidInput) -> OnRenewalPaidResult:
    sub, payment, policy, ledger, repo, clock = (
        input.sub,
        input.payment,
        input.policy,
        input.ledger,
        input.repo,
        input.clock,
    )

    period = payment.period or sub.current_period

    # EC:A7 — same-period re-activation (or a re-delivered webhook for a period already granted)
    # must not regrant.
    all_entries = await ledger.entries(
        sub.customer_id, kind="grant", source="subscription"
    )
    existing = next(
        (e for e in all_entries if key_matches_instant(e.idempotency_key, f"grant:{sub.id}:", period.start)),
        None,
    )
    if existing is not None:
        # Finish a failed subscription write after the grant committed. Do not regrant,
        # roll back a newer period, or revive a subscription canceled in the meantime.
        needs_advance = period.end > sub.current_period.end and sub.status in ("active", "past_due")
        updated = replace_sub(
            sub, plan_id=sub.scheduled_plan_id or sub.plan_id, scheduled_plan_id=None,
            current_period=period, status="active", grace_until=None,
        ) if needs_advance else sub
        if needs_advance:
            await repo.subscriptions.put(updated)
        await _grant_pending_upgrade(sub, payment, period, existing.reference.payment_id, ledger, repo, clock)  # EC:A77
        return OnRenewalPaidResult(
            sub=updated,
            grant=GrantResult(entry=existing, duplicated=True, deferred=False),
            rollover=_NO_ROLLOVER,
            duplicated=True,
            recovered=needs_advance and sub.status == "past_due",
        )

    # EC:A25 — only money that actually arrived buys a period. A pending/draft invoice (or any
    # other non-succeeded status) is refused before any write; the webhook record fails and its
    # retry re-fetches the payment, so the grant happens once the provider reports it succeeded.
    if payment.status != "succeeded":
        raise PaymentKitError(
            "Renewal payment has not succeeded",
            "renewal_payment_not_succeeded",
            {"subscriptionId": sub.id, "paymentId": payment.id, "status": payment.status},
        )

    # EC:A66 -- a banned customer's renewal payment buys nothing (the ban ended the subscription): the
    # record fails, so the payment stays in front of a person, who refunds it.
    owner = await repo.customers.get(sub.customer_id)
    if owner is not None and owner.status == "banned":
        raise PaymentKitError(
            "customer is banned; this renewal payment is not granted", "customer_banned",
            {"subscription_id": sub.id, "payment_id": payment.id},
        )

    was_recovering = sub.status == "past_due"

    plan_id = sub.scheduled_plan_id or sub.plan_id
    plan = await repo.plans.get(plan_id)
    if plan is None:
        raise PaymentKitError(f"plan not found: {plan_id}", "plan_not_found")

    # EC:B2 — roll over the *previous* period's leftover into `period` before granting `period`'s
    # own fresh credits, so this call never rolls over the grant it is about to issue.
    rollover = await rollover_on_renewal(
        RolloverInput(
            sub=sub, policy=policy, ledger=ledger, clock=clock, new_period=period
        )
    )

    # EC:A15 — payment already succeeded (that's why we're here); force 'active' so
    # grant_for_period doesn't defer for a stale past_due status.
    active_sub = replace_sub(sub, plan_id=plan.id, status="active")
    grant = await grant_for_period(
        GrantForPeriodInput(
            sub=active_sub,
            plan=plan,
            period=period,
            payment=payment,
            policy=policy,
            ledger=ledger,
            clock=clock,
        )
    )

    # EC:A32 -- a late payment for a subscription the provider already canceled/expired buys the
    # period it paid for (granted above) but never brings the subscription back to active.
    if sub.status in ("canceled", "expired"):
        return OnRenewalPaidResult(sub=sub, grant=grant, rollover=rollover, duplicated=False, recovered=False)

    updated = replace_sub(
        sub,
        plan_id=plan.id,
        scheduled_plan_id=None,
        current_period=period,
        status="active",
        grace_until=None,
    )
    await repo.subscriptions.put(updated)

    return OnRenewalPaidResult(
        sub=updated,
        grant=grant,
        rollover=rollover,
        duplicated=False,
        recovered=was_recovering,
    )


async def _grant_pending_upgrade(sub, payment, period, existing_payment_id, ledger, repo, clock) -> None:  # type: ignore[no-untyped-def]
    """EC:A77 -- a paid provider order for a period already granted, other than the one that paid for it (a
    Polar plan-change order), releases the upgrade delta the upgrade left waiting for it. Mirrors renewal.ts."""
    from .upgrade import pending_upgrade_grant_key

    if payment.status != "succeeded" or payment.id == existing_payment_id:
        return
    key = pending_upgrade_grant_key(sub.id, sub.plan_id, period.start)
    op = await repo.operations.get(key)
    if op is None or op.status != "in_progress":
        return
    pending = op.result or {}
    expires = pending.get("expiresAt")
    await ledger.append(NewLedgerEntry(
        customer_id=sub.customer_id, pool="paid", kind="grant", amount=int(pending["amount"]), unit_price_minor=None, currency=None,
        expires_at=datetime.fromisoformat(expires) if expires else None, source="subscription",
        reference=LedgerReference(subscription_id=sub.id, period_start=period.start, payment_id=payment.id),
        idempotency_key=f"grant:upgrade:{sub.id}:{sub.plan_id}:{iso_z(period.start)}", actor="system", reason=str(pending.get("reason", "upgrade")),
    ))
    await repo.operations.put(dataclasses.replace(op, status="done", completed_at=clock.now()))
