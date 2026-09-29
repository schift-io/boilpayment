"""Append-only affiliate commission reversals for settled refunds."""

from __future__ import annotations

from dataclasses import dataclass, replace
from functools import partial

from boilpayment_core import (
    AffiliateCommission,
    Clock,
    LedgerStore,
    Payment,
    Refund,
    Repo,
    calculate_affiliate_reversal,
)


@dataclass(frozen=True, slots=True, kw_only=True)
class AppendAffiliateReversalsInput:
    repo: Repo
    ledger: LedgerStore
    clock: Clock
    payment: Payment
    refund: Refund


async def append_affiliate_reversals(input: AppendAffiliateReversalsInput) -> None:
    """Append each accrual's proportional reversal without mutating the accrual."""
    repo, ledger, clock, payment, refund = (
        input.repo,
        input.ledger,
        input.clock,
        input.payment,
        input.refund,
    )
    if refund.status != "succeeded":
        return
    rows = await repo.affiliate_commissions.list(payment_id=payment.id)
    accruals = [row for row in rows if row.kind == "accrual"]
    async def append_capped_reversal(accrual: AffiliateCommission) -> None:
        fresh_rows = await repo.affiliate_commissions.list(payment_id=payment.id)
        idempotency_key = f"affiliate-reversal:{refund.id}:{accrual.id}"
        reversed_minor = sum(
            row.amount.amount_minor
            for row in fresh_rows
            if row.kind == "reversal" and row.related_accrual_id == accrual.id
        )
        calculated = calculate_affiliate_reversal(
            accrual.amount, refund.amount, payment.amount
        )
        amount = replace(
            calculated,
            amount_minor=min(
                calculated.amount_minor,
                max(0, accrual.amount.amount_minor - reversed_minor),
            ),
        )
        await repo.affiliate_commissions.append(
            AffiliateCommission(
                id=idempotency_key,
                kind="reversal",
                affiliate_id=accrual.affiliate_id,
                payment_id=payment.id,
                refund_id=refund.id,
                related_accrual_id=accrual.id,
                amount=amount,
                idempotency_key=idempotency_key,
                created_at=clock.now(),
            )
        )

    for accrual in accruals:
        await ledger.transaction(
            f"affiliate-commission:{payment.id}:{accrual.id}",
            partial(append_capped_reversal, accrual),
        )
