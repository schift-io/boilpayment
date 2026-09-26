"""spec: packages/credits/spec/credits.pseudo.md [EC:B3] [EC:L5]

EC:L5 -- asserted against a spy LedgerStore rather than InMemoryLedger: InMemoryLedger.consume()
(packages/core, owned by another agent, not touched here) rebuilds each written entry's
`reference` from a fixed field whitelist (subscription_id/period_start/payment_id/case_id/
refund_id/grant_id) and does NOT copy `meta.correlation_id` through -- so a real end-to-end
assertion against InMemoryLedger.entries() would fail even though credits.consume() itself
threads correlation_id correctly into the `ConsumeInput.meta` it hands to `ledger.consume()`.
See final report "계약 변경 제안". `append()`-based operations (grant/topup/clawback/regrant/
dispute/refund) are unaffected -- InMemoryLedger.append() stores whatever `reference` it is
given verbatim. Mirrors packages/credits/ts/test/consume.test.ts.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import UTC, datetime

from schift_payment_kit_core import (
    ConsumeInput,
    ConsumeResult,
    FixedClock,
    LedgerReference,
    resolve_policy,
)
from schift_payment_kit_credits import ConsumeCreditsInput, consume

CLOCK = FixedClock(datetime(2024, 1, 1, tzinfo=UTC))


def run(coro):
    return asyncio.run(coro)


@dataclass
class SpyLedger:
    calls: list[ConsumeInput] = field(default_factory=list)

    async def append(self, entry):
        raise NotImplementedError("unused: append")

    async def balance(self, customer_id, pool, now):
        raise NotImplementedError("unused: balance")

    async def entries(self, customer_id, **kwargs):
        raise NotImplementedError("unused: entries")

    async def consume(self, input: ConsumeInput) -> ConsumeResult:
        self.calls.append(input)
        return ConsumeResult(ok=True, entries=[], shortfall=0, duplicated=False)

    async def transaction(self, customer_id, fn):
        return await fn()


def test_ec_l5_consume_threads_correlation_id_into_meta_on_the_consume_input():
    async def scenario():
        ledger = SpyLedger()
        await consume(
            ConsumeCreditsInput(
                customer_id="cust_1",
                amount=40,
                policy=resolve_policy(),
                ledger=ledger,
                clock=CLOCK,
                idempotency_key="consume:1",
                correlation_id="corr_consume_1",
            )
        )
        assert len(ledger.calls) == 1
        assert ledger.calls[0].meta.correlation_id == "corr_consume_1"

    run(scenario())


def test_ec_l5_does_not_overwrite_correlation_id_already_set_on_reference():
    async def scenario():
        ledger = SpyLedger()
        await consume(
            ConsumeCreditsInput(
                customer_id="cust_1",
                amount=40,
                policy=resolve_policy(),
                ledger=ledger,
                clock=CLOCK,
                idempotency_key="consume:2",
                reference=LedgerReference(correlation_id="from_reference"),
                correlation_id="from_param",
            )
        )
        assert ledger.calls[0].meta.correlation_id == "from_reference"

    run(scenario())


def test_ec_l5_no_correlation_id_leaves_meta_correlation_id_none():
    async def scenario():
        ledger = SpyLedger()
        await consume(
            ConsumeCreditsInput(
                customer_id="cust_1",
                amount=40,
                policy=resolve_policy(),
                ledger=ledger,
                clock=CLOCK,
                idempotency_key="consume:3",
            )
        )
        assert ledger.calls[0].meta.correlation_id is None

    run(scenario())
