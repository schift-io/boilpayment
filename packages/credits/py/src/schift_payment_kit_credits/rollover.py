"""spec: packages/credits/spec/credits.pseudo.md — EC:B1 B2"""

from __future__ import annotations

from dataclasses import dataclass, field

from schift_payment_kit_core import (
    Clock,
    LedgerEntry,
    LedgerReference,
    LedgerStore,
    NewLedgerEntry,
    Period,
    Policy,
    Subscription,
)


@dataclass(kw_only=True, slots=True)
class RolloverInput:
    sub: Subscription
    policy: Policy
    ledger: LedgerStore
    clock: Clock
    new_period: Period


@dataclass(kw_only=True, slots=True)
class RolloverResult:
    entries: list[LedgerEntry] = field(default_factory=list)
    banked: int = 0
    expired: int = 0


def _no_op() -> RolloverResult:
    return RolloverResult(entries=[], banked=0, expired=0)


# EC:B1 B2 — carries unexpired balance of the previous period's subscription grant into the
# new period when policy.credits.rollover == 'banked', capped by bank_cap.
async def rollover_on_renewal(input: RolloverInput) -> RolloverResult:
    sub, policy, ledger, clock, new_period = (
        input.sub,
        input.policy,
        input.ledger,
        input.clock,
        input.new_period,
    )

    if policy.credits.rollover == "none":
        # previous grant already carries expires_at = old period.end and lapses on its own
        return _no_op()
    if policy.credits.rollover == "full":
        # previous grant has expires_at = None; nothing to move
        return _no_op()

    # 'banked'
    now = clock.now()
    all_entries = await ledger.entries(sub.customer_id)

    previous_grants = [
        e
        for e in all_entries
        if e.kind == "grant"
        and e.pool == "paid"
        and e.source == "subscription"
        and e.reference.subscription_id == sub.id
        and e.expires_at is not None
        and e.expires_at <= new_period.start
    ]

    remaining = 0
    for g in previous_grants:
        used = sum(
            e.amount
            for e in all_entries
            if e.kind in ("consume", "revoke") and e.reference.grant_id == g.id
        )  # consume/revoke amounts are negative
        remaining += max(0, g.amount + used)

    if remaining <= 0:
        return _no_op()

    bank_cap = (
        policy.credits.bank_cap
    )  # required non-null when rollover='banked' (validated in policy.py)
    # EC:B2 bank_reset='on_renewal' (default) is satisfied by recomputing the *currently active*
    # banked total every renewal, as below. 'never'/'on_cancel' would force banked credits back to
    # zero at a different trigger (e.g. lifecycle.cancel) — out of scope here, see spec note.
    already_banked = sum(
        e.amount
        for e in all_entries
        if e.kind == "grant"
        and e.pool == "paid"
        and e.source == "rollover"
        and (e.expires_at is None or e.expires_at > now)
    )

    cap_remaining = remaining if bank_cap is None else max(0, bank_cap - already_banked)
    banked = min(remaining, cap_remaining)
    expired = remaining - banked

    entries: list[LedgerEntry] = []

    # EC:B1 -- excess over bank_cap is NOT written as an entry: source grants lapse on their own
    # expires_at, and an unattributed 'expire' row would be double-counted by the ledger (found by e2e).

    if banked > 0:
        result = await ledger.append(
            NewLedgerEntry(
                customer_id=sub.customer_id,
                pool="paid",
                kind="grant",
                amount=banked,
                unit_price_minor=None,
                currency=None,
                expires_at=new_period.end,
                source="rollover",
                reference=LedgerReference(
                    subscription_id=sub.id, period_start=new_period.start
                ),
                idempotency_key=f"rollover:{sub.id}:{new_period.start.isoformat()}",
                actor="system",
                reason=None,
            )
        )
        entries.append(result.entry)

    return RolloverResult(entries=entries, banked=banked, expired=expired)
