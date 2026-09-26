"""Money value-object helpers. Mirrors packages/core/ts/src/money.ts exactly.
EC:B8 (grant unit price) / EC:D6 (refund in payment currency) rely on these staying minor-unit-exact.
"""

from __future__ import annotations

import math
from typing import Literal

from .types import Money

# EC:J6 -- ISO 4217 minor-unit exponents. Zero-decimal: amount_minor IS the amount. Three-decimal:
# amount_minor is thousandths. Everything else has two decimals.
ZERO_DECIMAL_CURRENCIES: tuple[str, ...] = (
    "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "UYI", "VND", "VUV", "XAF",
    "XOF", "XPF",
)
THREE_DECIMAL_CURRENCIES: tuple[str, ...] = ("BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND")
MAX_SAFE_INTEGER = 2**53 - 1


def currency_exponent(currency: str) -> int:
    """EC:J6 -- number of minor-unit decimals for a currency (0, 2 or 3)."""
    c = currency.upper()
    if c in ZERO_DECIMAL_CURRENCIES:
        return 0
    if c in THREE_DECIMAL_CURRENCIES:
        return 3
    return 2


Rounding = Literal["floor", "ceil", "round"]


def money(amount_minor: int, currency: str) -> Money:
    """EC:J7 -- amounts are safe integers (|n| <= 2^53 - 1), the same bound as the TS kit."""
    if not isinstance(amount_minor, int) or isinstance(amount_minor, bool):
        raise TypeError(f"amount_minor must be an integer, got {amount_minor!r}")
    if abs(amount_minor) > MAX_SAFE_INTEGER:
        raise ValueError(f"amount_minor must be a safe integer, got {amount_minor!r}")
    return Money(amount_minor=amount_minor, currency=currency.upper())


def round_half_away_from_zero(x: float) -> int:
    """EC:J7 -- half away from zero, identical to the TS kit (Python's round() is half-to-even)."""
    return -math.floor(-x + 0.5) if x < 0 else math.floor(x + 0.5)


def scale_minor(amount: int, num: int, den: int, rounding: Rounding = "floor") -> int:
    """EC:J7 -- exact amount * num / den in integers (no float), with explicit rounding."""
    for name, v in (("amount", amount), ("num", num), ("den", den)):
        if not isinstance(v, int) or isinstance(v, bool) or abs(v) > MAX_SAFE_INTEGER:
            raise ValueError(f"{name} must be a safe integer, got {v!r}")
    if den == 0:
        raise ValueError("den must not be 0")
    p, d = amount * num, den
    if d < 0:
        p, d = -p, -d
    q = abs(p) // d
    r = abs(p) % d
    negative = p < 0
    if r:
        if rounding == "floor":
            q = q + 1 if negative else q
        elif rounding == "ceil":
            q = q if negative else q + 1
        elif r * 2 >= d:  # half away from zero
            q += 1
    out = -q if negative else q
    if abs(out) > MAX_SAFE_INTEGER:
        raise ValueError(f"result {out} is not a safe integer")
    return out


def assert_same_currency(a: Money, b: Money) -> None:
    if a.currency != b.currency:
        raise ValueError(f"currency mismatch: {a.currency} vs {b.currency}")


def add_money(a: Money, b: Money) -> Money:
    assert_same_currency(a, b)
    return money(a.amount_minor + b.amount_minor, a.currency)


def mul_money_ratio(m: Money, ratio: float, rounding: Rounding = "floor") -> Money:
    raw = m.amount_minor * ratio
    if rounding == "floor":
        rounded = math.floor(raw)
    elif rounding == "ceil":
        rounded = math.ceil(raw)
    else:
        rounded = round_half_away_from_zero(raw)
    return money(rounded, m.currency)
