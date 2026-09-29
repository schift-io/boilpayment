"""Affiliate commission rules, exact refund math, and the in-memory append-only store."""

from __future__ import annotations

import math
from copy import deepcopy
from decimal import Decimal
from typing import Literal, TypedDict

from .money import assert_same_currency, money, scale_minor
from .types import AffiliateCommission, AffiliateCommissionKind, Money


class RateCommissionRule(TypedDict):
    type: Literal["rate"]
    rate: float


class FixedCommissionRule(TypedDict):
    type: Literal["fixed"]
    amount_minor: int


AffiliateCommissionRule = RateCommissionRule | FixedCommissionRule


def calculate_affiliate_accrual(
    paid: Money, rule: AffiliateCommissionRule
) -> Money:
    """Return a nonnegative commission in the payment currency, capped at paid."""
    paid_minor = max(0, paid.amount_minor)
    match rule:
        case {"type": "rate", "rate": rate}:
            if not math.isfinite(rate):
                raise ValueError("affiliate commission rate must be finite")
            exact_rate = max(Decimal(0), Decimal(str(rate)))
            amount_minor = min(paid_minor, int(Decimal(paid_minor) * exact_rate))
        case {"type": "fixed", "amount_minor": amount_minor}:
            amount_minor = min(paid_minor, max(0, amount_minor))
    return money(amount_minor, paid.currency)


def calculate_affiliate_reversal(
    accrual: Money, refunded: Money, paid: Money
) -> Money:
    """Return ceil(accrual * refunded / paid), capped at the accrual."""
    assert_same_currency(accrual, refunded)
    assert_same_currency(accrual, paid)
    accrual_minor = max(0, accrual.amount_minor)
    paid_minor = max(0, paid.amount_minor)
    if accrual_minor == 0 or paid_minor == 0:
        return money(0, accrual.currency)
    refunded_minor = min(paid_minor, max(0, refunded.amount_minor))
    return money(
        min(
            accrual_minor,
            scale_minor(accrual_minor, refunded_minor, paid_minor, "ceil"),
        ),
        accrual.currency,
    )


class InMemoryAffiliateCommissionTable:
    """Append-only commission storage, idempotent by idempotency_key."""

    def __init__(self) -> None:
        self._rows: list[AffiliateCommission] = []
        self._by_idempotency_key: dict[str, AffiliateCommission] = {}

    async def append(self, row: AffiliateCommission) -> AffiliateCommission:
        existing = self._by_idempotency_key.get(row.idempotency_key)
        if existing is not None:
            return deepcopy(existing)
        stored = deepcopy(row)
        self._rows.append(stored)
        self._by_idempotency_key[stored.idempotency_key] = stored
        return deepcopy(stored)

    async def list(
        self,
        *,
        affiliate_id: str | None = None,
        payment_id: str | None = None,
        kind: AffiliateCommissionKind | None = None,
    ) -> list[AffiliateCommission]:
        return deepcopy([
            row
            for row in self._rows
            if (affiliate_id is None or row.affiliate_id == affiliate_id)
            and (payment_id is None or row.payment_id == payment_id)
            and (kind is None or row.kind == kind)
        ])
