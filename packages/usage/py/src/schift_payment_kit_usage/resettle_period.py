"""EC:C2 C9 -- see spec/usage.pseudo.md"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from schift_payment_kit_core import Clock, Money, Policy, Repo, Subscription

from .billing_currency import billing_currency


@dataclass(kw_only=True, slots=True)
class ResettlePeriodResult:
    total: int
    settled_total: int
    newly_reported: int
    additional_overage: int
    additional_overage_amount: Money | None
    window_open: bool


async def resettle_period(
    *,
    sub: Subscription,
    period_start: datetime,
    policy: Policy,
    repo: Repo,
    clock: Clock,
    settled_total: int | None = None,
    currency: str | None = None,
) -> ResettlePeriodResult:
    """EC:C2 C9 -- bill usage that landed in a period AFTER that period was closed.

    `record()` attributes an event to the previous period while it is inside
    `policy.usage.late_report_window_hours`, but `close_period()` has already computed its total by
    then, so without this call that usage is never invoiced (silent revenue loss). Idempotent: the
    settled total is advanced to the recomputed total, so a second call reports `newly_reported: 0`.
    """
    table = getattr(repo, "usage_periods", None)

    if settled_total is None and table is not None and hasattr(table, "list"):
        rows = await table.list(subscription_id=sub.id, period_start=period_start)
        if rows:
            row = rows[0]
            settled_total = row["total"] if isinstance(row, dict) else row.total
    if settled_total is None:
        raise ValueError(
            "usage.resettle_period: settled_total is required when the Repo has no usage_periods "
            "table to read it from"
        )

    events = await repo.usage_events.list(customer_id=sub.customer_id)
    total = sum(e.quantity for e in events if e.period_start == period_start)

    newly_reported = max(0, total - settled_total)
    included = policy.usage.included_quantity
    additional_overage = max(0, total - included) - max(0, settled_total - included)

    additional_overage_amount: Money | None = None
    if (
        additional_overage > 0
        and policy.usage.overage == "bill_overage"
        and policy.usage.overage_unit_price_minor is not None
    ):
        additional_overage_amount = Money(
            amount_minor=additional_overage * policy.usage.overage_unit_price_minor,
            currency=await billing_currency(repo, sub.plan_id, currency),
        )

    # `record()` can attribute to this period until its END + the late-report window. Periods are
    # contiguous, so a closed earlier period ends where the current one begins.
    period_end = (
        sub.current_period.end
        if period_start == sub.current_period.start
        else sub.current_period.start
    )
    window_end = period_end + timedelta(hours=policy.usage.late_report_window_hours)
    window_open = clock.now() < window_end

    if newly_reported > 0 and table is not None:
        await table.put(
            {
                "subscription_id": sub.id,  # same key names as close_period()
                "period_start": period_start,
                "total": total,
                "overage": max(0, total - included),
                "closed_at": clock.now(),
            }
        )

    return ResettlePeriodResult(
        total=total,
        settled_total=settled_total,
        newly_reported=newly_reported,
        additional_overage=additional_overage,
        additional_overage_amount=additional_overage_amount,
        window_open=window_open,
    )
