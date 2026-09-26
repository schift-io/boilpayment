"""spec: packages/credits/spec/credits.pseudo.md — EC:B3"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field

from schift_payment_kit_core import (
    Clock,
    ConsumeInput,
    ConsumeResult,
    InsufficientBalanceError,
    LedgerReference,
    LedgerStore,
    Policy,
    Pool,
)

_POOL_ORDER: dict[str, list[Pool]] = {
    "expiring_first": ["paid", "promo", "trial"],
    "promo_first_then_expiring": ["promo", "trial", "paid"],
    "paid_first": ["paid", "trial", "promo"],
}


@dataclass(kw_only=True, slots=True)
class ConsumeCreditsInput:
    customer_id: str
    amount: int
    policy: Policy
    ledger: LedgerStore
    clock: Clock
    idempotency_key: str
    reference: LedgerReference = field(default_factory=LedgerReference)
    reason: str | None = None
    actor: str = "app"
    # EC:L5 -- optional delivery-scoped id, merged into meta.correlation_id (never overwrites one
    # already set on `reference`).
    correlation_id: str | None = None


# EC:B3 — maps policy.credits.consume_order to a pool order, delegates the atomic
# expiring-first-within-pool draw and negative-balance handling (EC:B4/B5/B14) to LedgerStore.consume.
async def consume(input: ConsumeCreditsInput) -> ConsumeResult:
    pool_order = _POOL_ORDER[input.policy.credits.consume_order]

    meta = dataclasses.replace(
        input.reference,
        correlation_id=input.reference.correlation_id or input.correlation_id,
    )
    result = await input.ledger.consume(
        ConsumeInput(
            customer_id=input.customer_id,
            pool_order=pool_order,
            amount=input.amount,
            idempotency_key=input.idempotency_key,
            meta=meta,
            now=input.clock.now(),
            negative_balance=input.policy.credits.negative_balance,
            negative_floor=input.policy.credits.negative_floor,
            reason=input.reason,
            actor=input.actor,
        )
    )

    if not result.ok and input.policy.credits.negative_balance == "block":
        raise InsufficientBalanceError(result.shortfall)

    return result
