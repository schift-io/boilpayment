"""Local helpers. EC:G2 proration_ratio itself lives in `core` (shared, canonical) —
re-exported here so evaluate.py has one import surface; not duplicated."""

from __future__ import annotations

from datetime import datetime, timedelta

from boilpayment_core import LedgerEntry, RefundRounding, proration_ratio

__all__ = [
    "apply_rounding",
    "days_between",
    "proration_ratio",
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
        return round(raw)
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
