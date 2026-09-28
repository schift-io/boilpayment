"""spec: packages/credits/spec/credits.pseudo.md — EC:B14"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field

from boilpayment_core import (
    Clock,
    LedgerEntry,
    LedgerStore,
    NewLedgerEntry,
    effective_grant_expiry,
)


@dataclass(kw_only=True, slots=True)
class ExpireDueInput:
    ledger: LedgerStore
    clock: Clock
    customer_id: str


@dataclass(kw_only=True, slots=True)
class ExpireDueResult:
    entries: list[LedgerEntry] = field(default_factory=list)


# EC:B14 — writes bookkeeping 'expire' entries for grants whose expires_at <= now. Balances are
# already computed excluding these (ledger.consume/balance filter by expires_at > now); this is a
# cleanup batch, not a balance-affecting operation.
async def expire_due(input: ExpireDueInput) -> ExpireDueResult:
    async def run() -> ExpireDueResult:
        now = input.clock.now()
        all_entries = await input.ledger.entries(input.customer_id)
        # SB-07 -- decide under the customer ledger lock so dunning cannot extend after this read
        # but before the expiry debit.
        due_grants = [
            e
            for e in all_entries
            if e.kind == "grant"
            and (expires_at := effective_grant_expiry(e, all_entries)) is not None
            and expires_at <= now
        ]

        entries: list[LedgerEntry] = []
        for g in due_grants:
            used = sum(
                e.amount
                for e in all_entries
                if e.kind in ("consume", "revoke") and e.reference.grant_id == g.id
            )
            remaining = max(0, g.amount + used)
            if remaining <= 0:
                continue

            result = await input.ledger.append(
                NewLedgerEntry(
                    customer_id=input.customer_id,
                    pool=g.pool,
                    kind="expire",
                    amount=-remaining,
                    unit_price_minor=g.unit_price_minor,
                    currency=g.currency,
                    expires_at=None,
                    source=g.source,
                    reference=dataclasses.replace(g.reference, grant_id=g.id),
                    idempotency_key=f"expire:{g.id}",
                    actor="system",
                    reason=None,
                )
            )
            entries.append(result.entry)
        return ExpireDueResult(entries=entries)

    return await input.ledger.transaction(input.customer_id, run)
