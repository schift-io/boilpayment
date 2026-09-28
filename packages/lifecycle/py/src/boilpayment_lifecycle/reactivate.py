"""spec: packages/lifecycle/spec/lifecycle.pseudo.md -- EC:A23"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass

from boilpayment_core import (
    Clock,
    LedgerReference,
    LedgerStore,
    NewLedgerEntry,
    PaymentKitError,
    PaymentProvider,
    Policy,
    Repo,
    Subscription,
    SubscriptionStatus,
    deserialize_subscription,
    key_matches_instant,
    ledger_instant_key,
    operation_instant_key,
    run_idempotent,
    serialize_subscription,
)

from .internal import scope_provider


@dataclass(kw_only=True, slots=True)
class ReactivateInput:
    sub: Subscription
    policy: Policy
    provider: PaymentProvider
    ledger: LedgerStore
    repo: Repo
    clock: Clock
    # EC:J5-style default: "reactivate:{sub.id}:{sub.current_period.start ISO}" if omitted.
    idempotency_key: str | None = None
    # EC:L5 -- when present, scopes the uncancel_subscription call below to this correlation_id via
    # the duck-typed provider.with_correlation_id(id) (see internal.py scope_provider).
    correlation_id: str | None = None


@dataclass(kw_only=True, slots=True)
class RestoredCredits:
    restored: int


@dataclass(kw_only=True, slots=True)
class ReactivateResult:
    sub: Subscription
    # Non-None only when policy.cancel.credits == "revoke_immediately" had something to restore.
    restored: RestoredCredits | None
    # EC:A23 -- True only when a native provider (capabilities().native_subscriptions) actually had
    # its own cancellation reversed via provider.uncancel_subscription. False for self-scheduling
    # providers (nothing on the provider side to correct) and for a native provider whose adapter
    # raises PaymentKitError('unsupported') for this operation -- in both cases the Repo-only repair
    # still happens; this field only reports whether the provider itself was notified.
    provider_notified: bool = False


def _serialize(r: ReactivateResult) -> dict:
    return {
        "sub": serialize_subscription(r.sub),
        "restored": {"restored": r.restored.restored} if r.restored else None,
        "provider_notified": r.provider_notified,
    }


def _deserialize(v: dict) -> ReactivateResult:
    restored = v["restored"]
    return ReactivateResult(
        sub=deserialize_subscription(v["sub"]),
        restored=RestoredCredits(restored=restored["restored"]) if restored else None,
        provider_notified=v.get("provider_notified", False),
    )


# EC:A23 restore -- the mirror image of cancel.py's "revoke_immediately" clawback. cancel.py calls
# boilpayment_credits.clawback(), which appends ONE aggregate "revoke" ledger row
# ("revoke:cancel:{sub.id}:{period_start}", no per-grant reference.grant_id) rather than a
# per-bucket breakdown like cs.dispute's revoke_disputed_grants. To restore "attributed per bucket,
# original expiry preserved" (matching the dispute-restore pattern) without changing cancel.py's
# ledger shape or its CancelResult.revoked: ClawbackResult return type (both are exercised by
# existing tests), this reconstructs the buckets that funded that aggregate revoke: every "grant"
# entry that existed by the revoke's created_at, with its live remaining computed as of that same
# instant, oldest-expiry-first (same order ledger.balance/consume use) -- this is exactly the set
# of buckets balance.available was drawn from at cancel time, since revoke_immediately always
# revokes the full available balance. Each bucket is restored with its OWN original
# expires_at/unit_price_minor/currency, keyed "restore:reactivate:{sub.id}:{period_start}:{grant_id}"
# so a retry/replay is a no-op. Any leftover is restored unattributed under a ":remainder" key.
async def _restore_canceled_credits(
    *, ledger: LedgerStore, customer_id: str, sub_id: str, period_start
) -> RestoredCredits:
    # EC:J13 (A7-3) -- the cancel may have been written by an earlier release in an older time form.
    all_entries = await ledger.entries(customer_id, pool="paid")
    revoke_entry = next(
        (e for e in all_entries if key_matches_instant(e.idempotency_key, f"revoke:cancel:{sub_id}:", period_start)), None
    )
    if revoke_entry is None:
        return RestoredCredits(
            restored=0
        )  # nothing revoked at cancel time (e.g. balance was 0)

    total_to_restore = -revoke_entry.amount
    if total_to_restore <= 0:
        return RestoredCredits(restored=0)

    cutoff = revoke_entry.created_at

    def remaining_of(grant) -> int:
        return grant.amount + sum(
            e.amount
            for e in all_entries
            if e.kind != "grant"
            and e.reference.grant_id == grant.id
            and e.created_at <= cutoff
        )

    buckets = [
        (g, remaining_of(g))
        for g in all_entries
        if g.kind == "grant" and g.created_at <= cutoff
    ]
    buckets = [(g, r) for g, r in buckets if r > 0]
    buckets.sort(
        key=lambda gr: (
            gr[0].expires_at.timestamp()
            if gr[0].expires_at is not None
            else float("inf")
        )
    )

    left = total_to_restore
    restored = 0
    for grant, remaining in buckets:
        if left <= 0:
            break
        take = min(left, remaining)
        if take <= 0:
            continue
        result = await ledger.append(
            NewLedgerEntry(
                customer_id=customer_id,
                pool="paid",
                kind="grant",
                amount=take,
                source="subscription",
                reference=LedgerReference(
                    subscription_id=sub_id, period_start=period_start, grant_id=grant.id
                ),
                idempotency_key=await ledger_instant_key(
                    ledger, customer_id, f"restore:reactivate:{sub_id}:", period_start, f":{grant.id}"
                ),
                actor="system",
                reason="A23 reactivate — restoring credits revoked at cancel",
                unit_price_minor=grant.unit_price_minor,
                currency=grant.currency,
                expires_at=grant.expires_at,
            )
        )
        if not result.duplicated:
            restored += take
        left -= take
    if left > 0:
        result = await ledger.append(
            NewLedgerEntry(
                customer_id=customer_id,
                pool="paid",
                kind="grant",
                amount=left,
                source="subscription",
                reference=LedgerReference(
                    subscription_id=sub_id, period_start=period_start
                ),
                idempotency_key=await ledger_instant_key(
                    ledger, customer_id, f"restore:reactivate:{sub_id}:", period_start, ":remainder"
                ),
                actor="system",
                reason="A23 reactivate — restoring credits revoked at cancel (unattributed remainder)",
                unit_price_minor=None,
                currency=None,
                expires_at=None,
            )
        )
        if not result.duplicated:
            restored += left
    return RestoredCredits(restored=restored)


# EC:A23 -- undo a pending or in-period cancellation. Not covered by a policy.* key: this is an
# operation the app calls explicitly ("never mind, keep my subscription"), not a policy branch that
# fires automatically.
#
# EC:J1-J5 -- wrapped in run_idempotent so a retry replays the first result instead of re-restoring.
async def reactivate(input: ReactivateInput) -> ReactivateResult:
    sub = input.sub
    # EC:J13 (A7-3) -- an earlier release's key for this reactivation, in an older time form, is reused.
    key, stamp = await operation_instant_key(input.repo, "lifecycle.reactivate", f"reactivate:{sub.id}:", sub.current_period.start)
    key = input.idempotency_key or key
    # EC:A73 -- a banned customer (a lost dispute) does not get a subscription back.
    owner = await input.repo.customers.get(sub.customer_id)
    if owner is not None and owner.status == "banned":
        raise PaymentKitError("customer is banned", "customer_banned", {"subscription_id": sub.id, "customer_id": sub.customer_id})

    result = await run_idempotent(
        repo=input.repo,
        clock=input.clock,
        key=key,
        kind="lifecycle.reactivate",
        payload={
            "sub_id": sub.id,
            "period_start": stamp,
        },
        serialize=_serialize,
        deserialize=_deserialize,
        fn=lambda: _do_reactivate(input),
    )
    return result.result


async def _do_reactivate(input: ReactivateInput) -> ReactivateResult:
    sub, policy, provider, ledger, repo, clock = (
        input.sub,
        input.policy,
        input.provider,
        input.ledger,
        input.repo,
        input.clock,
    )

    now = clock.now()
    period_ended = now >= sub.current_period.end

    next_status: SubscriptionStatus
    if sub.cancel_at_period_end:
        # Pending cancellation (end_of_period) — never actually stopped serving.
        next_status = "active"
    elif sub.status == "canceled" and not period_ended:
        # Canceled immediately, but the paid-for period the customer already covered hasn't ended.
        next_status = "active"
    else:
        # status == 'expired', or the period already ended, or there was no cancellation in
        # progress to undo (e.g. still 'active'/'trialing'/'past_due' with cancel_at_period_end=
        # False) — nothing to reactivate. The caller must start a new subscription.
        raise PaymentKitError(
            f"subscription {sub.id} is not reactivatable "
            f"(status={sub.status}, cancel_at_period_end={sub.cancel_at_period_end})",
            "not_reactivatable",
            {
                "id": sub.id,
                "status": sub.status,
                "cancel_at_period_end": sub.cancel_at_period_end,
            },
        )

    # EC:F — self-scheduling providers (Toss/Portone) don't track subscription state at all, so
    # there's nothing to tell them; provider_notified stays False. Native providers (Stripe/Polar)
    # get a real uncancel_subscription call (EC:L5-scoped when a correlation_id was given) so the
    # provider-side dashboard reflects the reversal too, not just our Repo row. If the adapter
    # raises PaymentKitError('unsupported') (a native provider that hasn't implemented this yet),
    # fall back to the Repo-only repair — that's still the correct outcome, just unnotified. Any
    # other error (in particular 'not_reactivatable' — the provider says this subscription has
    # already fully ended) propagates: the caller needs to know reactivation is impossible rather
    # than getting a silently-repaired-but-wrong Repo row.
    provider_notified = False
    if provider.capabilities().native_subscriptions:
        if sub.provider_ref is None:
            raise PaymentKitError("native subscription mutation requires its provider reference", "subscription_provider_ref_required")
        try:
            await scope_provider(provider, input.correlation_id).uncancel_subscription(
                sub.provider_ref
            )
            provider_notified = True
        except PaymentKitError as err:
            if err.code == "unsupported":
                provider_notified = False
            else:
                raise

    updated = dataclasses.replace(sub, status=next_status, cancel_at_period_end=False)
    await repo.subscriptions.put(updated)

    restored: RestoredCredits | None = None
    if policy.cancel.credits == "revoke_immediately":
        restored = await _restore_canceled_credits(
            ledger=ledger,
            customer_id=sub.customer_id,
            sub_id=sub.id,
            period_start=sub.current_period.start,
        )

    return ReactivateResult(
        sub=updated, restored=restored, provider_notified=provider_notified
    )
