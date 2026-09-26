"""Money value-object helpers. Mirrors packages/core/ts/src/money.ts exactly.
EC:B8 (grant unit price) / EC:D6 (refund in payment currency) rely on these staying minor-unit-exact.
"""

from __future__ import annotations

import math
from typing import Literal

from .types import Money

# Currencies with zero minor-unit decimals (amount_minor IS the amount, no /100).
ZERO_DECIMAL_CURRENCIES: tuple[str, ...] = ("KRW", "JPY")

Rounding = Literal["floor", "ceil", "round"]


def money(amount_minor: int, currency: str) -> Money:
    if not isinstance(amount_minor, int) or isinstance(amount_minor, bool):
        raise TypeError(f"amount_minor must be an integer, got {amount_minor!r}")
    return Money(amount_minor=amount_minor, currency=currency.upper())


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
        rounded = round(raw)
    return money(rounded, m.currency)
