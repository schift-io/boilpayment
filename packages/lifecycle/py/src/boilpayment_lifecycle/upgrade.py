"""spec: packages/lifecycle/spec/lifecycle.pseudo.md — EC:A1 A2 A8 J1-J5"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta, timezone

from boilpayment_core import (
    Clock,
    IdGen,
    LedgerEntry,
    LedgerReference,
    LedgerStore,
    Money,
    NewLedgerEntry,
    Operation,
    PaymentKitError,
    PaymentProvider,
    Period,
    Plan,
    Policy,
    Repo,
    Subscription,
    civil_day_of,
    deserialize_ledger_entry,
    deserialize_subscription,
    hash_payload,
    iso_z,
    ledger_instant_key,
    operation_instant_key,
    proration_fraction,
    run_idempotent,
    scale_minor,
    serialize_ledger_entry,
    serialize_subscription,
)

from .charge_attempt import with_attempt_lease
from .internal import (
    replace_sub,
    require_price_for_subscription,
    resolve_price_ref,
    scope_provider,
)
from .period import next_period, proration_ratio
from .upgrade_charge import charge_upgrade_delta


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
# EC:A61 — the change is decided against the stored row, under a per-subscription lease taken before any
# charge: two upgrades at once (pro and max) cannot both charge, and a stale snapshot is refused.
def pending_upgrade_grant_key(sub_id: str, plan_id: str, period_start: datetime) -> str:
    """EC:A77 -- the operation holding an upgrade delta that waits for its provider order to be paid."""
    return f"upgrade-grant:{sub_id}:{plan_id}:{iso_z(period_start)}"


async def upgrade(input: UpgradeInput) -> UpgradeResult:
    # EC:J13 (A7-3) -- an earlier release's key for this upgrade, in an older time form, is reused, and so
    # is the time text its charge key carried.
    key, stamp = await operation_instant_key(
        input.repo, "lifecycle.upgrade", f"upgrade:{input.sub.id}:{input.new_plan.id}:", input.sub.current_period.start
    )
    if input.idempotency_key:
        key = input.idempotency_key
        # EC:A63 (A8-6) -- a caller key an earlier release started hashed the period start in its own time form.
        stamp = await _caller_key_stamp(input, key, stamp)

    async def run() -> UpgradeResult:
        held, value = await with_attempt_lease(
            input.repo, input.clock, f"upgrade:{input.sub.id}", lambda: _do_upgrade(input, stamp)
        )
        if not held:
            raise PaymentKitError(
                "another change of this subscription is in progress", "subscription_change_in_flight",
                {"subscription_id": input.sub.id},
            )
        return value

    result = await run_idempotent(
        repo=input.repo,
        clock=input.clock,
        key=key,
        kind="lifecycle.upgrade",
        payload=_payload(input, stamp),
        serialize=_serialize,
        deserialize=_deserialize,
        fn=run,
    )
    return result.result


def _payload(input: UpgradeInput, stamp: str) -> dict:
    return {"sub_id": input.sub.id, "new_plan_id": input.new_plan.id, "period_start": stamp}


def _instant_forms(at: datetime) -> list[str]:
    """Every text an earlier release could have written for ``at``: iso_z, and isoformat() in any UTC offset
    (the database session's time zone decided it)."""
    forms = [iso_z(at)]
    for minutes in range(-12 * 60, 14 * 60 + 1, 15):
        forms.append(at.astimezone(timezone(timedelta(minutes=minutes))).isoformat())
    return forms


async def _caller_key_stamp(input: UpgradeInput, key: str, stamp: str) -> str:
    existing = await input.repo.operations.get(key)
    if existing is None or existing.payload_hash == hash_payload(_payload(input, stamp)):
        return stamp
    for form in _instant_forms(input.sub.current_period.start):
        if existing.payload_hash == hash_payload(_payload(input, form)):
            return form
    return stamp


# EC:A61 C11 -- the states an upgrade applies to; anything else is refused before any charge.
_UPGRADABLE = ("active", "trialing")


async def read_for_change(repo: Repo, sub: Subscription, target_plan_id: str) -> Subscription | None:
    """EC:A61 -- the stored row this change applies to, checked before any charge. None when the change is
    already applied (a retry after it was written, or the same change from another request)."""
    stored = await repo.subscriptions.get(sub.id)
    if stored is None:
        raise PaymentKitError(f"subscription not found: {sub.id}", "subscription_not_found")
    if stored.plan_id == target_plan_id and stored.scheduled_plan_id is None and sub.plan_id != target_plan_id:
        return None
    if (stored.version or 0) != (sub.version or 0):
        raise PaymentKitError(
            "the subscription changed since it was read; read it again and retry", "subscription_changed",
            {"subscription_id": sub.id, "read_version": sub.version, "stored_version": stored.version,
             "stored_plan_id": stored.plan_id},
        )
    if stored.status not in _UPGRADABLE:
        raise PaymentKitError(
            f"a {stored.status} subscription cannot change plan", "subscription_inactive",
            {"subscription_id": sub.id, "status": stored.status},
        )
    return stored


async def apply_change(repo: Repo, read: Subscription, change) -> Subscription:  # type: ignore[no-untyped-def]
    """EC:A61 -- write a change that already charged: a concurrent writer bumping the version must not
    leave the money without the plan. The change is re-applied to the row as it is now."""
    base = read
    for attempt in range(5):
        nxt = change(base)
        try:
            await repo.subscriptions.put(nxt)
            return nxt
        except PaymentKitError as err:
            if err.code != "subscription_version_conflict" or attempt >= 4:
                raise
            fresh = await repo.subscriptions.get(read.id)
            if fresh is None:
                raise
            base = fresh
    raise AssertionError("unreachable")


async def _do_upgrade(input: UpgradeInput, stamp: str) -> UpgradeResult:
    new_plan, policy, provider, ledger, repo, clock = (
        input.new_plan,
        input.policy,
        input.provider,
        input.ledger,
        input.repo,
        input.clock,
    )
    read = await read_for_change(repo, input.sub, new_plan.id)
    if read is None:
        current = await repo.subscriptions.get(input.sub.id)
        assert current is not None
        return UpgradeResult(sub=current, grant=None, credit_delta=0)
    sub = read

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
    native = provider.capabilities().native_subscriptions
    # EC:J7 -- exact integer proration: the unused share of the old period.
    num, den = proration_fraction(sub.current_period, now, policy.proration.denominator)
    payment = None

    # EC:F — Toss/PortOne (self-scheduling) don't track subscription state on their side:
    # get_subscription/change_subscription/cancel_subscription all raise PaymentKitError('unsupported').
    # We update Repo.subscriptions ourselves instead, and charge the prorated *money* delta directly
    # via the billing key (change_subscription would otherwise have triggered the provider's own
    # proration invoice).
    scoped_provider = scope_provider(provider, input.correlation_id)
    changed: Subscription | None = None
    if native:
        if sub.provider_ref is None:
            raise PaymentKitError("native subscription mutation requires its provider reference", "subscription_provider_ref_required")
        price_ref = resolve_price_ref(new_plan, sub.provider, sub.currency)
        changed = await scoped_provider.change_subscription(
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
        # EC:A59 -- reset_anchor starts a whole new period now: it costs the new price less the unused share
        # of the old one (what Stripe's billing_cycle_anchor=now charges). keep_anchor charges the price
        # difference for the rest of the current period.
        if reset_anchor:
            money = new_price.amount_minor - scale_minor(old_price.amount_minor, num, den, "ceil")
        else:
            money = scale_minor(new_price.amount_minor - old_price.amount_minor, num, den, "floor")
        if money > 0:
            # EC:J5 — deterministic (not clock.now()-derived): a retry of this same upgrade
            # operation must reuse the same provider-side charge idempotency key.
            charge_key = f"charge:upgrade:{sub.id}:{new_plan.id}:{iso_z(sub.current_period.start)}"
            # EC:A57 A62 -- a valid provider orderId and a local payment row; an earlier release's raw-key
            # order (in its own time form, A7-3/A8-6) is looked up first.
            payment = await charge_upgrade_delta(
                provider=scoped_provider, repo=repo, clock=clock, sub=sub, plan_id=new_plan.id, charge_key=charge_key,
                legacy_order_ids=[charge_key, f"charge:upgrade:{sub.id}:{new_plan.id}:{stamp}",
                                  f"charge:upgrade:{sub.id}:{new_plan.id}:{sub.current_period.start.astimezone(UTC).isoformat()}"],
                amount=Money(amount_minor=money, currency=new_price.currency),
                revert={"fromPlanId": sub.plan_id, "fromPeriodStart": iso_z(sub.current_period.start),  # EC:A76
                        "fromPeriodEnd": iso_z(sub.current_period.end), "fromAnchorDay": sub.anchor_day},
            )
            if payment.status != "succeeded":
                raise PaymentKitError(
                    "upgrade charge did not succeed",
                    "upgrade_charge_failed",
                    {"payment": payment},
                )

    current_period: Period = sub.current_period
    anchor_day = sub.anchor_day

    if native:
        # EC:A77 -- the provider decides the period after a native change (Polar never resets the anchor).
        if changed is not None and getattr(changed, "current_period", None) is not None:
            current_period = changed.current_period
            anchor_day = changed.anchor_day or anchor_day
    elif reset_anchor:
        # EC:A71 — the new anchor is today's civil day in the policy timezone (a UTC day gives a KST
        # 1st-of-month upgrade the previous month's last day, and a two-month first period).
        anchor_day = civil_day_of(now, policy.period.timezone)
        interval = new_plan.interval or "month"
        current_period = next_period(
            Period(start=now, end=now),
            interval,
            anchor_day,
            policy.period.timezone,
            policy.period.month_end_anchor,
        )

    # EC:A2 — credit delta, computed against the *original* (pre-upgrade) period's remaining ratio.
    # EC:A59 -- a self-scheduled reset_anchor upgrade bought a whole new period less the old period's unused
    # share, so it grants the new plan's credits less the old plan's unused share (either credit_delta).
    full_delta = new_plan.credits_per_period - old_plan.credits_per_period
    # EC:A77 -- a native reset_anchor change is billed by the provider as a new period whose paid invoice
    # grants it: no delta on top. A provider that bills the change as a later order (Polar) gets its delta
    # granted when that order's paid webhook arrives.
    grant_on_payment = native and getattr(provider.capabilities(), "upgrade_grant", "sync") == "on_payment"
    if native and reset_anchor and not grant_on_payment:
        delta = 0
    elif reset_anchor and not native:
        delta = new_plan.credits_per_period - scale_minor(old_plan.credits_per_period, num, den, "floor")
    elif policy.upgrade.credit_delta == "full_delta":
        delta = full_delta
    else:
        ratio = proration_ratio(sub.current_period, now, policy.proration.denominator)
        delta = math.floor(full_delta * ratio)

    grant: LedgerEntry | None = None
    if delta > 0 and grant_on_payment:
        key = pending_upgrade_grant_key(sub.id, new_plan.id, current_period.start)
        await repo.operations.put(Operation(
            id=key, key=key, kind="lifecycle.upgrade_grant", payload_hash="", status="in_progress", error=None,
            created_at=now, completed_at=None, attempts=0,
            result={"amount": delta, "expiresAt": None if policy.credits.rollover == "full" else iso_z(current_period.end),
                    "reason": f"upgrade:{old_plan.id}->{new_plan.id}"},
        ))
    elif delta > 0:
        # EC:J5 — deterministic ledger idempotency key (sub + target plan + *original* period
        # start, not clock.now()); see docs/EDGE_CASES.md §J J5.
        idempotency_key = await ledger_instant_key(
            ledger, sub.customer_id, f"grant:upgrade:{sub.id}:{new_plan.id}:", sub.current_period.start
        )
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
                # EC:A62 -- the credits a refund of the upgrade charge takes back (EC:D20) are the ones it bought.
                reference=LedgerReference(
                    subscription_id=sub.id, period_start=current_period.start,
                    payment_id=payment.id if payment is not None else None,
                ),
                idempotency_key=idempotency_key,
                actor="system",
                reason=f"upgrade:{old_plan.id}->{new_plan.id}",
            )
        )
        grant = result.entry

    def change(base: Subscription) -> Subscription:
        if reset_anchor or native:
            return replace_sub(base, plan_id=new_plan.id, scheduled_plan_id=None, current_period=current_period, anchor_day=anchor_day)
        return replace_sub(base, plan_id=new_plan.id, scheduled_plan_id=None)

    updated = await apply_change(repo, sub, change)
    return UpgradeResult(sub=updated, grant=grant, credit_delta=delta)
