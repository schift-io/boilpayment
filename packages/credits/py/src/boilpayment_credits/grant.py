"""spec: packages/credits/spec/credits.pseudo.md"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from boilpayment_core import (
    Clock,
    LedgerEntry,
    LedgerReference,
    LedgerSource,
    LedgerStore,
    NewLedgerEntry,
    Payment,
    PaymentKitError,
    Period,
    Plan,
    Policy,
    Pool,
    Repo,
    Subscription,
    deserialize_ledger_entry,
    iso_z,
    key_matches_instant,
    run_idempotent,
    serialize_ledger_entry,
)


@dataclass(kw_only=True, slots=True)
class GrantResult:
    entry: LedgerEntry | None
    duplicated: bool
    deferred: bool
    # EC:B17 — portion of this grant redirected to settle a pre-existing negative balance. 0 when none.
    offset: int = 0
    # EC:B17 — the 'adjust' entries written to record the settlement (empty when offset == 0).
    offset_entries: list[LedgerEntry] = field(default_factory=list)


async def _write_grant(ledger: LedgerStore, entry: NewLedgerEntry) -> GrantResult:
    result = await ledger.append(entry)
    return GrantResult(entry=result.entry, duplicated=result.duplicated, deferred=False)


# EC:B17 — settle a negative balance against an incoming grant (policy.credits.negative_offset ==
# 'offset_next_grant', the default; 'never' leaves the debt outstanding and this is a no-op).
#
# A negative paid-pool balance only ever exists as an UNBUCKETED ledger entry (no reference.grant_id
# -- see EC:A4/EC:B4 clawback('allow_negative')/consume('allow_to_floor'|'allow_unbounded')): buckets
# themselves can't go negative, only the aggregate can. Plain arithmetic already nets the aggregate
# correctly the moment the grant lands (available = old_debt + grant_amount) -- the bug this closes
# is that the FRESH GRANT'S OWN BUCKET still shows the full amount as spendable, so a consume() call
# that only checks bucket remaining (not the aggregate) can draw past the true limit. Fixing that
# needs a balanced PAIR of entries, not one: -offset tied to the new grant's bucket (caps what's
# really spendable from it -- "only the remainder becomes spendable") and +offset unbucketed
# (retires the old debt so a LATER grant doesn't try to offset the same debt again). Together they
# net to zero, so the aggregate total is unchanged -- only the bucket-level accounting is corrected.
async def _apply_negative_offset(
    *,
    ledger: LedgerStore,
    policy: Policy,
    pre_grant_available: int,
    customer_id: str,
    pool: Pool,
    grant: LedgerEntry,
    source: LedgerSource,
    reference: LedgerReference,
    grant_idempotency_key: str,
) -> tuple[int, list[LedgerEntry]]:
    if policy.credits.negative_offset != "offset_next_grant":
        return 0, []
    if pre_grant_available >= 0:
        return 0, []

    debt = -pre_grant_available
    offset = min(debt, grant.amount)
    if offset <= 0:
        return 0, []

    entries: list[LedgerEntry] = []
    cap = await ledger.append(
        NewLedgerEntry(
            customer_id=customer_id,
            pool=pool,
            kind="adjust",
            amount=-offset,
            unit_price_minor=None,
            currency=None,
            expires_at=None,
            source=source,
            reference=dataclasses.replace(reference, grant_id=grant.id),
            idempotency_key=f"offset:{grant_idempotency_key}",
            actor="system",
            reason="negative_balance_offset",
        )
    )
    entries.append(cap.entry)

    settle = await ledger.append(
        NewLedgerEntry(
            customer_id=customer_id,
            pool=pool,
            kind="adjust",
            amount=offset,
            unit_price_minor=None,
            currency=None,
            expires_at=None,
            source=source,
            reference=reference,
            idempotency_key=f"offset:{grant_idempotency_key}:settled",
            actor="system",
            reason="negative_balance_offset",
        )
    )
    entries.append(settle.entry)

    return offset, entries


def _price_credits(amount_minor: int, credits: int) -> tuple[int, int]:
    if credits <= 0:
        return 0, amount_minor
    unit_price_minor = amount_minor // credits
    remainder_minor = amount_minor - unit_price_minor * credits
    return unit_price_minor, remainder_minor


@dataclass(kw_only=True, slots=True)
class GrantForPeriodInput:
    sub: Subscription
    plan: Plan
    period: Period
    payment: Payment
    policy: Policy
    ledger: LedgerStore
    clock: Clock
    # EC:L5 -- optional delivery-scoped id, merged into reference.correlation_id on the grant
    # (and any EC:B17 offset) entries this call writes.
    correlation_id: str | None = None


# EC:B1 B2 B7 A15 — subscription-period credit grant
async def grant_for_period(input: GrantForPeriodInput) -> GrantResult:
    sub, plan, period, payment, policy, ledger = (
        input.sub,
        input.plan,
        input.period,
        input.payment,
        input.policy,
        input.ledger,
    )
    correlation_id = input.correlation_id

    # EC:A15 — defer grant while in grace/past_due unless policy says grant anyway
    if (
        sub.status == "past_due"
        and policy.dunning.grant_during_grace == "defer_until_paid"
    ):
        return GrantResult(entry=None, duplicated=False, deferred=True)

    # EC:B12 — deterministic key means a re-delivered webhook's retry is a no-op (ledger.append dedupes).
    idempotency_key = f"grant:{sub.id}:{iso_z(period.start)}"
    amount = plan.credits_per_period
    unit_price_minor, remainder_minor = _price_credits(
        payment.amount.amount_minor, amount
    )

    # EC:B1 — rollover mode decides this grant's own expiry (banked still expires at period.end;
    # the carry-over is written separately by rollover_on_renewal at the next renewal).
    expires_at: datetime | None = (
        None if policy.credits.rollover == "full" else period.end
    )

    reference = LedgerReference(
        subscription_id=sub.id,
        period_start=period.start,
        payment_id=payment.id,
        correlation_id=correlation_id,
    )

    # EC:B17 — read the balance BEFORE this grant lands; querying after would already include the
    # grant amount, hiding the very debt it's supposed to offset.
    pre_grant_available = (
        (await ledger.balance(sub.customer_id, "paid", input.clock.now())).available
        if policy.credits.negative_offset == "offset_next_grant"
        else 0
    )

    # EC:J11 -- a grant written for this period under an older key form is the same grant.
    for e in await ledger.entries(sub.customer_id, kind="grant", source="subscription"):
        if e.idempotency_key != idempotency_key and key_matches_instant(
            e.idempotency_key, f"grant:{sub.id}:", period.start
        ):
            return GrantResult(entry=e, duplicated=True, deferred=False)

    result = await _write_grant(
        ledger,
        NewLedgerEntry(
            customer_id=sub.customer_id,
            pool="paid",
            kind="grant",
            amount=amount,
            unit_price_minor=unit_price_minor,
            currency=payment.amount.currency,
            expires_at=expires_at,
            source="subscription",
            reference=reference,
            idempotency_key=idempotency_key,
            actor="system",
            reason=f"remainder_minor:{remainder_minor}"
            if remainder_minor > 0
            else None,
        ),
    )

    # EC:B17 — only offset a freshly-written grant, not a deduped replay of one already offset.
    if result.entry is None or result.duplicated:
        return result
    offset, entries = await _apply_negative_offset(
        ledger=ledger,
        policy=policy,
        pre_grant_available=pre_grant_available,
        customer_id=sub.customer_id,
        pool="paid",
        grant=result.entry,
        source="subscription",
        reference=reference,
        grant_idempotency_key=idempotency_key,
    )
    return dataclasses.replace(result, offset=offset, offset_entries=entries)


@dataclass(kw_only=True, slots=True)
class TopupInput:
    customer_id: str
    payment: Payment
    credits: int
    policy: Policy
    ledger: LedgerStore
    clock: Clock
    # EC:J1-J5 — optional: when provided, the grant is wrapped in run_idempotent (Operation-tracked,
    # rejects same-key/different-payload retries, in-flight duplicate detection). When omitted,
    # topup() falls back to its pre-existing behavior (ledger.append's own idempotency_key UNIQUE
    # dedup on "topup:{payment.id}") for backward compatibility with callers that only have the
    # narrower {customer_id, payment, credits, policy, ledger, clock} shape (e.g.
    # packages/webhook's duck-typed CreditsDeps).
    repo: Repo | None = None
    # EC:J5 — default: "topup:{payment.id}" if omitted (same as the ledger-level key).
    idempotency_key: str | None = None
    # EC:L5 -- optional delivery-scoped id, merged into reference.correlation_id on the grant
    # (and any EC:B17 offset) entries this call writes.
    correlation_id: str | None = None


async def _do_topup(input: TopupInput) -> GrantResult:
    idempotency_key = f"topup:{input.payment.id}"
    days = input.policy.credits.topup_expiry_days
    expires_at = None if days is None else input.clock.now() + timedelta(days=days)
    unit_price_minor, remainder_minor = _price_credits(
        input.payment.amount.amount_minor, input.credits
    )
    reference = LedgerReference(
        payment_id=input.payment.id, correlation_id=input.correlation_id
    )

    # EC:B17 — see the identical comment in grant_for_period: must read before the grant lands.
    pre_grant_available = (
        (
            await input.ledger.balance(input.customer_id, "paid", input.clock.now())
        ).available
        if input.policy.credits.negative_offset == "offset_next_grant"
        else 0
    )

    result = await _write_grant(
        input.ledger,
        NewLedgerEntry(
            customer_id=input.customer_id,
            pool="paid",
            kind="grant",
            amount=input.credits,
            unit_price_minor=unit_price_minor,
            currency=input.payment.amount.currency,
            expires_at=expires_at,
            source="topup",
            reference=reference,
            idempotency_key=idempotency_key,
            actor="system",
            reason=f"remainder_minor:{remainder_minor}"
            if remainder_minor > 0
            else None,
        ),
    )

    # EC:B17
    if result.entry is None or result.duplicated:
        return result
    offset, entries = await _apply_negative_offset(
        ledger=input.ledger,
        policy=input.policy,
        pre_grant_available=pre_grant_available,
        customer_id=input.customer_id,
        pool="paid",
        grant=result.entry,
        source="topup",
        reference=reference,
        grant_idempotency_key=idempotency_key,
    )
    return dataclasses.replace(result, offset=offset, offset_entries=entries)


def _serialize_grant_result(r: GrantResult) -> dict:
    return {
        "entry": serialize_ledger_entry(r.entry),
        "duplicated": r.duplicated,
        "deferred": r.deferred,
        "offset": r.offset,
        "offset_entries": [serialize_ledger_entry(e) for e in r.offset_entries],
    }


def _deserialize_grant_result(v: dict) -> GrantResult:
    return GrantResult(
        entry=deserialize_ledger_entry(v["entry"]),
        duplicated=v["duplicated"],
        deferred=v["deferred"],
        offset=v.get("offset", 0),
        offset_entries=[
            deserialize_ledger_entry(e) for e in v.get("offset_entries", [])
        ],
    )


# EC:B10 — one-time top-up. EC:J1-J5 — same operation retried after partial failure replays the
# first GrantResult.
async def topup(input: TopupInput) -> GrantResult:
    if input.repo is None:
        return await _do_topup(input)

    key = input.idempotency_key or f"topup:{input.payment.id}"
    result = await run_idempotent(
        repo=input.repo,
        clock=input.clock,
        key=key,
        kind="credits.topup",
        payload={
            "customer_id": input.customer_id,
            "payment_id": input.payment.id,
            "credits": input.credits,
            "amount_minor": input.payment.amount.amount_minor,
            "currency": input.payment.amount.currency,
        },
        serialize=_serialize_grant_result,
        deserialize=_deserialize_grant_result,
        fn=lambda: _do_topup(input),
    )
    return result.result


def default_expiry(policy: Policy, source: str, now: datetime) -> datetime | None:
    """EC:B19 -- default expiry for a grant source from policy.credits.expiry_days. None = never.

    Used only when the caller passes `policy` and no expires_at; without `policy` nothing changes.
    """
    days = getattr(policy.credits.expiry_days, source)
    return None if days is None else now + timedelta(days=days)


@dataclass(kw_only=True, slots=True)
class GrantPoolInput:
    customer_id: str
    amount: int
    ledger: LedgerStore
    clock: Clock
    idempotency_key: str
    expires_at: datetime | None = None
    reason: str | None = None
    actor: str = "system"
    reference: LedgerReference = field(default_factory=LedgerReference)
    # EC:B19 -- pass to apply policy.credits.expiry_days when expires_at is not given.
    policy: Policy | None = None


async def _grant_pool(
    pool: Pool, source: LedgerSource, input: GrantPoolInput
) -> GrantResult:
    return await _write_grant(
        input.ledger,
        NewLedgerEntry(
            customer_id=input.customer_id,
            pool=pool,
            kind="grant",
            amount=input.amount,
            unit_price_minor=None,
            currency=None,
            expires_at=input.expires_at
            if input.expires_at is not None
            else (default_expiry(input.policy, source, input.clock.now()) if input.policy else None),
            source=source,
            reference=input.reference,
            idempotency_key=input.idempotency_key,
            actor=input.actor,
            reason=input.reason,
        ),
    )


# grantPromo / grantTrial — automated promo/trial grants (distinct from EC:B9 manual adjustments)
async def grant_promo(input: GrantPoolInput) -> GrantResult:
    return await _grant_pool("promo", "promo", input)


async def grant_trial(input: GrantPoolInput) -> GrantResult:
    return await _grant_pool("trial", "trial", input)


@dataclass(kw_only=True, slots=True)
class ManualAdjustInput:
    customer_id: str
    pool: Pool
    amount: int  # positive magnitude
    reason: str
    actor: str
    ledger: LedgerStore
    clock: Clock
    idempotency_key: str
    expires_at: datetime | None = None
    reference: LedgerReference = field(default_factory=LedgerReference)
    # EC:B19 -- pass to apply policy.credits.expiry_days.manual when expires_at is not given (grants only).
    policy: Policy | None = None


def _require_reason_and_actor(reason: str, actor: str) -> None:
    if not reason:
        raise PaymentKitError(
            "manual credit adjustment requires reason", "manual_adjust_invalid"
        )
    if not actor:
        raise PaymentKitError(
            "manual credit adjustment requires actor", "manual_adjust_invalid"
        )


# EC:B9 — manual admin grant/revoke. reason + actor mandatory, source is always 'manual'.
async def manual_grant(input: ManualAdjustInput) -> GrantResult:
    _require_reason_and_actor(input.reason, input.actor)
    return await _write_grant(
        input.ledger,
        NewLedgerEntry(
            customer_id=input.customer_id,
            pool=input.pool,
            kind="grant",
            amount=abs(input.amount),
            unit_price_minor=None,
            currency=None,
            expires_at=input.expires_at
            if input.expires_at is not None
            else (default_expiry(input.policy, "manual", input.clock.now()) if input.policy else None),
            source="manual",
            reference=input.reference,
            idempotency_key=input.idempotency_key,
            actor=input.actor,
            reason=input.reason,
        ),
    )


async def manual_revoke(input: ManualAdjustInput) -> GrantResult:
    _require_reason_and_actor(input.reason, input.actor)
    return await _write_grant(
        input.ledger,
        NewLedgerEntry(
            customer_id=input.customer_id,
            pool=input.pool,
            kind="revoke",
            amount=-abs(input.amount),
            unit_price_minor=None,
            currency=None,
            expires_at=None,
            source="manual",
            reference=input.reference,
            idempotency_key=input.idempotency_key,
            actor=input.actor,
            reason=input.reason,
        ),
    )
