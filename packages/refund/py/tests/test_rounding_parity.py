"""[EC:J9] refund credit rounding is half away from zero in both languages (Python's round() is
half-to-even: round(2.5) == 2 while TS Math.round(2.5) == 3). Values: the round-3 audit's set."""
from __future__ import annotations

import math

from boilpayment_core.money import money, round_half_away_from_zero
from boilpayment_refund.external import credits_for_amount
from boilpayment_refund.util import apply_rounding


def _audit_values() -> list[float]:
    vals = [0.5, 1.5, 2.5, 0.49999999999999994, 4503599627370495.5, 4503599627370497, 2**53 - 1, 1e15 + 0.5, 12.5000000001, 12.4999999999]
    s = 12345

    def rnd() -> float:
        nonlocal s
        s = (s * 1103515245 + 12345) % 2147483648
        return s / 2147483648

    for _ in range(2000):
        k = math.floor(rnd() * 1e6)
        vals += [k + 0.5, k + rnd(), (k * 7 + 3) / 2]
    return vals


def test_ec_j9_round_credits_is_half_away_from_zero() -> None:
    vals = _audit_values()
    assert len(vals) > 6000
    assert [apply_rounding(v, "round_credits") for v in vals] == [round_half_away_from_zero(v) for v in vals]
    assert apply_rounding(2.5, "round_credits") == 3


def test_ec_j9_external_refund_credits_round_half_up() -> None:
    assert [credits_for_amount(a, u) for a, u in [(250, 100), (25, 10), (35, 10), (1050, 100), (249, 100)]] == [3, 3, 4, 11, 2]
    assert credits_for_amount(500, 0) == 0


def test_ec_j10_money_accepts_integral_floats_like_ts() -> None:
    assert money(50000.0, "krw").amount_minor == 50000
    assert isinstance(money(50000.0, "krw").amount_minor, int)
    for bad in (1.5, float("nan"), float("inf"), 2.0**53, True):
        try:
            money(bad, "krw")  # type: ignore[arg-type]
        except (TypeError, ValueError):
            continue
        raise AssertionError(f"money({bad!r}) was accepted")
