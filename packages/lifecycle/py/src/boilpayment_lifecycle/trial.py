"""spec: packages/lifecycle/spec/lifecycle.pseudo.md — EC:A9 A11 J1-J5"""

from __future__ import annotations

from dataclasses import dataclass

from boilpayment_core import (
    Clock,
    LedgerEntry,
    LedgerReference,
    LedgerStore,
    NewLedgerEntry,
    Payment,
    Plan,
    Policy,
    Repo,
    Subscription,
    deserialize_ledger_entry,
    deserialize_subscription,
    run_idempotent,
    serialize_ledger_entry,
    serialize_subscription,
)

from .internal import replace_sub, revoke_pool_balance


@dataclass(kw_only=True, slots=True)
class ConvertTrialInput:
    sub: Subscription
    plan: Plan  # plan being converted to (paid)
    payment: Payment
    policy: Policy
    ledger: LedgerStore
    repo: Repo
    clock: Clock
    # EC:J5 — default: "convert-trial:{sub.id}:{plan.id}" if omitted.
    idempotency_key: str | None = None


@dataclass(kw_only=True, slots=True)
class ConvertTrialResult:
    sub: Subscription
    grant: LedgerEntry | None
    trial_revoked: LedgerEntry | None


def _serialize(r: ConvertTrialResult) -> dict:
    return {
        "sub": serialize_subscription(r.sub),
        "grant": serialize_ledger_entry(r.grant),
        "trial_revoked": serialize_ledger_entry(r.trial_revoked),
    }


def _deserialize(v: dict) -> ConvertTrialResult:
    return ConvertTrialResult(
        sub=deserialize_subscription(v["sub"]),
        grant=deserialize_ledger_entry(v["grant"]),
        trial_revoked=deserialize_ledger_entry(v["trial_revoked"]),
    )


# EC:A9 — trial -> paid conversion, deciding what happens to trial-pool credits.
# EC:J1-J5 — wrapped in run_idempotent so a retry replays the first result instead of re-granting.
async def convert_trial(input: ConvertTrialInput) -> ConvertTrialResult:
    key = input.idempotency_key or f"convert-trial:{input.sub.id}:{input.plan.id}"

    result = await run_idempotent(
        repo=input.repo,
        clock=input.clock,
        key=key,
        kind="lifecycle.convertTrial",
        payload={
            "sub_id": input.sub.id,
            "plan_id": input.plan.id,
            "payment_id": input.payment.id,
        },
        serialize=_serialize,
        deserialize=_deserialize,
        fn=lambda: _do_convert_trial(input),
    )
    return result.result


async def _do_convert_trial(input: ConvertTrialInput) -> ConvertTrialResult:
    sub, plan, payment, policy, ledger, repo, clock = (
        input.sub,
        input.plan,
        input.payment,
        input.policy,
        input.ledger,
        input.repo,
        input.clock,
    )

    grant: LedgerEntry | None = None
    trial_revoked: LedgerEntry | None = None

    if policy.trial.credits_on_convert != "no_grant_until_next_period":
        # EC:J5 — deterministic (not clock.now()-derived).
        idempotency_key = f"grant:convert-trial:{sub.id}:{plan.id}"
        unit_price_minor = (
            payment.amount.amount_minor // plan.credits_per_period
            if plan.credits_per_period > 0
            else None
        )
        result = await ledger.append(
            NewLedgerEntry(
                customer_id=sub.customer_id,
                pool="paid",
                kind="grant",
                amount=plan.credits_per_period,
                unit_price_minor=unit_price_minor,
                currency=payment.amount.currency,
                expires_at=None
                if policy.credits.rollover == "full"
                else sub.current_period.end,
                source="subscription",
                reference=LedgerReference(
                    subscription_id=sub.id,
                    period_start=sub.current_period.start,
                    payment_id=payment.id,
                ),
                idempotency_key=idempotency_key,
                actor="system",
                reason="trial_convert",
            )
        )
        grant = result.entry

        if policy.trial.credits_on_convert == "grant_full":
            trial_revoked = await revoke_pool_balance(
                "trial",
                ledger,
                clock,
                sub.customer_id,
                LedgerReference(subscription_id=sub.id),
                f"revoke:trial-convert:{sub.id}",
                "trial_convert_discard",
            )
        # 'grant_full_keep_trial' — leave trial pool untouched
    # 'no_grant_until_next_period' — the next on_renewal_paid call grants under its own period key

    updated = replace_sub(sub, status="active", plan_id=plan.id)
    await repo.subscriptions.put(updated)

    return ConvertTrialResult(sub=updated, grant=grant, trial_revoked=trial_revoked)


@dataclass(kw_only=True, slots=True)
class TrialEligibilityInput:
    customer_id: str
    email: str | None
    repo: Repo
    policy: Policy


# EC:A11 — one trial per customer (own subscription history + same-email customer records).
async def is_trial_eligible(input: TrialEligibilityInput) -> bool:
    if input.policy.trial.abuse_guard == "none":
        return True

    own_subs = await input.repo.subscriptions.list(customer_id=input.customer_id)
    if len(own_subs) > 0:
        return False

    if input.email:
        same_email = await input.repo.customers.list(email=input.email)
        for c in same_email:
            if c.id == input.customer_id:
                continue
            subs = await input.repo.subscriptions.list(customer_id=c.id)
            if len(subs) > 0:
                return False

    return True
