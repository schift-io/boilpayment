"""spec: packages/core/spec/core.pseudo.md [EC:G1] [EC:G2] [EC:G5]"""

from __future__ import annotations

import math
from datetime import UTC, datetime

from boilpayment_core import Period, next_period, proration_ratio


def test_ec_g1_clamp_keep_original_day_jan31_feb28_mar31():
    p0 = Period(
        start=datetime(2026, 1, 1, tzinfo=UTC), end=datetime(2026, 1, 31, tzinfo=UTC)
    )
    p1 = next_period(p0, "month", 31, "UTC", "clamp_keep_original_day")
    assert p1.start == datetime(2026, 1, 31, tzinfo=UTC)
    assert p1.end == datetime(2026, 2, 28, tzinfo=UTC)
    p2 = next_period(p1, "month", 31, "UTC", "clamp_keep_original_day")
    assert p2.start == datetime(2026, 2, 28, tzinfo=UTC)
    assert p2.end == datetime(2026, 3, 31, tzinfo=UTC)


def test_ec_g1_clamp_permanently_jan31_feb28_mar28():
    p0 = Period(
        start=datetime(2026, 1, 1, tzinfo=UTC), end=datetime(2026, 1, 31, tzinfo=UTC)
    )
    p1 = next_period(p0, "month", 31, "UTC", "clamp_permanently")
    assert p1.end == datetime(2026, 2, 28, tzinfo=UTC)
    p2 = next_period(p1, "month", 31, "UTC", "clamp_permanently")
    assert p2.end == datetime(2026, 3, 28, tzinfo=UTC)


def test_ec_g1_g5_leap_year_anchor29_lands_on_feb29():
    p0 = Period(
        start=datetime(2027, 12, 29, tzinfo=UTC), end=datetime(2028, 1, 29, tzinfo=UTC)
    )
    p1 = next_period(p0, "month", 29, "UTC", "clamp_keep_original_day")
    assert p1.end == datetime(2028, 2, 29, tzinfo=UTC)


def test_ec_g1_g5_non_leap_year_anchor29_clamps_then_recovers():
    p0 = Period(
        start=datetime(2026, 12, 29, tzinfo=UTC), end=datetime(2027, 1, 29, tzinfo=UTC)
    )
    p1 = next_period(p0, "month", 29, "UTC", "clamp_keep_original_day")
    assert p1.end == datetime(2027, 2, 28, tzinfo=UTC)
    p2 = next_period(p1, "month", 29, "UTC", "clamp_keep_original_day")
    assert p2.end == datetime(2027, 3, 29, tzinfo=UTC)


def test_ec_g1_interval_year_adds_12_months_keeps_clamped_day():
    p0 = Period(
        start=datetime(2027, 2, 28, tzinfo=UTC), end=datetime(2027, 2, 28, tzinfo=UTC)
    )
    p1 = next_period(p0, "year", 29, "UTC", "clamp_keep_original_day")
    assert p1.end == datetime(2028, 2, 29, tzinfo=UTC)


def test_ec_g2_actual_days_in_period_16_of_31():
    period = Period(
        start=datetime(2026, 1, 1, tzinfo=UTC), end=datetime(2026, 2, 1, tzinfo=UTC)
    )
    now = datetime(2026, 1, 16, tzinfo=UTC)
    ratio = proration_ratio(period, now, "actual_days_in_period")
    assert math.isclose(ratio, 16 / 31, rel_tol=1e-12)


def test_ec_g2_fixed_30_denominator():
    period = Period(
        start=datetime(2026, 1, 1, tzinfo=UTC), end=datetime(2026, 2, 1, tzinfo=UTC)
    )
    now = datetime(2026, 1, 16, tzinfo=UTC)
    ratio = proration_ratio(period, now, "fixed_30")
    assert math.isclose(ratio, 16 / 30, rel_tol=1e-12)


def test_ec_g2_mid_period_30_day_period_is_half_under_both_denominators():
    period = Period(
        start=datetime(2026, 3, 1, tzinfo=UTC), end=datetime(2026, 3, 31, tzinfo=UTC)
    )
    mid = datetime(2026, 3, 16, tzinfo=UTC)
    assert proration_ratio(period, mid, "actual_days_in_period") == 0.5
    assert proration_ratio(period, mid, "fixed_30") == 0.5


def test_ec_g2_ratio_clamps_to_0_1_outside_period():
    period = Period(
        start=datetime(2026, 1, 1, tzinfo=UTC), end=datetime(2026, 2, 1, tzinfo=UTC)
    )
    assert (
        proration_ratio(
            period, datetime(2026, 3, 1, tzinfo=UTC), "actual_days_in_period"
        )
        == 0
    )
    assert (
        proration_ratio(
            period, datetime(2025, 12, 1, tzinfo=UTC), "actual_days_in_period"
        )
        == 1
    )
