"""EC:L5 -- see spec/webhook.pseudo.md [EC:L5]. Mirrors ts/src/correlation.ts exactly.

Two small helpers that thread one webhook delivery's correlation_id through the rest of the
pipeline WITHOUT touching the `PaymentProvider` Protocol or the lifecycle/credits/refund/cs
packages' own call signatures:
  - `mint_correlation_id(provider_event_id)` -- deterministic, so a redelivery of the same event
    produces the same id (EC:E5 dedupe already relies on the event id being stable; reusing it for
    correlation_id keeps replay-safety free).
  - `with_correlation_id(ledger, id)` -- wraps a `LedgerStore` so every `.append()`/`.consume()`
    call made THROUGH this wrapper (by lifecycle/credits/refund/cs, which webhook's own
    default_handlers() constructs deps for) gets `correlation_id` merged into the entry's
    `reference`/`meta` -- without lifecycle/credits/refund/cs ever knowing correlation_id exists.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from schift_payment_kit_core import LedgerStore


def mint_correlation_id(provider_event_id: str) -> str:
    """EC:L5 -- `corr_{provider_event_id}`. Deterministic across redeliveries of the same event."""
    return f"corr_{provider_event_id}"


@dataclass(slots=True)
class _CorrelatedLedger:
    """EC:L5 -- see module docstring above. Never overwrites a correlation_id a caller already set."""

    _ledger: LedgerStore
    _correlation_id: str

    async def append(self, entry):
        reference = entry.reference
        if reference.correlation_id is None:
            entry = replace(
                entry, reference=replace(reference, correlation_id=self._correlation_id)
            )
        return await self._ledger.append(entry)

    async def balance(self, customer_id, pool, now):
        return await self._ledger.balance(customer_id, pool, now)

    async def entries(self, customer_id, **kwargs):
        return await self._ledger.entries(customer_id, **kwargs)

    async def consume(self, input):
        if input.meta.correlation_id is None:
            input = replace(
                input, meta=replace(input.meta, correlation_id=self._correlation_id)
            )
        return await self._ledger.consume(input)

    async def transaction(self, customer_id, fn):
        return await self._ledger.transaction(customer_id, fn)


def with_correlation_id(ledger: LedgerStore, correlation_id: str) -> LedgerStore:
    return _CorrelatedLedger(ledger, correlation_id)  # type: ignore[return-value]
