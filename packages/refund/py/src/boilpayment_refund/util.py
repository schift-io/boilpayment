"""Local helpers. EC:G2 proration_ratio itself lives in `core` (shared, canonical) —
re-exported here so evaluate.py has one import surface; not duplicated."""

from __future__ import annotations

import dataclasses
from datetime import datetime, timedelta

from boilpayment_core import (
    LedgerEntry,
    Payment,
    Period,
    RefundRounding,
    Repo,
    proration_ratio,
)
from boilpayment_core.money import round_half_away_from_zero

__all__ = [
    "apply_rounding",
    "days_between",
    "proration_ratio",
    "revert_refunded_upgrade",
    "weighted_avg_unit_price",
]

DAY = timedelta(days=1)


def days_between(start: datetime, end: datetime) -> int:
    """Whole days elapsed from start to end (floor)."""
    return (end - start) // DAY


def apply_rounding(raw: float, rounding: RefundRounding) -> int:
    """EC:D4 — rounding direction for amount -> credits conversion."""
    import math

    if rounding == "ceil_credits":
        return math.ceil(raw)
    if rounding == "round_credits":
        # EC:J9 -- half away from zero like the TS kit; built-in round() is half-to-even.
        return round_half_away_from_zero(raw)
    return math.floor(raw)


def weighted_avg_unit_price(grants: list[LedgerEntry]) -> int | float:
    """EC:B8 — grant-weighted average unit price across a set of grant ledger entries."""
    total_amount = 0
    total_value = 0.0
    for g in grants:
        total_amount += g.amount
        total_value += g.amount * (g.unit_price_minor or 0)
    if total_amount <= 0:
        return 0
    v = total_value / total_amount
    return int(v) if float(v).is_integer() else v  # integral -> int, mirrors JS number semantics


async def revert_refunded_upgrade(repo: Repo, payment: Payment) -> None:
    """EC:A76 -- a fully refunded upgrade charge puts the subscription back where the upgrade found it: the
    old plan, period and anchor. Only while the upgraded plan is still current; a partial refund changes
    nothing. Mirrors revertRefundedUpgrade in util.ts."""
    if payment.status != "refunded" or not payment.subscription_id:
        return
    up = payment.raw.get("boilpaymentUpgrade") if isinstance(payment.raw, dict) else None
    if not isinstance(up, dict) or not all(isinstance(up.get(k), str) for k in ("fromPlanId", "fromPeriodStart", "fromPeriodEnd")):
        return
    sub = await repo.subscriptions.get(payment.subscription_id)
    if sub is None or sub.plan_id != up.get("planId"):
        return
    # EC:A80 -- a renewal after the upgrade charge paid its period at the upgraded price; restoring the old
    # period would bill it again. Only the charge's credits come back.
    if sub.current_period.start > payment.occurred_at:
        return
    anchor = up.get("fromAnchorDay")
    await repo.subscriptions.put(dataclasses.replace(
        sub, plan_id=up["fromPlanId"], scheduled_plan_id=None,
        current_period=Period(start=datetime.fromisoformat(up["fromPeriodStart"]), end=datetime.fromisoformat(up["fromPeriodEnd"])),
        anchor_day=anchor if isinstance(anchor, int) else sub.anchor_day,
    ))
