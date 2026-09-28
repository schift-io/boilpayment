"""spec: packages/lifecycle/spec/lifecycle.pseudo.md — EC:A3 A4 J1-J5"""

from __future__ import annotations

from dataclasses import dataclass

from boilpayment_core import (
    Clock,
    IdGen,
    LedgerReference,
    LedgerStore,
    PaymentKitError,
    PaymentProvider,
    Plan,
    Policy,
    Repo,
    Subscription,
    deserialize_ledger_entry,
    deserialize_subscription,
    ledger_instant_key,
    operation_instant_key,
    run_idempotent,
    serialize_ledger_entry,
    serialize_subscription,
)
from boilpayment_credits import ClawbackInput, ClawbackResult, clawback

from .internal import replace_sub, resolve_price_ref, scope_provider


@dataclass(kw_only=True, slots=True)
class DowngradeInput:
    sub: Subscription
    new_plan: Plan
    policy: Policy
    provider: PaymentProvider
    ledger: LedgerStore
    repo: Repo
    clock: Clock
    ids: IdGen
    # EC:J5 — default: "downgrade:{sub.id}:{new_plan.id}:{sub.current_period.start ISO}" if omitted.
    idempotency_key: str | None = None
    # EC:L5 -- when present, scopes this downgrade's change_subscription call to this
    # correlation_id via the duck-typed provider.with_correlation_id(id) (internal.py scope_provider).
    correlation_id: str | None = None


@dataclass(kw_only=True, slots=True)
class DowngradeResult:
    sub: Subscription
    clawback: ClawbackResult | None


def _serialize_clawback(c: ClawbackResult | None) -> dict | None:
    if c is None:
        return None
    return {
        "revoked": c.revoked,
        "shortfall": c.shortfall,
        "entry": serialize_ledger_entry(c.entry),
        "duplicated": c.duplicated,
    }


def _deserialize_clawback(v: dict | None) -> ClawbackResult | None:
    if v is None:
        return None
    return ClawbackResult(
        revoked=v["revoked"],
        shortfall=v["shortfall"],
        entry=deserialize_ledger_entry(v["entry"]),
        duplicated=v["duplicated"],
    )


def _serialize(r: DowngradeResult) -> dict:
    return {
        "sub": serialize_subscription(r.sub),
        "clawback": _serialize_clawback(r.clawback),
    }


def _deserialize(v: dict) -> DowngradeResult:
    return DowngradeResult(
        sub=deserialize_subscription(v["sub"]),
        clawback=_deserialize_clawback(v["clawback"]),
    )


# EC:A3 A4 — downgrade, optionally clawing back the credit surplus immediately.
# EC:J1-J5 — wrapped in run_idempotent so a retry replays the first result instead of re-clawing-back.
async def downgrade(input: DowngradeInput) -> DowngradeResult:
    # EC:J13 (A7-3) -- an earlier release's key for this downgrade, in an older time form, is reused.
    key, stamp = await operation_instant_key(
        input.repo, "lifecycle.downgrade", f"downgrade:{input.sub.id}:{input.new_plan.id}:", input.sub.current_period.start
    )
    key = input.idempotency_key or key

    result = await run_idempotent(
        repo=input.repo,
        clock=input.clock,
        key=key,
        kind="lifecycle.downgrade",
        payload={
            "sub_id": input.sub.id,
            "new_plan_id": input.new_plan.id,
            "period_start": stamp,
        },
        serialize=_serialize,
        deserialize=_deserialize,
        fn=lambda: _do_downgrade(input),
    )
    return result.result


async def _do_downgrade(input: DowngradeInput) -> DowngradeResult:
    sub, new_plan, policy, provider, ledger, clock, repo = (
        input.sub,
        input.new_plan,
        input.policy,
        input.provider,
        input.ledger,
        input.clock,
        input.repo,
    )

    # EC:A61 C11 -- an ended or unpaid subscription does not change plan.
    stored = await repo.subscriptions.get(sub.id)
    if stored is not None and stored.status not in ("active", "trialing"):
        raise PaymentKitError(
            f"a {stored.status} subscription cannot change plan", "subscription_inactive",
            {"subscription_id": sub.id, "status": stored.status},
        )
    old_plan = await repo.plans.get(sub.plan_id)
    if old_plan is None:
        raise PaymentKitError(f"plan not found: {sub.plan_id}", "plan_not_found")

    if policy.downgrade.mode == "end_of_period":
        # SB-14 -- schedule the provider's lower renewal price before recording the local intent.
        if sub.provider in ("stripe", "polar") and provider.capabilities().native_subscriptions:
            if sub.provider_ref is None:
                raise PaymentKitError("native subscription mutation requires its provider reference", "subscription_provider_ref_required")
            price_ref = resolve_price_ref(new_plan, sub.provider, sub.currency)
            await scope_provider(provider, input.correlation_id).change_subscription(
                sub.provider_ref,
                new_price_ref=price_ref,
                proration="none",
                reset_anchor=False,
            )
        updated = replace_sub(sub, scheduled_plan_id=new_plan.id)
        await repo.subscriptions.put(updated)
        return DowngradeResult(sub=updated, clawback=None)

    # EC:F — Toss/PortOne (self-scheduling) don't track subscription state; change_subscription
    # would raise PaymentKitError('unsupported'). We update Repo.subscriptions ourselves instead.
    # Downgrade never needs an immediate charge (price only goes down), so there's nothing to bill.
    if provider.capabilities().native_subscriptions:
        if sub.provider_ref is None:
            raise PaymentKitError("native subscription mutation requires its provider reference", "subscription_provider_ref_required")
        price_ref = resolve_price_ref(new_plan, sub.provider, sub.currency)
        await scope_provider(provider, input.correlation_id).change_subscription(
            sub.provider_ref,
            new_price_ref=price_ref,
            proration="immediate",
            reset_anchor=False,
        )

    clawback_result: ClawbackResult | None = None
    if policy.downgrade.mode == "immediate_clawback":
        delta = old_plan.credits_per_period - new_plan.credits_per_period
        if delta > 0:
            idempotency_key = await ledger_instant_key(
                ledger, sub.customer_id, f"revoke:downgrade:{sub.id}:", sub.current_period.start
            )
            clawback_result = await clawback(
                ClawbackInput(
                    customer_id=sub.customer_id,
                    amount=delta,
                    policy=policy,
                    ledger=ledger,
                    clock=clock,
                    reason=f"downgrade:{old_plan.id}->{new_plan.id}",
                    reference=LedgerReference(
                        subscription_id=sub.id, period_start=sub.current_period.start
                    ),
                    actor="system",
                    idempotency_key=idempotency_key,
                    shortfall=policy.downgrade.clawback_shortfall,
                )
            )
    # 'immediate_keep' — price changes now, no clawback.

    updated = replace_sub(sub, plan_id=new_plan.id, scheduled_plan_id=None)
    await repo.subscriptions.put(updated)

    return DowngradeResult(sub=updated, clawback=clawback_result)
