# EC:C9 — see spec/usage.pseudo.md
from __future__ import annotations

from dataclasses import dataclass

from boilpayment_core import (
    Clock,
    IdGen,
    Money,
    PaymentProvider,
    Policy,
    Repo,
    Subscription,
)

from .billing_currency import billing_currency


@dataclass(kw_only=True, slots=True)
class ClosePeriodResult:
    total: int
    overage: int
    overage_amount: Money | None


async def close_period(
    *,
    sub: Subscription,
    policy: Policy,
    repo: Repo,
    provider: PaymentProvider | None = None,
    clock: Clock,
    ids: IdGen,
    currency: str | None = None,
) -> ClosePeriodResult:
    events = await repo.usage_events.list(customer_id=sub.customer_id)
    period_events = [e for e in events if e.period_start == sub.current_period.start]
    total = sum(e.quantity for e in period_events)
    overage = max(0, total - policy.usage.included_quantity)

    overage_amount: Money | None = None
    if (
        overage > 0
        and policy.usage.overage == "bill_overage"
        and policy.usage.overage_unit_price_minor is not None
    ):
        overage_amount = Money(
            amount_minor=overage * policy.usage.overage_unit_price_minor,
            currency=await billing_currency(repo, sub.plan_id, currency),
        )

    # Repo (core §3.4) has no `usage_periods` table. Best-effort: use one if a
    # concrete Repo implementation duck-types it in, otherwise just return.
    usage_periods = getattr(repo, "usage_periods", None)
    if usage_periods is not None:
        await usage_periods.put(
            {
                "subscription_id": sub.id,
                "period_start": sub.current_period.start,
                "total": total,
                "overage": overage,
                "closed_at": clock.now(),
            }
        )

    return ClosePeriodResult(
        total=total, overage=overage, overage_amount=overage_amount
    )
