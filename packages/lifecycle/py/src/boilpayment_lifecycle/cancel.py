"""spec: packages/lifecycle/spec/lifecycle.pseudo.md — EC:A5 A6 A10 I4 J1-J5"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from boilpayment_core import (
    Clock,
    LedgerReference,
    LedgerStore,
    PaymentKitError,
    PaymentProvider,
    Policy,
    Repo,
    Subscription,
    deserialize_ledger_entry,
    deserialize_subscription,
    run_idempotent,
    serialize_ledger_entry,
    serialize_subscription,
)
from boilpayment_credits import ClawbackInput, ClawbackResult, clawback

from .internal import replace_sub, revoke_pool_balance, scope_provider


@dataclass(kw_only=True, slots=True)
class ChurnInfo:
    customer_id: str
    subscription_id: str
    reason: str | None
    text: str | None


@dataclass(kw_only=True, slots=True)
class CancelInput:
    sub: Subscription
    policy: Policy
    provider: PaymentProvider
    ledger: LedgerStore
    repo: Repo
    clock: Clock
    churn_reason: str | None = None
    churn_text: str | None = None
    # EC:I4 — churn is always recorded on the returned object; persisting a CsCase is the cs
    # module's job. Pass a callback if the caller wants to persist it inline (e.g. via cs.churn.record).
    on_churn: Callable[[ChurnInfo], Any | Awaitable[Any]] | None = None
    # EC:J5 — default: "cancel:{sub.id}:{sub.current_period.start ISO}" if omitted.
    idempotency_key: str | None = None
    # EC:L5 -- when present, scopes this cancel's cancel_subscription call to this correlation_id
    # via the duck-typed provider.with_correlation_id(id) (internal.py scope_provider).
    correlation_id: str | None = None


@dataclass(kw_only=True, slots=True)
class Churn:
    reason: str | None
    text: str | None


@dataclass(kw_only=True, slots=True)
class CancelResult:
    sub: Subscription
    churn: Churn
    revoked: ClawbackResult | None


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


def _serialize(r: CancelResult) -> dict:
    return {
        "sub": serialize_subscription(r.sub),
        "churn": {"reason": r.churn.reason, "text": r.churn.text},
        "revoked": _serialize_clawback(r.revoked),
    }


def _deserialize(v: dict) -> CancelResult:
    return CancelResult(
        sub=deserialize_subscription(v["sub"]),
        churn=Churn(reason=v["churn"]["reason"], text=v["churn"]["text"]),
        revoked=_deserialize_clawback(v["revoked"]),
    )


# EC:A5 A6 A10 I4 — cancel now or at period end; resolve outstanding credits per policy.
# EC:J1-J5 — wrapped in run_idempotent so a retry replays the first result instead of re-revoking.
async def cancel(input: CancelInput) -> CancelResult:
    if input.policy.cancel.credits == "keep_forever":
        raise PaymentKitError(
            "cancel.credits=keep_forever is not supported by the append-only ledger", "unsupported"
        )
    key = input.idempotency_key or (
        f"cancel:{input.sub.id}:{input.sub.current_period.start.isoformat()}"
    )

    result = await run_idempotent(
        repo=input.repo,
        clock=input.clock,
        key=key,
        kind="lifecycle.cancel",
        payload={
            "sub_id": input.sub.id,
            "period_start": input.sub.current_period.start.isoformat(),
        },
        serialize=_serialize,
        deserialize=_deserialize,
        fn=lambda: _do_cancel(input),
    )
    return result.result


async def _do_cancel(input: CancelInput) -> CancelResult:
    sub, policy, provider, ledger, repo, clock = (
        input.sub,
        input.policy,
        input.provider,
        input.ledger,
        input.repo,
        input.clock,
    )

    at_period_end = policy.cancel.mode == "end_of_period"
    # EC:F — Toss/PortOne (self-scheduling) don't track subscription state; cancel_subscription
    # would raise PaymentKitError('unsupported'). We just stop scheduling future charges via Repo
    # below (scheduler.due_subscriptions excludes cancel_at_period_end subscriptions).
    if provider.capabilities().native_subscriptions:
        if sub.provider_ref is None:
            raise PaymentKitError("native subscription mutation requires its provider reference", "subscription_provider_ref_required")
        await scope_provider(provider, input.correlation_id).cancel_subscription(
            sub.provider_ref, at_period_end=at_period_end
        )

    revoked: ClawbackResult | None = None

    # EC:A6
    if policy.cancel.credits == "revoke_immediately":
        balance = await ledger.balance(sub.customer_id, "paid", clock.now())
        if balance.available > 0:
            revoked = await clawback(
                ClawbackInput(
                    customer_id=sub.customer_id,
                    amount=balance.available,
                    policy=policy,
                    ledger=ledger,
                    clock=clock,
                    reason="cancel",
                    reference=LedgerReference(
                        subscription_id=sub.id, period_start=sub.current_period.start
                    ),
                    actor="system",
                    idempotency_key=f"revoke:cancel:{sub.id}:{sub.current_period.start.isoformat()}",
                    shortfall="clamp_to_zero",
                )
            )
    # 'keep_until_period_end' — no-op, existing grant.expires_at already governs this.

    # EC:A10 — trial credits revoked on cancel while still trialing
    if sub.status == "trialing" and policy.trial.credits_on_cancel == "revoke":
        await revoke_pool_balance(
            "trial",
            ledger,
            clock,
            sub.customer_id,
            LedgerReference(subscription_id=sub.id),
            f"revoke:trial-cancel:{sub.id}",
            "trial_cancel",
        )

    updated = replace_sub(
        sub,
        status=sub.status if at_period_end else "canceled",
        cancel_at_period_end=at_period_end,
    )
    await repo.subscriptions.put(updated)

    churn = Churn(reason=input.churn_reason, text=input.churn_text)
    if input.on_churn:
        result = input.on_churn(
            ChurnInfo(
                customer_id=sub.customer_id,
                subscription_id=sub.id,
                reason=input.churn_reason,
                text=input.churn_text,
            )
        )
        if hasattr(result, "__await__"):
            await result

    return CancelResult(sub=updated, churn=churn, revoked=revoked)
