"""spec/cs.pseudo.md — EC:I9

Read-side reconstruction of "what happened to this payment / where are my credits" for CS.
Reconstructs entirely from `boilpayment_core` doubles' `Repo`/`LedgerStore` interfaces
(payments, ledger_entries, webhook_events, refunds, cs_cases, operations, notifications) -- no new
storage, no dependency on the audit-log layer another agent is building concurrently.
Mirrors packages/cs/ts/src/timeline.ts exactly.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal

from boilpayment_core import (
    Clock,
    CsCase,
    CsCaseStatus,
    LedgerEntry,
    LedgerKind,
    LedgerStore,
    Money,
    Payment,
    PaymentStatus,
    Refund,
    Repo,
    WebhookEventRecord,
    WebhookEventStatus,
    currency_exponent,
    effective_grant_expiry,
)

# ── Public types ─────────────────────────────────────────────────────────────────────────

TimelineEventKind = Literal[
    "payment.created",
    "payment.succeeded",
    "payment.failed",
    "payment.refunded",
    "payment.disputed",
    "credits.granted",
    "credits.consumed",
    "credits.revoked",
    "credits.expired",
    "credits.held",
    "credits.released",
    "credits.adjusted",
    "webhook.received",
    "webhook.processed",
    "webhook.failed",
    "refund.requested",
    "refund.succeeded",
    "refund.failed",
    "case.opened",
    "case.escalated",
    "case.resolved",
    "case.rejected",
    "operation.replayed",
    "notification.sent",
]

TimelineEventSource = Literal[
    "payments",
    "ledger_entries",
    "webhook_events",
    "refunds",
    "cs_cases",
    "operations",
    "notifications",
]


@dataclass(kw_only=True, slots=True)
class TimelineRefs:
    payment_id: str | None = None
    subscription_id: str | None = None
    case_id: str | None = None
    refund_id: str | None = None
    grant_id: str | None = None
    event_id: str | None = None
    # EC:L5 -- the webhook-delivery-scoped id carried on the underlying ledger row, when it has one.
    correlation_id: str | None = None


@dataclass(kw_only=True, slots=True)
class TimelineEvent:
    at: datetime
    kind: TimelineEventKind
    source: TimelineEventSource
    # One short human-readable line, no PII, safe to show in a CS console.
    summary: str
    refs: TimelineRefs
    detail: dict[str, Any] = field(default_factory=dict)


@dataclass(kw_only=True, slots=True)
class TimelineOptions:
    repo: Repo
    ledger: LedgerStore
    clock: Clock
    customer_id: str | None = None
    payment_id: str | None = None
    subscription_id: str | None = None
    # EC:L5 -- "show me everything that happened in this one webhook delivery." Only the
    # ledger_entries source carries correlation_id today (see refs.correlation_id), so this
    # filters that source; it has no effect on payments/webhook_events/refunds/cs_cases/
    # operations rows, which don't carry a correlation_id of their own.
    correlation_id: str | None = None
    since: datetime | None = None
    until: datetime | None = None
    # Default 500. When exceeded, the OLDEST events are dropped (kept: the newest `limit`).
    limit: int | None = None


@dataclass(kw_only=True, slots=True)
class TimelineResult:
    events: list[TimelineEvent]
    truncated: bool


_DEFAULT_LIMIT = 500

# ── Money formatting (currency-aware minor-unit convention -- boilpayment_core.money) ────

_CURRENCY_SYMBOLS: dict[str, str] = {
    "USD": "$",
    "KRW": "₩",
    "JPY": "¥",
    "EUR": "€",
    "GBP": "£",
}


def _format_money(m: Money) -> str:
    exp = currency_exponent(m.currency)  # EC:J6 -- ISO 4217 minor units (0, 2 or 3)
    amount = m.amount_minor / 10**exp
    formatted = f"{amount:,.{exp}f}"
    symbol = _CURRENCY_SYMBOLS.get(m.currency)
    return f"{symbol}{formatted}" if symbol else f"{formatted} {m.currency}"


# ── Ledger kind -> timeline vocabulary ──────────────────────────────────────────────────────

_LEDGER_VERB: dict[LedgerKind, str] = {
    "grant": "granted",
    "consume": "consumed",
    "revoke": "revoked",
    "expire": "expired",
    "hold": "held",
    "release": "released",
    "adjust": "adjusted",
}
_LEDGER_EVENT_KIND: dict[LedgerKind, TimelineEventKind] = {
    "grant": "credits.granted",
    "consume": "credits.consumed",
    "revoke": "credits.revoked",
    "expire": "credits.expired",
    "hold": "credits.held",
    "release": "credits.released",
    "adjust": "credits.adjusted",
}

_PAYMENT_EVENT_KIND: dict[PaymentStatus, TimelineEventKind] = {
    "pending": "payment.created",
    "requires_action": "payment.created",
    "succeeded": "payment.succeeded",
    "failed": "payment.failed",
    "refunded": "payment.refunded",
    "partially_refunded": "payment.refunded",
    "disputed": "payment.disputed",
}

_WEBHOOK_EVENT_KIND: dict[WebhookEventStatus, TimelineEventKind] = {
    "received": "webhook.received",
    "processed": "webhook.processed",
    "failed": "webhook.failed",
}


# ── Fetch helpers -- degrade to [] on any duck-typing mismatch, never throw ─────────────────


async def _safe_list(fn: Callable[[], Awaitable[list[Any]]]) -> list[Any]:
    try:
        return await fn()
    except Exception:  # noqa: BLE001 - Arbitrary repository callbacks must degrade to an empty list.
        return []


async def _fetch_payments(repo: Repo, opts: TimelineOptions) -> list[Payment]:
    filter_: dict[str, Any] = {}
    if opts.customer_id:
        filter_["customer_id"] = opts.customer_id
    if opts.payment_id:
        filter_["id"] = opts.payment_id
    if opts.subscription_id:
        filter_["subscription_id"] = opts.subscription_id
    if not filter_:
        return []
    return await _safe_list(lambda: repo.payments.list(**filter_))


async def _resolve_customer_ids(
    repo: Repo, opts: TimelineOptions, payments: list[Payment]
) -> set[str]:
    ids: set[str] = set()
    if opts.customer_id:
        ids.add(opts.customer_id)
    for p in payments:
        ids.add(p.customer_id)
    if opts.subscription_id:
        subs = await _safe_list(
            lambda: repo.subscriptions.list(id=opts.subscription_id)
        )
        for s in subs:
            ids.add(s.customer_id)
    return ids


async def _fetch_scoped(
    by_id: Callable[[], Awaitable[list[Any]]] | None,
    by_customer: Callable[[str], Awaitable[list[Any]]],
    glob: Callable[[], Awaitable[list[Any]]],
    customer_ids: set[str],
) -> list[Any]:
    """Fetch rows scoped by an exact id (payment_id), else by each known customer_id, else globally."""
    if by_id is not None:
        return await _safe_list(by_id)
    if customer_ids:
        out: list[Any] = []
        for cid in customer_ids:
            out.extend(await _safe_list(lambda cid=cid: by_customer(cid)))
        return out
    return await _safe_list(glob)


# ── Running balance (EC:B14-style: bucket-scoped expiry, evaluated at each entry's own time) ──


@dataclass(slots=True)
class _BucketState:
    grant: LedgerEntry
    remaining: int


def _running_balances(entries: list[LedgerEntry]) -> list[int]:
    """Mirrors InMemoryLedger's _build_buckets + _unbucketed_total + expiry rule from balance(),
    computed INCREMENTALLY over `entries` (already in append/chronological order) instead of
    calling `ledger.balance()` per entry -- balance() has no creation-time cutoff (only an expiry
    cutoff), so calling it with an entry's own time as `now` would still include every later entry
    already sitting in the store. Returns one running total per input entry, in the same order."""
    buckets: dict[str, _BucketState] = {}
    unbucketed = 0
    out: list[int] = []
    for index, e in enumerate(entries):
        if e.kind == "grant":
            buckets[e.id] = _BucketState(grant=e, remaining=e.amount)
        else:
            gid = e.reference.grant_id
            bucket = buckets.get(gid) if gid else None
            if bucket is not None:
                bucket.remaining += e.amount
            else:
                unbucketed += e.amount
        now = e.created_at
        total = unbucketed
        for b in buckets.values():
            expires_at = effective_grant_expiry(b.grant, entries[: index + 1])
            if expires_at is not None and expires_at <= now:  # EC:B14 SB-07
                continue
            total += b.remaining
        out.append(total)
    return out


# ── Fold ─────────────────────────────────────────────────────────────────────────────────


def _in_window(at: datetime, since: datetime | None, until: datetime | None) -> bool:
    if since is not None and at < since:
        return False
    return not (until is not None and at > until)


# EC:I9 -- two events can share one instant (a case is opened and its credits revoked inside the
# same call, under a clock with millisecond resolution). Sorting on time alone leaves their order to
# whichever source was folded first, so the same query could read differently twice. Break ties by
# cause-before-effect so the story always reads the way it happened. Mirrors ts KIND_RANK.
_KIND_RANK: dict[str, int] = {
    "payment.created": 1,
    "payment.succeeded": 1,
    "payment.failed": 1,
    "payment.refunded": 1,
    "payment.disputed": 1,
    "webhook.received": 2,
    "webhook.processed": 2,
    "webhook.failed": 2,
    "case.opened": 3,
    "case.escalated": 4,
    "credits.granted": 5,
    "credits.consumed": 5,
    "credits.revoked": 5,
    "credits.expired": 5,
    "credits.held": 5,
    "credits.released": 5,
    "credits.adjusted": 5,
    "refund.requested": 6,
    "refund.succeeded": 6,
    "refund.failed": 6,
    "case.resolved": 7,
    "case.rejected": 7,
    "operation.replayed": 8,
    "notification.sent": 9,
}


async def timeline(opts: TimelineOptions) -> TimelineResult:
    """cs.timeline({customer_id?, payment_id?, subscription_id?, since?, until?, repo, ledger,
    clock}) -> {events, truncated} -- folds payments/ledger_entries/webhook_events/refunds/
    cs_cases/operations (+ notifications if duck-typed) into one time-ordered evidence trail.
    Never raises on a missing/duck-typed table; degrades to fewer event kinds instead (EC:I9)."""
    repo = opts.repo
    ledger = opts.ledger
    since = opts.since
    # NOT defaulted to clock.now(): InMemoryLedger.append() stamps created_at with the real wall
    # clock (ignores the injected Clock -- see final report), so a FixedClock set to a past test
    # date would silently filter out every real-time-stamped ledger entry. Leave `until` unbounded
    # unless the caller asks for a cutoff explicitly.
    until = opts.until
    events: list[TimelineEvent] = []

    scoped = bool(opts.customer_id or opts.payment_id or opts.subscription_id)

    # ── payments ──────────────────────────────────────────────────────────────────────────
    payments = await _fetch_payments(repo, opts)
    for p in payments:
        if not _in_window(p.occurred_at, since, until):
            continue
        kind = _PAYMENT_EVENT_KIND[p.status]
        amount_str = _format_money(p.amount)
        summary = f"payment {p.id} {p.status} ({amount_str})"
        if p.status == "failed" and p.failure:
            summary = (
                f"payment {p.id} failed: {p.failure.user_message} ({p.failure.code})"
            )
        events.append(
            TimelineEvent(
                at=p.occurred_at,
                kind=kind,
                source="payments",
                summary=summary,
                refs=TimelineRefs(payment_id=p.id, subscription_id=p.subscription_id),
                detail={
                    "status": p.status,
                    "amount": p.amount,
                    "kind": p.kind,
                    "provider": p.provider,
                    "failure_code": p.failure.code if p.failure else None,
                    "failure_user_message": p.failure.user_message
                    if p.failure
                    else None,
                },
            )
        )

    # ── customer resolution (needed for ledger_entries / cs_cases which are customer-scoped) ──
    customer_ids = await _resolve_customer_ids(repo, opts, payments)

    # ── ledger_entries ────────────────────────────────────────────────────────────────────
    iter_customer_ids = (
        customer_ids
        if customer_ids
        else ({opts.customer_id} if opts.customer_id else set())
    )
    for cid in iter_customer_ids:
        all_entries = await _safe_list(lambda cid=cid: ledger.entries(cid))
        balances = _running_balances(all_entries)
        for i, e in enumerate(all_entries):
            if opts.payment_id and e.reference.payment_id != opts.payment_id:
                continue
            if (
                opts.subscription_id
                and e.reference.subscription_id != opts.subscription_id
            ):
                continue
            # EC:L5 -- "show me everything that happened in this one delivery": narrows within
            # whatever customer/payment/subscription scope was already resolved above.
            if (
                opts.correlation_id
                and e.reference.correlation_id != opts.correlation_id
            ):
                continue
            if not _in_window(e.created_at, since, until):
                continue
            verb = _LEDGER_VERB[e.kind]
            amount = abs(e.amount)
            events.append(
                TimelineEvent(
                    at=e.created_at,
                    kind=_LEDGER_EVENT_KIND[e.kind],
                    source="ledger_entries",
                    summary=f"{amount} credits {verb} ({e.pool} pool, source: {e.source})",
                    refs=TimelineRefs(
                        payment_id=e.reference.payment_id,
                        subscription_id=e.reference.subscription_id,
                        case_id=e.reference.case_id,
                        refund_id=e.reference.refund_id,
                        grant_id=e.id if e.kind == "grant" else e.reference.grant_id,
                        correlation_id=e.reference.correlation_id,
                    ),
                    detail={
                        "amount": e.amount,
                        "pool": e.pool,
                        "source": e.source,
                        "balance_after": balances[i],
                        "unit_price_minor": e.unit_price_minor,
                        "currency": e.currency,
                        "reason": e.reason,
                    },
                )
            )

    # ── webhook_events ────────────────────────────────────────────────────────────────────
    # EC:I9 finding -- WebhookEventRecord has no customer_id/payment_id/subscription_id column, so
    # a SCOPED query (any id filter given) cannot be correlated to it without a fragile raw_body
    # text heuristic; we degrade to including webhook rows only for a fully unscoped (global) query.
    if not scoped:
        webhook_rows: list[WebhookEventRecord] = await _safe_list(
            lambda: repo.webhook_events.list()
        )
        for w in webhook_rows:
            kind = _WEBHOOK_EVENT_KIND.get(w.status)
            if kind is None:
                continue  # 'processing' | 'ignored' -- not part of the vocabulary
            at = (
                w.received_at
                if w.status == "received"
                else (w.processed_at or w.received_at)
            )
            if not _in_window(at, since, until):
                continue
            summary = f"webhook {w.provider} {w.type} {w.status}"
            if w.status == "failed" and w.error:
                summary = f"webhook {w.provider} {w.type} failed: {w.error}"
            events.append(
                TimelineEvent(
                    at=at,
                    kind=kind,
                    source="webhook_events",
                    summary=summary,
                    refs=TimelineRefs(event_id=w.id),
                    detail={
                        "provider": w.provider,
                        "type": w.type,
                        "status": w.status,
                        "error": w.error,
                        "attempts": w.attempts,
                    },
                )
            )

    # ── refunds ───────────────────────────────────────────────────────────────────────────
    refund_rows: list[Refund] = await _fetch_scoped(
        (lambda: repo.refunds.list(payment_id=opts.payment_id))
        if opts.payment_id
        else None,
        lambda cid: repo.refunds.list(customer_id=cid),
        lambda: repo.refunds.list(),
        customer_ids,
    )
    for r in refund_rows:
        if not _in_window(r.created_at, since, until):
            continue
        kind = (
            "refund.requested"
            if r.status == "pending"
            else ("refund.succeeded" if r.status == "succeeded" else "refund.failed")
        )
        summary = f"refund {r.id} for {_format_money(r.amount)} ({r.rule_id})"
        if r.status == "succeeded" and r.credits_revoked > 0:
            summary += f", {r.credits_revoked} credits revoked"
        if r.status == "failed" and r.failure:
            summary += f" -- failed: {r.failure.user_message}"
        events.append(
            TimelineEvent(
                at=r.created_at,
                kind=kind,
                source="refunds",
                summary=summary,
                refs=TimelineRefs(payment_id=r.payment_id, refund_id=r.id),
                detail={
                    "amount": r.amount,
                    "status": r.status,
                    "rule_id": r.rule_id,
                    "credits_revoked": r.credits_revoked,
                    "reason": r.reason,
                },
            )
        )

    # ── cs_cases ──────────────────────────────────────────────────────────────────────────
    case_rows: list[CsCase] = await _fetch_scoped(
        (lambda: repo.cs_cases.list(reference_id=opts.payment_id))
        if opts.payment_id
        else None,
        lambda cid: repo.cs_cases.list(customer_id=cid),
        lambda: repo.cs_cases.list(),
        customer_ids,
    )
    human_statuses: tuple[CsCaseStatus, ...] = ("needs_human", "resolved_human")
    for c in case_rows:
        if _in_window(c.opened_at, since, until):
            events.append(
                TimelineEvent(
                    at=c.opened_at,
                    kind="case.opened",
                    source="cs_cases",
                    summary=f"case {c.id} opened ({c.kind})",
                    refs=TimelineRefs(case_id=c.id),
                    detail={
                        "kind": c.kind,
                        "reference_id": c.reference_id,
                        "status": c.status,
                    },
                )
            )
            # EC:I9 finding -- CsCase has no escalated_at; approximated at opened_at (see detail.approximate).
            if c.status in human_statuses:
                events.append(
                    TimelineEvent(
                        at=c.opened_at,
                        kind="case.escalated",
                        source="cs_cases",
                        summary=f"case {c.id} escalated to a human",
                        refs=TimelineRefs(case_id=c.id),
                        detail={"kind": c.kind, "approximate": True},
                    )
                )
        if c.resolved_at is not None and _in_window(c.resolved_at, since, until):
            if c.status == "rejected":
                events.append(
                    TimelineEvent(
                        at=c.resolved_at,
                        kind="case.rejected",
                        source="cs_cases",
                        summary=f"case {c.id} rejected",
                        refs=TimelineRefs(case_id=c.id),
                        detail={"kind": c.kind, "decision": c.decision},
                    )
                )
            elif c.status in ("resolved_auto", "resolved_human"):
                by = "auto" if c.status == "resolved_auto" else "human"
                events.append(
                    TimelineEvent(
                        at=c.resolved_at,
                        kind="case.resolved",
                        source="cs_cases",
                        summary=f"case {c.id} resolved ({by})",
                        refs=TimelineRefs(case_id=c.id),
                        detail={"kind": c.kind, "by": by, "decision": c.decision},
                    )
                )

    # ── operations ────────────────────────────────────────────────────────────────────────
    # EC:I9 finding -- Operation has no attempts/replay counter (unlike WebhookEventRecord.attempts):
    # run_idempotent's replay branch returns the cached result WITHOUT touching the row, so a row
    # replayed 5 times is byte-identical to one run once. We surface every completed idempotency-
    # guarded operation correlated to the query (by id substring match on `key`, per the EC:J5 key
    # convention) as `operation.replayed` -- it proves "repeat submissions were safely deduped",
    # which is the CS-relevant fact, even though the true replay COUNT is not reconstructable.
    relevant_ids: set[str] = set()
    if opts.payment_id:
        relevant_ids.add(opts.payment_id)
    if opts.subscription_id:
        relevant_ids.add(opts.subscription_id)
    for p in payments:
        relevant_ids.add(p.id)
    for c in case_rows:
        relevant_ids.add(c.id)
    ops = await _safe_list(lambda: repo.operations.list())
    for op in ops:
        if op.status != "done":
            continue
        matches = (not scoped) or any(rid in op.key for rid in relevant_ids)
        if not matches:
            continue
        at = op.completed_at if op.completed_at is not None else op.created_at
        if not _in_window(at, since, until):
            continue
        events.append(
            TimelineEvent(
                at=at,
                kind="operation.replayed",
                source="operations",
                summary=f"operation {op.kind} completed (idempotency-guarded -- repeat submissions replay this result)",
                refs=TimelineRefs(event_id=op.key),
                detail={"key": op.key, "kind": op.kind},
            )
        )

    # ── notifications (only if the concrete Repo duck-types a table for them) ───────────────
    notifications_table = getattr(repo, "notifications", None)
    if notifications_table is not None and hasattr(notifications_table, "list"):
        rows = await _safe_list(lambda: notifications_table.list())
        for n in rows:
            at = (
                getattr(n, "at", None)
                or getattr(n, "sent_at", None)
                or getattr(n, "created_at", None)
            )
            if at is None or not _in_window(at, since, until):
                continue
            if opts.customer_id and getattr(n, "customer_id", None) != opts.customer_id:
                continue
            ntype = getattr(n, "type", "unknown")
            events.append(
                TimelineEvent(
                    at=at,
                    kind="notification.sent",
                    source="notifications",
                    summary=f"notification {ntype} sent",
                    refs=TimelineRefs(),
                    detail=n if isinstance(n, dict) else vars(n),
                )
            )

    # list.sort is stable, so equal (at, rank) keeps the fold order -- deterministic.
    events.sort(key=lambda e: (e.at, _KIND_RANK.get(e.kind, 99)))

    limit = opts.limit if opts.limit is not None else _DEFAULT_LIMIT
    truncated = len(events) > limit
    kept = events[len(events) - limit :] if truncated else events
    return TimelineResult(events=kept, truncated=truncated)


# ── explain ──────────────────────────────────────────────────────────────────────────────


def explain(events: list[TimelineEvent]) -> list[str]:
    """A compact narrative a support agent (or the chat widget) can read out, one line per event."""
    lines: list[str] = []
    last_balance: int | None = None
    for e in events:
        if e.kind in (
            "payment.created",
            "payment.succeeded",
            "payment.failed",
            "payment.refunded",
            "payment.disputed",
        ):
            amount = e.detail.get("amount")
            status = str(e.detail.get("status", ""))
            if amount is not None:
                lines.append(
                    f"payment {e.refs.payment_id or ''} {status} ({_format_money(amount)})"
                )
            else:
                lines.append(f"payment {e.refs.payment_id or ''} {status}")
        elif e.kind in (
            "credits.granted",
            "credits.consumed",
            "credits.revoked",
            "credits.expired",
            "credits.held",
            "credits.released",
            "credits.adjusted",
        ):
            amount = abs(e.detail.get("amount", 0))
            verb = e.kind.split(".")[1]
            lines.append(f"{amount} credits {verb}")
            last_balance = e.detail.get("balance_after")
        elif e.kind in ("refund.requested", "refund.succeeded", "refund.failed"):
            amount = e.detail.get("amount")
            revoked = e.detail.get("credits_revoked", 0)
            rule_id = str(e.detail.get("rule_id", ""))
            line = f"refund {e.refs.refund_id or ''} for {_format_money(amount)} ({rule_id})"
            if e.kind == "refund.succeeded" and revoked > 0:
                line += f", {revoked} credits revoked"
            if e.kind == "refund.failed":
                line += " -- failed"
            lines.append(line)
        elif e.kind in ("webhook.received", "webhook.processed", "webhook.failed"):
            lines.append(e.summary)
        elif e.kind == "case.opened":
            lines.append(f"case {e.refs.case_id or ''} opened")
        elif e.kind == "case.escalated":
            lines.append(f"case {e.refs.case_id or ''} escalated")
        elif e.kind == "case.resolved":
            lines.append(f"case {e.refs.case_id or ''} resolved")
        elif e.kind == "case.rejected":
            lines.append(f"case {e.refs.case_id or ''} rejected")
        elif e.kind == "operation.replayed":
            lines.append(f"operation {e.detail.get('kind', '')} replay-safe")
        elif e.kind == "notification.sent":
            lines.append(e.summary)
        else:
            lines.append(e.summary)
    if last_balance is not None:
        lines.append(f"balance now {last_balance}")
    return lines
