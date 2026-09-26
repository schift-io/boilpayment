"""Period / calendar arithmetic. See spec/core.pseudo.md [EC:G1] [EC:G2] [EC:G3].
Mirrors packages/core/ts/src/period.ts exactly.
All datetime instants in/out are UTC (EC:G3); `tz` is used only for civil month/day arithmetic.
"""

from __future__ import annotations

import calendar
from datetime import UTC, datetime
from typing import Literal, NamedTuple
from zoneinfo import ZoneInfo

from .types import MonthEndAnchor, Period, ProrationDenominator

_DAY_MS = 86_400_000

Interval = Literal["month", "year"]


class _CivilParts(NamedTuple):
    year: int
    month: int  # 1..12
    day: int
    hour: int
    minute: int
    second: int
    microsecond: int


def _civil_parts_in_tz(dt: datetime, tz: str) -> _CivilParts:
    local = dt.astimezone(ZoneInfo(tz))
    return _CivilParts(
        local.year,
        local.month,
        local.day,
        local.hour,
        local.minute,
        local.second,
        local.microsecond,
    )


def _civil_to_utc(parts: _CivilParts, tz: str) -> datetime:
    naive = datetime(  # noqa: DTZ001 -- civil (wall-clock) time, localized below
        parts.year,
        parts.month,
        parts.day,
        parts.hour,
        parts.minute,
        parts.second,
        parts.microsecond,
    )
    local = naive.replace(tzinfo=ZoneInfo(tz))
    return local.astimezone(UTC)


def days_in_month(year: int, month: int) -> int:
    """Number of days in `month` (1..12) of `year`, accounting for leap years (EC:G5)."""
    return calendar.monthrange(year, month)[1]


def days_in_period(period: Period) -> float:
    """EC:G2 — actual elapsed days across [start, end). May be fractional."""
    return (period.end - period.start).total_seconds() * 1000 / _DAY_MS


def next_period(
    period: Period,
    interval: Interval,
    anchor_day: int,
    tz: str,
    month_end_anchor: MonthEndAnchor,
) -> Period:
    """EC:G1 — advance `period` by one `interval`, anchored on `anchor_day` (1..31) in `tz`.

    - clamp_keep_original_day: retries the original `anchor_day` every cycle (a short month
      clamps down; a later, longer month goes back up to `anchor_day`).
    - clamp_permanently: once a cycle clamps, the clamped day becomes the permanent anchor —
      derived statelessly from `period.end`'s day-of-month in `tz` (no extra state needed).
    """
    end = _civil_parts_in_tz(period.end, tz)
    effective_day = end.day if month_end_anchor == "clamp_permanently" else anchor_day
    months_to_add = 12 if interval == "year" else 1
    target_index = (end.month - 1) + months_to_add  # 0-based, may overflow past 11
    target_year = end.year + target_index // 12
    target_month = (target_index % 12) + 1  # 1..12
    day = min(effective_day, days_in_month(target_year, target_month))
    new_end = _civil_to_utc(
        _CivilParts(
            target_year,
            target_month,
            day,
            end.hour,
            end.minute,
            end.second,
            end.microsecond,
        ),
        tz,
    )
    return Period(start=period.end, end=new_end)


def period_containing(
    anchor_start: datetime,
    interval: Interval,
    now: datetime,
    anchor_day: int,
    tz: str,
    month_end_anchor: MonthEndAnchor,
) -> Period:
    """EC:G1/G3 — the period containing `now`, walked forward from `anchor_start` (the
    subscription's original period-start instant) one interval at a time.
    """
    period = next_period(
        Period(start=anchor_start, end=anchor_start),
        interval,
        anchor_day,
        tz,
        month_end_anchor,
    )
    max_steps = 100_000
    steps = 0
    while period.end <= now:
        period = next_period(period, interval, anchor_day, tz, month_end_anchor)
        steps += 1
        if steps > max_steps:
            raise RuntimeError(
                "period_containing: exceeded max steps; check anchor_start/now"
            )
    return period


def proration_ratio(
    period: Period, now: datetime, denominator: ProrationDenominator
) -> float:
    """EC:G2 — fraction of `period` remaining at `now`, clamped to [0, 1]."""
    total_days = 30.0 if denominator == "fixed_30" else days_in_period(period)
    if total_days <= 0:
        return 0.0
    remaining_days = (period.end - now).total_seconds() * 1000 / _DAY_MS
    return min(1.0, max(0.0, remaining_days / total_days))


def elapsed_ratio(
    period: Period, now: datetime, denominator: ProrationDenominator
) -> float:
    """EC:G2 — fraction of `period` elapsed at `now`, clamped to [0, 1]."""
    return 1.0 - proration_ratio(period, now, denominator)
