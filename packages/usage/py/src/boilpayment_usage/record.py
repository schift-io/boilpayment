# EC:C2 EC:C3 EC:C4 EC:C7 — see spec/usage.pseudo.md
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from boilpayment_core import (
    Clock,
    IdGen,
    OutboxItem,
    PaymentProvider,
    Plan,
    Policy,
    Repo,
    Subscription,
    UsageEvent,
    period_containing,
)

from .period import hours_between, previous_period_start


@dataclass(kw_only=True, slots=True)
class UsageEventInput:
    customer_id: str
    meter: str
    quantity: int
    occurred_at: datetime
    idempotency_key: str
    meta: dict[str, Any] | None = None


@dataclass(kw_only=True, slots=True)
class RecordResult:
    event: UsageEvent
    duplicated: bool


async def record(
    *,
    event: UsageEventInput,
    sub: Subscription,
    policy: Policy,
    repo: Repo,
    clock: Clock,
    ids: IdGen,
    provider: PaymentProvider | None = None,
    plan: Plan | None = None,
) -> RecordResult:
    """`plan` is optional — when given, EC:C2's previous-period attribution uses core's exact
    `period_containing(sub.created_at, plan.interval, event.occurred_at, ...)` instead of the
    `current_period` length approximation (see spec design note). `sub.created_at` is used (not
    `sub.current_period.start`) because `period_containing` only walks *forward* from its anchor —
    for a late report `occurred_at` is before `current_period.start`, so the anchor must already
    precede it, and `sub.created_at` is the only instant on `Subscription` guaranteed to."""
    # EC:C2 — dedupe by idempotency key (mirrors EC:B12's webhook dedupe pattern)
    # EC:B20 -- dedupe per customer: another customer's identical key is a different event.
    existing = await repo.usage_events.list(
        customer_id=event.customer_id, idempotency_key=event.idempotency_key
    )
    if existing:
        return RecordResult(event=existing[0], duplicated=True)

    received_at = clock.now()  # EC:C3 — UTC, from injected Clock

    # EC:C2 — period attribution incl. late-report window
    period_start = sub.current_period.start
    if event.occurred_at < sub.current_period.start:
        late_hours = hours_between(received_at, sub.current_period.start)
        if late_hours <= policy.usage.late_report_window_hours:
            if plan is not None and plan.interval is not None:
                period_start = period_containing(
                    sub.created_at,
                    plan.interval,
                    event.occurred_at,
                    sub.anchor_day,
                    policy.period.timezone,
                    policy.period.month_end_anchor,
                ).start
            else:
                period_start = previous_period_start(
                    sub.current_period
                )  # no plan given — keep the length approximation
        else:
            period_start = sub.current_period.start

    row = UsageEvent(
        id=ids.new_id(),
        customer_id=event.customer_id,
        meter=event.meter,
        quantity=event.quantity,
        occurred_at=event.occurred_at,
        received_at=received_at,
        period_start=period_start,
        idempotency_key=event.idempotency_key,
        meta=event.meta,  # EC:C7
    )
    saved = await repo.usage_events.put(row)

    # EC:C4 — enqueue provider meter-report if this provider reports usage
    if provider is not None and provider.capabilities().meters:
        item = OutboxItem(
            id=ids.new_id(),
            kind="usage.report",
            payload={
                "eventId": saved.id,
                "customerId": saved.customer_id,
                "meter": saved.meter,
                "quantity": saved.quantity,
                "occurredAt": saved.occurred_at,
                "provider": sub.provider,
            },
            status="pending",
            attempts=0,
            next_attempt_at=clock.now(),
            created_at=clock.now(),
        )
        await repo.outbox.put(item)

    return RecordResult(event=saved, duplicated=False)
