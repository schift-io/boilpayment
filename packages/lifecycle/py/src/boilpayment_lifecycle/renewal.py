"""spec: packages/lifecycle/spec/lifecycle.pseudo.md — EC:A7 A15 A17 A25 B12"""

from __future__ import annotations

import dataclasses
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from boilpayment_core import (
    Clock,
    CsCase,
    LedgerReference,
    LedgerStore,
    NewLedgerEntry,
    Payment,
    PaymentKitError,
    Plan,
    Policy,
    Repo,
    Subscription,
    civil_day_of,
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


def _raw_contains(value: Any, expected: str) -> bool:
    if value == expected:
        return True
    if isinstance(value, list):
        return any(_raw_contains(item, expected) for item in value)
    if isinstance(value, dict):
        return any(_raw_contains(item, expected) for item in value.values())
    return False


async def _open_renewal_mismatch_case(
    *, sub: Subscription, payment: Payment, policy: Policy, repo: Repo,
    clock: Clock, actual_plan_id: str | None,
) -> None:
    case_id = f"reconcile_mismatch:{payment.id}"
    if await repo.cs_cases.get(case_id) is not None:
        return
    now = clock.now()
    await repo.cs_cases.put(CsCase(
        id=case_id,
        customer_id=sub.customer_id,
        kind="reconcile_mismatch",
        status="needs_human",
        reference_id=payment.id,
        policy_snapshot=deepcopy(policy),
        decision={
            "subscriptionId": sub.id,
            "expectedPlanId": sub.scheduled_plan_id,
            "actualPlanId": actual_plan_id,
            "amountMinor": payment.amount.amount_minor,
            "currency": payment.amount.currency,
        },
        churn_reason=None,
        churn_text=None,
        opened_at=now,
        resolved_at=None,
        escalated_at=now,
    ))


async def _resolve_paid_plan(
    *, sub: Subscription, payment: Payment, policy: Policy, repo: Repo, clock: Clock,
) -> Plan:
    """SB-14 -- accept a scheduled plan only when the renewal charge agrees with its price."""
    intended_id = sub.scheduled_plan_id or sub.plan_id
    intended = await repo.plans.get(intended_id)
    if intended is None:
        raise PaymentKitError(f"plan not found: {intended_id}", "plan_not_found")
    if sub.scheduled_plan_id is None:
        return intended
    currency = payment.amount.currency.upper()
    intended_ref_matches = any(
        (price.provider_price_refs or {}).get(payment.provider) is not None
        and _raw_contains(
            payment.raw, (price.provider_price_refs or {})[payment.provider]
        )
        for price in intended.prices
    )
    intended_amount_matches = any(
        price.currency.upper() == currency
        and price.amount_minor == payment.amount.amount_minor
        for price in intended.prices
    )
    if intended_ref_matches or intended_amount_matches:
        return intended

    plans = await repo.plans.list()
    by_provider_ref = [
        plan for plan in plans
        if any(
            (price.provider_price_refs or {}).get(payment.provider) is not None
            and _raw_contains(
                payment.raw, (price.provider_price_refs or {})[payment.provider]
            )
            for price in plan.prices
        )
    ]
    by_amount = [
        plan for plan in plans
        if any(
            price.currency.upper() == currency
            and price.amount_minor == payment.amount.amount_minor
            for price in plan.prices
        )
    ]
    matches = by_provider_ref or by_amount
    actual = matches[0] if len(matches) == 1 else None
    await _open_renewal_mismatch_case(
        sub=sub, payment=payment, policy=policy, repo=repo, clock=clock,
        actual_plan_id=actual.id if actual is not None else None,
    )
    if actual is None:
        raise PaymentKitError(
            "renewal charge does not identify one plan; refusing to grant",
            "renewal_plan_mismatch",
            {
                "subscription_id": sub.id,
                "payment_id": payment.id,
                "expected_plan_id": intended.id,
            },
        )
    return actual


def _matches_upgrade_anchor_intent(intent: dict[str, Any], payment: Payment) -> bool:
    if payment.provider != "stripe" or payment.status != "succeeded" or payment.period is None:
        return False
    source_start = datetime.fromisoformat(str(intent["sourcePeriodStart"]))
    source_end = datetime.fromisoformat(str(intent["sourcePeriodEnd"]))
    return (
        source_start < payment.period.start < source_end
        and source_start <= payment.occurred_at < source_end
    )


async def _settle_upgrade_anchor_invoice(
    input: OnRenewalPaidInput,
) -> OnRenewalPaidResult | None:
    """SB-11 -- settle a Stripe reset-anchor invoice before the full-plan renewal path."""
    sub, payment, policy, ledger, repo, clock = (
        input.sub,
        input.payment,
        input.policy,
        input.ledger,
        input.repo,
        input.clock,
    )
    if payment.period is None or payment.status != "succeeded" or payment.provider != "stripe":
        return None
    candidates = await repo.operations.list(
        kind="lifecycle.upgrade_anchor", status="in_progress"
    )
    op = next(
        (
            candidate for candidate in candidates
            if isinstance(candidate.result, dict)
            and candidate.result.get("subId") == sub.id
            and _matches_upgrade_anchor_intent(candidate.result, payment)
        ),
        None,
    )
    if op is None:
        return None
    intent = op.result
    period = payment.period
    grant_key = f"grant:{sub.id}:{iso_z(period.start)}"
    entries = await ledger.entries(sub.customer_id, kind="grant", source="subscription")
    grant = next((entry for entry in entries if entry.idempotency_key == grant_key), None)
    duplicated = grant is not None
    if grant is None:
        appended = await ledger.append(NewLedgerEntry(
            customer_id=sub.customer_id,
            pool="paid",
            kind="grant",
            amount=int(intent["delta"]),
            unit_price_minor=None,
            currency=None,
            expires_at=None if policy.credits.rollover == "full" else period.end,
            source="subscription",
            reference=LedgerReference(
                subscription_id=sub.id,
                period_start=period.start,
                payment_id=payment.id,
            ),
            idempotency_key=grant_key,
            actor="system",
            reason=f"upgrade:{intent['fromPlanId']}->{intent['toPlanId']}",
        ))
        grant = appended.entry
        duplicated = appended.duplicated
    elif grant.reference.payment_id != payment.id:
        await ledger.append(NewLedgerEntry(
            customer_id=sub.customer_id,
            pool=grant.pool,
            kind="adjust",
            amount=0,
            unit_price_minor=None,
            currency=None,
            expires_at=None,
            source="subscription",
            reference=LedgerReference(
                subscription_id=sub.id,
                period_start=period.start,
                grant_id=grant.id,
                payment_id=payment.id,
            ),
            idempotency_key=f"adjust:upgrade-invoice:{grant.id}:{payment.id}",
            actor="system",
            reason="SB-11 upgrade_invoice_attribution",
        ))

    from .upgrade import apply_change

    stored = await repo.subscriptions.get(sub.id) or sub

    def change(base: Subscription) -> Subscription:
        return replace_sub(
            base,
            plan_id=str(intent["toPlanId"]),
            scheduled_plan_id=None,
            current_period=period,
            anchor_day=civil_day_of(period.start, policy.period.timezone),
            status="active",
            grace_until=None,
        )

    already_applied = (
        stored.plan_id == intent["toPlanId"]
        and stored.current_period == period
        and stored.status == "active"
    )
    updated = stored if already_applied else await apply_change(repo, stored, change)
    await repo.operations.put(dataclasses.replace(
        op,
        status="done",
        completed_at=clock.now(),
        result={
            **intent,
            "paymentId": payment.id,
            "grantId": grant.id,
            "targetPeriodStart": iso_z(period.start),
            "targetPeriodEnd": iso_z(period.end),
        },
    ))
    return OnRenewalPaidResult(
        sub=updated,
        grant=GrantResult(entry=grant, duplicated=duplicated, deferred=False),
        rollover=_NO_ROLLOVER,
        duplicated=duplicated,
        recovered=sub.status == "past_due",
    )


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

    # SB-10 -- late successful native-provider money after final cancellation/expiry belongs in the
    # webhook's needs-human path; never grant or revive it through this primitive.
    if (
        payment.status == "succeeded"
        and sub.provider in ("stripe", "polar")
        and sub.status in ("canceled", "expired")
    ):
        raise PaymentKitError(
            "terminal native subscription payment requires human review",
            "subscription_terminal_payment",
            {
                "subscription_id": sub.id,
                "payment_id": payment.id,
                "status": sub.status,
            },
        )

    anchor_upgrade = await _settle_upgrade_anchor_invoice(input)
    if anchor_upgrade is not None:
        return anchor_upgrade

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
        paid_plan = await _resolve_paid_plan(
            sub=sub, payment=payment, policy=policy, repo=repo, clock=clock
        ) if needs_advance else None
        updated = replace_sub(
            sub,
            plan_id=paid_plan.id,
            scheduled_plan_id=None,
            current_period=period,
            status="active",
            grace_until=None,
        ) if paid_plan is not None else sub
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

    plan = await _resolve_paid_plan(
        sub=sub, payment=payment, policy=policy, repo=repo, clock=clock
    )

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
    key = pending_upgrade_grant_key(sub.id, period.start)
    op = await repo.operations.get(key)
    if op is None or op.status != "in_progress":
        return
    pending = op.result or {}
    expires = pending.get("expiresAt")
    await ledger.append(NewLedgerEntry(
        customer_id=sub.customer_id, pool="paid", kind="grant", amount=int(pending["amount"]), unit_price_minor=None, currency=None,
        expires_at=datetime.fromisoformat(expires) if expires else None, source="subscription",
        reference=LedgerReference(subscription_id=sub.id, period_start=period.start, payment_id=payment.id),
        idempotency_key=f"grant:{key}:{pending.get('reason', 'upgrade')}", actor="system", reason=str(pending.get("reason", "upgrade")),  # EC:A84
    ))
    await repo.operations.put(dataclasses.replace(op, status="done", completed_at=clock.now()))
