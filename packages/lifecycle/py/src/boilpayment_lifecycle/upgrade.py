"""spec: packages/lifecycle/spec/lifecycle.pseudo.md — EC:A1 A2 A8 J1-J5"""

from __future__ import annotations

import math
from dataclasses import dataclass

from boilpayment_core import (
    Clock,
    IdGen,
    LedgerEntry,
    LedgerReference,
    LedgerStore,
    Money,
    NewLedgerEntry,
    PaymentKitError,
    PaymentProvider,
    Period,
    Plan,
    Policy,
    Repo,
    Subscription,
    deserialize_ledger_entry,
    deserialize_subscription,
    iso_z,
    proration_fraction,
    run_idempotent,
    scale_minor,
    serialize_ledger_entry,
    serialize_subscription,
)

from .internal import (
    replace_sub,
    require_price_for_subscription,
    resolve_price_ref,
    scope_provider,
)
from .period import next_period, proration_ratio


@dataclass(kw_only=True, slots=True)
class UpgradeInput:
    sub: Subscription
    new_plan: Plan
    policy: Policy
    provider: PaymentProvider
    ledger: LedgerStore
    repo: Repo
    clock: Clock
    ids: IdGen
    # EC:J5 — default: "upgrade:{sub.id}:{new_plan.id}:{sub.current_period.start ISO}" if omitted.
    idempotency_key: str | None = None
    # EC:L5 -- when present, scopes this upgrade's change_subscription/charge_billing_key calls to
    # this correlation_id via the duck-typed provider.with_correlation_id(id) (internal.py
    # scope_provider).
    correlation_id: str | None = None


@dataclass(kw_only=True, slots=True)
class UpgradeResult:
    sub: Subscription
    grant: LedgerEntry | None
    credit_delta: int


def _serialize(r: UpgradeResult) -> dict:
    return {
        "sub": serialize_subscription(r.sub),
        "grant": serialize_ledger_entry(r.grant),
        "credit_delta": r.credit_delta,
    }


def _deserialize(v: dict) -> UpgradeResult:
    return UpgradeResult(
        sub=deserialize_subscription(v["sub"]),
        grant=deserialize_ledger_entry(v["grant"]),
        credit_delta=v["credit_delta"],
    )


# EC:A1 A2 A8 — mid-cycle upgrade: immediate proration + credit delta, or scheduled for next period.
# EC:J1-J5 — the whole operation (provider calls + grant + subscription update) is wrapped in
# run_idempotent so a retry after a partial failure replays the first result instead of
# re-charging/re-granting. See spec/lifecycle.pseudo.md [EC:A1 A2 A8] "멱등성" note.
async def upgrade(input: UpgradeInput) -> UpgradeResult:
    key = input.idempotency_key or (
        f"upgrade:{input.sub.id}:{input.new_plan.id}:{iso_z(input.sub.current_period.start)}"
    )

    result = await run_idempotent(
        repo=input.repo,
        clock=input.clock,
        key=key,
        kind="lifecycle.upgrade",
        payload={
            "sub_id": input.sub.id,
            "new_plan_id": input.new_plan.id,
            "period_start": iso_z(input.sub.current_period.start),
        },
        serialize=_serialize,
        deserialize=_deserialize,
        fn=lambda: _do_upgrade(input),
    )
    return result.result


async def _do_upgrade(input: UpgradeInput) -> UpgradeResult:
    sub, new_plan, policy, provider, ledger, repo, clock = (
        input.sub,
        input.new_plan,
        input.policy,
        input.provider,
        input.ledger,
        input.repo,
        input.clock,
    )

    old_plan = await repo.plans.get(sub.plan_id)
    if old_plan is None:
        raise PaymentKitError(f"plan not found: {sub.plan_id}", "plan_not_found")

    # EC:A8 — interval change can be forced to behave like next_period regardless of upgrade.mode
    interval_changed = old_plan.interval != new_plan.interval
    effective_mode = (
        "next_period"
        if interval_changed and policy.interval_change.mode == "next_period"
        else policy.upgrade.mode
    )

    if effective_mode == "next_period":
        updated = replace_sub(sub, scheduled_plan_id=new_plan.id)
        await repo.subscriptions.put(updated)
        return UpgradeResult(sub=updated, grant=None, credit_delta=0)

    reset_anchor = effective_mode == "immediate_prorate_reset_anchor"
    now = clock.now()

    # EC:F — Toss/PortOne (self-scheduling) don't track subscription state on their side:
    # get_subscription/change_subscription/cancel_subscription all raise PaymentKitError('unsupported').
    # We update Repo.subscriptions ourselves instead, and charge the prorated *money* delta directly
    # via the billing key (change_subscription would otherwise have triggered the provider's own
    # proration invoice).
    scoped_provider = scope_provider(provider, input.correlation_id)
    if provider.capabilities().native_subscriptions:
        if sub.provider_ref is None:
            raise PaymentKitError("native subscription mutation requires its provider reference", "subscription_provider_ref_required")
        price_ref = resolve_price_ref(new_plan, sub.provider, sub.currency)
        await scoped_provider.change_subscription(
            sub.provider_ref,
            new_price_ref=price_ref,
            proration="immediate",
            reset_anchor=reset_anchor,
        )
    else:
        if not sub.billing_key:
            raise PaymentKitError(
                "upgrade requires a billing key for self-scheduling providers",
                "billing_key_required",
            )
        # EC:A28 -- both prices in the subscription's currency (spec note #4 used the first price).
        # EC:A33 -- a missing old price is refused, not read as 0 (the whole new price as the delta).
        old_price = require_price_for_subscription(old_plan, sub)
        new_price = require_price_for_subscription(new_plan, sub)
        price_delta_minor = (new_price.amount_minor if new_price else 0) - (
            old_price.amount_minor if old_price else 0
        )
        # EC:J7 -- exact integer proration (a float ratio can land one minor unit short).
        num, den = proration_fraction(sub.current_period, now, policy.proration.denominator)
        prorated_money_delta = scale_minor(price_delta_minor, num, den, "floor")
        if prorated_money_delta > 0 and new_price is not None:
            # EC:J5 — deterministic (not clock.now()-derived): a retry of this same upgrade
            # operation must reuse the same provider-side charge idempotency key.
            charge_key = f"charge:upgrade:{sub.id}:{new_plan.id}:{iso_z(sub.current_period.start)}"
            payment = await scoped_provider.charge_billing_key(
                billing_key=sub.billing_key,
                amount=Money(
                    amount_minor=prorated_money_delta, currency=new_price.currency
                ),
                order_id=charge_key,
                customer_ref=sub.customer_id,
                idempotency_key=charge_key,
            )
            if payment.status != "succeeded":
                raise PaymentKitError(
                    "upgrade charge did not succeed",
                    "upgrade_charge_failed",
                    {"payment": payment},
                )

    current_period: Period = sub.current_period
    anchor_day = sub.anchor_day

    if reset_anchor:
        # EC:G3 — instants stored in UTC; civil-day extraction for non-UTC policy.period.timezone is
        # approximated via UTC date here (core does not expose a public tz-aware civil-day helper).
        # See spec "계약 변경 제안" #1.
        anchor_day = now.day
        interval = new_plan.interval or "month"
        current_period = next_period(
            Period(start=now, end=now),
            interval,
            anchor_day,
            policy.period.timezone,
            policy.period.month_end_anchor,
        )

    # EC:A2 — credit delta, computed against the *original* (pre-upgrade) period's remaining ratio.
    full_delta = new_plan.credits_per_period - old_plan.credits_per_period
    if policy.upgrade.credit_delta == "full_delta":
        delta = full_delta
    else:
        ratio = proration_ratio(sub.current_period, now, policy.proration.denominator)
        delta = math.floor(full_delta * ratio)

    grant: LedgerEntry | None = None
    if delta > 0:
        # EC:J5 — deterministic ledger idempotency key (sub + target plan + *original* period
        # start, not clock.now()); see docs/EDGE_CASES.md §J J5.
        idempotency_key = f"grant:upgrade:{sub.id}:{new_plan.id}:{iso_z(sub.current_period.start)}"
        expires_at = None if policy.credits.rollover == "full" else current_period.end
        result = await ledger.append(
            NewLedgerEntry(
                customer_id=sub.customer_id,
                pool="paid",
                kind="grant",
                amount=delta,
                unit_price_minor=None,
                currency=None,
                expires_at=expires_at,
                source="subscription",
                reference=LedgerReference(
                    subscription_id=sub.id, period_start=current_period.start
                ),
                idempotency_key=idempotency_key,
                actor="system",
                reason=f"upgrade:{old_plan.id}->{new_plan.id}",
            )
        )
        grant = result.entry

    updated = replace_sub(
        sub,
        plan_id=new_plan.id,
        current_period=current_period,
        anchor_day=anchor_day,
        scheduled_plan_id=None,
    )
    await repo.subscriptions.put(updated)

    return UpgradeResult(sub=updated, grant=grant, credit_delta=delta)
