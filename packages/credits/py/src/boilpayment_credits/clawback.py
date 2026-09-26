"""spec: packages/credits/spec/credits.pseudo.md — EC:A4 B13"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass

from boilpayment_core import (
    ClawbackShortfall,
    Clock,
    InsufficientBalanceError,
    LedgerEntry,
    LedgerReference,
    LedgerSource,
    LedgerStore,
    NewLedgerEntry,
    Policy,
)


@dataclass(kw_only=True, slots=True)
class ClawbackInput:
    customer_id: str
    amount: int  # positive, requested revoke amount
    policy: Policy
    ledger: LedgerStore
    clock: Clock
    reason: str
    reference: LedgerReference
    actor: str
    idempotency_key: str
    # EC:A4 — caller supplies the resolved rule: downgrade passes policy.downgrade.clawback_shortfall.
    # EC:B13 — refund passes 'clamp_to_zero' or 'allow_negative' after it has already applied
    # policy.refund.revoke_shortfall ('clamp_and_reduce_refund' reduces the *refund amount*, which is
    # the refund module's own responsibility; only the resulting revoke amount reaches this function).
    shortfall: ClawbackShortfall
    # EC:L5 -- optional delivery-scoped id, merged into reference.correlation_id on the revoke
    # entry this call writes (never overwrites one already set on `reference`).
    correlation_id: str | None = None


@dataclass(kw_only=True, slots=True)
class ClawbackResult:
    revoked: int
    shortfall: int
    entry: LedgerEntry | None
    duplicated: bool


def _infer_source(idempotency_key: str) -> LedgerSource:
    if idempotency_key.startswith("revoke:downgrade:"):
        return "downgrade"
    if idempotency_key.startswith("revoke:refund:"):
        return "refund"
    return "manual"


# EC:A4 B13 — revoke credits, applying the shortfall rule when balance < requested amount.
async def clawback(input: ClawbackInput) -> ClawbackResult:
    balance = await input.ledger.balance(input.customer_id, "paid", input.clock.now())
    available = balance.available

    revoke_amount = input.amount
    shortfall_amount = 0

    if available < input.amount:
        if input.shortfall == "clamp_to_zero":
            revoke_amount = max(0, available)
            shortfall_amount = input.amount - revoke_amount
        elif input.shortfall == "allow_negative":
            revoke_amount = (
                input.amount
            )  # balance may go negative; offset at next grant
            shortfall_amount = 0
        else:
            # deny_downgrade
            raise InsufficientBalanceError(
                input.amount - available, {"rule": input.shortfall}
            )

    if revoke_amount <= 0:
        return ClawbackResult(
            revoked=0, shortfall=shortfall_amount, entry=None, duplicated=False
        )

    result = await input.ledger.append(
        NewLedgerEntry(
            customer_id=input.customer_id,
            pool="paid",
            kind="revoke",
            amount=-revoke_amount,
            unit_price_minor=None,
            currency=None,
            expires_at=None,
            source=_infer_source(input.idempotency_key),
            reference=dataclasses.replace(
                input.reference,
                correlation_id=input.reference.correlation_id or input.correlation_id,
            ),
            idempotency_key=input.idempotency_key,
            actor=input.actor,
            reason=input.reason,
        )
    )

    return ClawbackResult(
        revoked=revoke_amount,
        shortfall=shortfall_amount,
        entry=result.entry,
        duplicated=result.duplicated,
    )
