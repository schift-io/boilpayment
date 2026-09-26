"""[EC:J8] Python money math gives the same integers as the TS kit on the edge cases the re-audit
found: floor(x + 0.5) rounding and banker's/microsecond proration differed from TS."""
from __future__ import annotations

from datetime import UTC, datetime

from boilpayment_core import Period
from boilpayment_core.money import round_half_away_from_zero
from boilpayment_core.period import proration_fraction


def test_ec_j8_rounding_matches_ts_math_round() -> None:
    # Values from node: Math.round(0.49999999999999994)=0, Math.round(2.5)=3, -Math.round(2.5)=-3,
    # Math.round(4503599627370497)=4503599627370497, Math.round(1.4999999999999998)=1
    assert [round_half_away_from_zero(x) for x in (0.49999999999999994, 2.5, -2.5, 4503599627370497.0, 1.4999999999999998)] == [
        0, 3, -3, 4503599627370497, 1]


def test_ec_j8_proration_fraction_matches_ts_including_microseconds() -> None:
    period = Period(start=datetime(2024, 1, 1, tzinfo=UTC), end=datetime(2024, 1, 31, tzinfo=UTC))
    # TS prorationFraction(period, 2024-01-16T12:34:56.789Z) -> { num: 1250703211, den: 2592000000 } (both denominators)
    now = datetime(2024, 1, 16, 12, 34, 56, 789_999, tzinfo=UTC)  # the extra microseconds a JS Date cannot hold
    assert proration_fraction(period, now, "fixed_30") == (1250703211, 2592000000)
