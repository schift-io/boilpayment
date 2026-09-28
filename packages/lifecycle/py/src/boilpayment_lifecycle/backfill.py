"""spec: packages/lifecycle/spec/lifecycle.pseudo.md -- EC:M1 EC:M2 EC:M3 EC:M4

Brings customers who were already paying before the kit was installed into the kit's tables, so
the next renewal webhook / scheduler tick finds a local subscription instead of
`unknown_provider_ref`. Input is a file the developer exports from their old system; the
provider stays the source of truth for anything it knows (status, period, owner).
Mirrors packages/lifecycle/ts/src/backfill.ts.
"""

from __future__ import annotations

import csv
import io
import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

from boilpayment_core import (
    Clock,
    Customer,
    IdGen,
    LedgerReference,
    LedgerStore,
    NewLedgerEntry,
    PaymentProvider,
    Period,
    ProviderRef,
    Repo,
    Subscription,
    civil_day_of,
)

PROVIDERS = ("stripe", "toss", "portone", "polar")
LIVE_STATUSES = {"trialing", "active", "past_due"}

BACKFILL_COLUMNS = (
    "customer_id",
    "email",
    "provider",
    "customer_ref",
    "subscription_ref",
    "plan_id",
    "billing_key",
    "period_start",
    "period_end",
    "credits",
    "credits_expire_at",
)

BackfillOutcome = Literal["created", "updated", "skipped", "none"]


@dataclass(kw_only=True, slots=True)
class BackfillRow:
    customer_id: str
    provider: str
    # The customer's id at the provider (Stripe cus_..., Polar customer id, Toss/PortOne customer key).
    customer_ref: str
    email: str | None = None
    # Native providers (Stripe, Polar): the provider subscription id.
    subscription_ref: str | None = None
    plan_id: str | None = None
    # Self-scheduled providers (Toss, PortOne): billing key plus the period already paid for.
    billing_key: str | None = None
    period_start: datetime | None = None
    period_end: datetime | None = None
    # EC:A28 -- the currency the customer pays in; needed for plans priced in several currencies.
    currency: str | None = None
    # Credit balance carried over from the old system (paid pool).
    credits: int | None = None
    credits_expire_at: datetime | None = None


@dataclass(kw_only=True, slots=True)
class BackfillInput:
    rows: list[BackfillRow]
    repo: Repo
    ledger: LedgerStore
    providers: dict[str, PaymentProvider]
    clock: Clock
    ids: IdGen
    # EC:A81 -- policy timezone (policy.period.timezone); the anchor day is the period start's civil day there.
    timezone: str = "UTC"


@dataclass(kw_only=True, slots=True)
class BackfillRowResult:
    row: int  # 1-based position in the input
    customer_id: str
    status: Literal["ok", "error"] = "ok"
    reason: str | None = None  # error code; nothing was written for that row
    customer: BackfillOutcome = "none"
    subscription: BackfillOutcome = "none"
    credits: BackfillOutcome = "none"
    subscription_id: str | None = None


@dataclass(kw_only=True, slots=True)
class BackfillReport:
    results: list[BackfillRowResult] = field(default_factory=list)
    ok: int = 0
    errors: int = 0


class _RowError(Exception):
    pass


def _fail(reason: str) -> Any:
    raise _RowError(reason)


@dataclass(kw_only=True, slots=True)
class _RowPlan:
    subscription: dict[str, Any] | None = None
    existing_subscription_id: str | None = None


async def _plan_row(input: BackfillInput, row: BackfillRow) -> _RowPlan:
    # EC:M2 EC:M3 -- everything that can refuse a row happens here, before any write.
    if not row.customer_id:
        _fail("missing_customer_id")
    if row.provider not in PROVIDERS:
        _fail("unknown_provider")
    provider = input.providers.get(row.provider)
    if provider is None:
        _fail("provider_not_configured")
    if not row.customer_ref:
        _fail("missing_customer_ref")
    if row.credits is not None and (
        not isinstance(row.credits, int)
        or isinstance(row.credits, bool)
        or row.credits < 0
    ):
        _fail("invalid_credits")
    if row.plan_id and await input.repo.plans.get(row.plan_id) is None:
        _fail("unknown_plan")

    native = provider.capabilities().native_subscriptions
    if row.subscription_ref and row.billing_key:
        _fail("subscription_ref_and_billing_key")
    if not row.subscription_ref and not row.billing_key:
        return _RowPlan()
    if not row.plan_id:
        _fail("missing_plan_id")

    if row.subscription_ref:
        if not native:
            _fail("provider_has_no_native_subscriptions")
        local = await input.repo.subscriptions.list(
            provider=row.provider, provider_ref=row.subscription_ref
        )
        if local:
            if local[0].customer_id != row.customer_id:
                _fail("subscription_owned_by_other_customer")
            return _RowPlan(existing_subscription_id=local[0].id)
        # EC:M3 -- the provider decides status, period and owner; the file only names the subscription.
        remote = await provider.get_subscription(row.subscription_ref)
        if remote.customer_id not in (row.customer_ref, row.customer_id):
            _fail("provider_customer_mismatch")
        if remote.status not in LIVE_STATUSES:
            _fail("subscription_not_live")
        return _RowPlan(
            subscription={
                "customer_id": row.customer_id,
                "plan_id": row.plan_id,
                "provider": row.provider,
                "provider_ref": row.subscription_ref,
                "status": remote.status,
                "current_period": remote.current_period,
                "anchor_day": remote.anchor_day,
                "cancel_at_period_end": remote.cancel_at_period_end,
                "grace_until": None,
                "billing_key": None,
                "scheduled_plan_id": None,
                # EC:A28
                "currency": remote.currency or await _single_price_currency(input, row.plan_id),
            }
        )

    if native:
        _fail("billing_key_needs_self_scheduled_provider")
    if (
        row.period_start is None
        or row.period_end is None
        or not row.period_start < row.period_end
    ):
        _fail("invalid_period")
    assert row.period_start is not None and row.period_end is not None
    # EC:A64 -- a billing key charges the card it was issued for: one already on another customer's
    # subscription is refused (a copy-paste in the file would renew this customer on that card).
    holders = [
        s for s in await input.repo.subscriptions.list(provider=row.provider)
        if s.billing_key == row.billing_key and s.customer_id != row.customer_id
    ]
    if holders:
        _fail("billing_key_owned_by_other_customer")
    mine = await input.repo.subscriptions.list(
        customer_id=row.customer_id, provider=row.provider
    )
    same = next((s for s in mine if s.billing_key == row.billing_key), None)
    if same is not None:
        return _RowPlan(existing_subscription_id=same.id)
    return _RowPlan(
        subscription={
            "customer_id": row.customer_id,
            "plan_id": row.plan_id,
            "provider": row.provider,
            "provider_ref": None,
            "status": "active",
            "current_period": Period(start=row.period_start, end=row.period_end),
            "anchor_day": civil_day_of(row.period_start, input.timezone),  # EC:A81
            "cancel_at_period_end": False,
            "grace_until": None,
            "billing_key": row.billing_key,
            "billing_customer_ref": row.customer_ref,  # EC:A60 -- the key was issued under this customer key
            "scheduled_plan_id": None,
            # EC:A28
            "currency": row.currency or await _single_price_currency(input, row.plan_id),
        }
    )


async def _upsert_customer(input: BackfillInput, row: BackfillRow) -> BackfillOutcome:
    existing = await input.repo.customers.get(row.customer_id)
    ref = ProviderRef(provider=row.provider, ref=row.customer_ref)  # type: ignore[arg-type]
    if existing is None:
        await input.repo.customers.put(
            Customer(
                id=row.customer_id,
                email=row.email,
                provider_refs=[ref],
                status="active",
                created_at=input.clock.now(),
            )
        )
        return "created"
    if any(
        r.provider == row.provider and r.ref == row.customer_ref
        for r in existing.provider_refs
    ):
        return "skipped"
    existing.provider_refs = [*existing.provider_refs, ref]
    await input.repo.customers.put(existing)
    return "updated"


async def backfill(input: BackfillInput) -> BackfillReport:
    """EC:M1-M4 -- import existing paying customers. Idempotent: a re-run writes nothing new."""
    report = BackfillReport()
    for i, row in enumerate(input.rows):
        result = BackfillRowResult(row=i + 1, customer_id=row.customer_id)
        try:
            plan = await _plan_row(input, row)
            result.customer = await _upsert_customer(input, row)
            if plan.existing_subscription_id is not None:
                result.subscription = "skipped"
                result.subscription_id = plan.existing_subscription_id
            elif plan.subscription is not None:
                sub = Subscription(
                    id=input.ids.new_id(),
                    version=0,
                    created_at=input.clock.now(),
                    **plan.subscription,
                )
                await input.repo.subscriptions.put(sub)
                result.subscription = "created"
                result.subscription_id = sub.id
            # EC:M4 -- one grant per customer and pool; the idempotency key makes a re-run a no-op.
            if row.credits:
                appended = await input.ledger.append(
                    NewLedgerEntry(
                        customer_id=row.customer_id,
                        pool="paid",
                        kind="grant",
                        amount=row.credits,
                        expires_at=row.credits_expire_at,
                        source="manual",
                        reference=LedgerReference(),
                        idempotency_key=f"backfill:{row.customer_id}:paid",
                        actor="backfill",
                        reason="balance carried over from the previous system",
                    )
                )
                result.credits = "skipped" if appended.duplicated else "created"
        except _RowError as err:
            result.status = "error"
            result.reason = str(err)
        report.results.append(result)
    report.errors = sum(1 for r in report.results if r.status == "error")
    report.ok = len(report.results) - report.errors
    return report


def _text(v: Any) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def _date(v: Any) -> datetime | None:
    s = _text(v)
    if s is None:
        return None
    d = datetime.fromisoformat(s)
    if d.tzinfo is None:
        d = d.replace(tzinfo=UTC)
    return d


def _int(v: Any) -> int | None:
    s = _text(v)
    if s is None:
        return None
    try:
        return int(s)
    except ValueError:
        return -1  # reported as invalid_credits by backfill(), same as the TS NaN path


def parse_backfill_file(content: str) -> list[BackfillRow]:
    """Reads the export file: CSV with a header row (BACKFILL_COLUMNS) or a JSON array with the same keys."""
    t = content.strip()
    if t.startswith("["):
        records: list[dict[str, Any]] = json.loads(t)
    else:
        records = [dict(r) for r in csv.DictReader(io.StringIO(t))]
    return [
        BackfillRow(
            customer_id=_text(r.get("customer_id")) or "",
            email=_text(r.get("email")),
            provider=_text(r.get("provider")) or "",
            customer_ref=_text(r.get("customer_ref")) or "",
            subscription_ref=_text(r.get("subscription_ref")),
            plan_id=_text(r.get("plan_id")),
            billing_key=_text(r.get("billing_key")),
            period_start=_date(r.get("period_start")),
            period_end=_date(r.get("period_end")),
            credits=_int(r.get("credits")),
            credits_expire_at=_date(r.get("credits_expire_at")),
        )
        for r in records
    ]


async def _single_price_currency(input: BackfillInput, plan_id: str | None) -> str | None:
    """EC:A28 -- a plan priced in one currency pins the subscription to it; otherwise None."""
    plan = await input.repo.plans.get(plan_id) if plan_id else None
    return plan.prices[0].currency if plan is not None and len(plan.prices) == 1 else None
