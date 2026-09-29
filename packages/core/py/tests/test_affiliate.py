from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from boilpayment_core import (
    AffiliateCommission,
    CreateCheckoutInput,
    Deps,
    InMemoryAffiliateCommissionTable,
    Payment,
    SaleEvidence,
    Subscription,
    calculate_affiliate_accrual,
    calculate_affiliate_reversal,
    money,
)


def _commission(**overrides: object) -> AffiliateCommission:
    values = {
        "id": "commission-1",
        "kind": "accrual",
        "affiliate_id": "affiliate-1",
        "payment_id": "payment-1",
        "refund_id": None,
        "related_accrual_id": None,
        "amount": money(100, "usd"),
        "idempotency_key": "affiliate:payment-1:accrual",
        "created_at": datetime(2026, 9, 28, tzinfo=UTC),
    }
    values.update(overrides)
    return AffiliateCommission(**values)


def test_rate_accrual_floors_and_preserves_currency() -> None:
    # Given / When / Then
    assert calculate_affiliate_accrual(
        money(1_999, "usd"), {"type": "rate", "rate": 0.15}
    ) == money(299, "usd")


def test_accrual_caps_fixed_rate_and_negative_paid_amounts() -> None:
    # Given / When / Then
    assert calculate_affiliate_accrual(
        money(500, "krw"), {"type": "fixed", "amount_minor": 900}
    ) == money(500, "krw")
    assert calculate_affiliate_accrual(
        money(500, "krw"), {"type": "rate", "rate": 2}
    ) == money(500, "krw")
    assert calculate_affiliate_accrual(
        money(-1, "krw"), {"type": "fixed", "amount_minor": 100}
    ) == money(0, "krw")


def test_proportional_reversal_ceils_toward_affiliate_receiving_less() -> None:
    # Given / When / Then: 299 * 1 / 3 = 99.666...
    assert calculate_affiliate_reversal(
        money(299, "usd"), money(1, "usd"), money(3, "usd")
    ) == money(100, "usd")


def test_proportional_reversal_is_capped_at_accrual() -> None:
    # Given / When / Then
    assert calculate_affiliate_reversal(
        money(300, "usd"), money(2_000, "usd"), money(1_000, "usd")
    ) == money(300, "usd")


def test_in_memory_commissions_are_idempotent_and_filterable() -> None:
    async def run() -> None:
        # Given
        table = InMemoryAffiliateCommissionTable()
        first = _commission()
        conflicting_retry = _commission(id="commission-2", amount=money(999, "usd"))
        reversal = _commission(
            id="commission-3",
            kind="reversal",
            refund_id="refund-1",
            related_accrual_id=first.id,
            amount=money(25, "usd"),
            idempotency_key="affiliate:refund-1:reversal",
        )

        # When
        appended = await table.append(first)
        replayed = await table.append(conflicting_retry)
        await table.append(reversal)

        # Then
        assert appended == first
        assert replayed == first
        assert await table.list(affiliate_id="affiliate-1") == [first, reversal]
        assert await table.list(payment_id="payment-1", kind="reversal") == [reversal]
        appended.amount.amount_minor = 999
        listed = await table.list(payment_id="payment-1", kind="accrual")
        listed[0].amount.amount_minor = 888
        assert (
            await table.list(payment_id="payment-1", kind="accrual")
        )[0].amount.amount_minor == 100

    asyncio.run(run())


def test_discount_and_affiliate_contract_fields_are_source_compatible() -> None:
    # Given / When
    evidence = SaleEvidence(
        provider_subtotal=money(2_000, "usd"),
        discount_amount=money(500, "usd"),
        price_ref="price-1",
        checkout_id="checkout-1",
        payment_link_id=None,
        link_reference=None,
    )

    # Then: runtime defaults preserve existing constructors.
    assert Payment.__dataclass_fields__["sale_evidence"].default is None
    assert Payment.__dataclass_fields__["affiliate_id"].default is None
    assert CreateCheckoutInput.__dataclass_fields__["allow_discount_codes"].default is False
    assert CreateCheckoutInput.__dataclass_fields__["preset_discount_code"].default is None
    assert CreateCheckoutInput.__dataclass_fields__["affiliate_id"].default is None
    assert Subscription.__dataclass_fields__["affiliate_id"].default is None
    assert Deps.__dataclass_fields__["affiliate_commission"].default is None
    assert evidence.discount_amount == money(500, "usd")
