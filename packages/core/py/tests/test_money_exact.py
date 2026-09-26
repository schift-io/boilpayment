"""[EC:J6] ISO 4217 minor units; [EC:J7] safe integers, exact rational scaling, one .5 rule."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from boilpayment_core import (
    Period,
    currency_exponent,
    money,
    mul_money_ratio,
    proration_fraction,
    round_half_away_from_zero,
    scale_minor,
)


def test_ec_j6_exponents() -> None:
    assert [currency_exponent(c) for c in ["KRW", "JPY", "VND", "CLP", "usd", "EUR", "KWD", "BHD", "TND"]] == [0, 0, 0, 0, 2, 2, 3, 3, 3]


def test_ec_j7_safe_integer() -> None:
    with pytest.raises(ValueError):
        money(2**53 + 2, "USD")
    assert money(2**53 - 1, "USD").amount_minor == 2**53 - 1


def test_ec_j7_exact_proration() -> None:
    now = datetime(2026, 1, 1, tzinfo=UTC)
    num, den = proration_fraction(Period(start=now - timedelta(days=21.3), end=now + timedelta(days=8.7)), now, "fixed_30")
    assert scale_minor(100, num, den, "floor") == 29


def test_ec_j7_rounding_same_as_ts() -> None:
    assert [scale_minor(5, 1, 2, "floor"), scale_minor(5, 1, 2, "ceil"), scale_minor(5, 1, 2, "round"),
            scale_minor(-5, 1, 2, "round"), scale_minor(-5, 1, 2, "floor")] == [2, 3, 3, -3, -3]
    assert [round_half_away_from_zero(2.5), round_half_away_from_zero(-2.5),
            mul_money_ratio(money(-5, "USD"), 0.5, "round").amount_minor, mul_money_ratio(money(5, "USD"), 0.5, "round").amount_minor] == [3, -3, -3, 3]
