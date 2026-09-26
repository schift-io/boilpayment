"""Real code path smoke test for InMemoryLedger + period math.
Mirrors packages/core/ts/examples/smoke.ts exactly -- same operations, same printed numbers.
Run: .venv/bin/python packages/core/py/examples/smoke.py
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta

from boilpayment_core import (
    ConsumeInput,
    FixedClock,
    InMemoryLedger,
    LedgerReference,
    NewLedgerEntry,
    Period,
    SequentialIdGen,
    next_period,
    proration_ratio,
)


def log(label: str, value: object) -> None:
    print(f"{label} {json.dumps(value)}")


async def main() -> None:
    clock = FixedClock(datetime(2026, 1, 1, tzinfo=UTC))
    ledger = InMemoryLedger(SequentialIdGen("led_"))
    customer_id = "cust_1"

    # grant 100 paid, expiring 30d from now
    expires_at = clock.now() + timedelta(days=30)
    await ledger.append(
        NewLedgerEntry(
            customer_id=customer_id,
            pool="paid",
            kind="grant",
            amount=100,
            unit_price_minor=1000,
            currency="USD",
            expires_at=expires_at,
            source="subscription",
            reference=LedgerReference(
                subscription_id="sub_1", period_start=clock.now()
            ),
            idempotency_key="grant:sub_1:2026-01-01",
            actor="system",
            reason=None,
        )
    )

    # grant 50 promo, no expiry
    await ledger.append(
        NewLedgerEntry(
            customer_id=customer_id,
            pool="promo",
            kind="grant",
            amount=50,
            source="promo",
            reference=LedgerReference(),
            idempotency_key="grant:promo:welcome",
            actor="system",
            reason="welcome bonus",
        )
    )

    bal_before_consume = await ledger.balance(customer_id, None, clock.now())
    log(
        "balance_after_grants",
        {"available": bal_before_consume.available, "held": bal_before_consume.held},
    )

    # consume 120 with pool_order [promo, paid] -> drains promo (50) then paid (70 of 100)
    consume_input = ConsumeInput(
        customer_id=customer_id,
        pool_order=["promo", "paid"],
        amount=120,
        idempotency_key="consume:req-1",
        meta=LedgerReference(),
        now=clock.now(),
        negative_balance="block",
        negative_floor=0,
        reason="test usage",
        actor="test",
    )
    res1 = await ledger.consume(consume_input)
    log(
        "consume_120",
        {
            "ok": res1.ok,
            "shortfall": res1.shortfall,
            "duplicated": res1.duplicated,
            "entries": [
                {"pool": e.pool, "amount": e.amount, "grantId": e.reference.grant_id}
                for e in res1.entries
            ],
        },
    )

    bal_after_consume = await ledger.balance(customer_id, None, clock.now())
    log(
        "balance_after_consume",
        {
            "available": bal_after_consume.available,
            "held": bal_after_consume.held,
            "expiring": [
                {
                    "expiresAt": b.expires_at.isoformat().replace("+00:00", ".000Z"),
                    "amount": b.amount,
                }
                for b in bal_after_consume.expiring
            ],
        },
    )

    # consume overshoot under negative_balance='block' -> ok=false, no entries written
    overshoot_input = ConsumeInput(
        customer_id=customer_id,
        pool_order=["promo", "paid"],
        amount=1000,
        idempotency_key="consume:req-2",
        meta=LedgerReference(),
        now=clock.now(),
        negative_balance="block",
        negative_floor=0,
        reason="overshoot",
        actor="test",
    )
    res2 = await ledger.consume(overshoot_input)
    log(
        "consume_overshoot_block",
        {"ok": res2.ok, "shortfall": res2.shortfall, "entryCount": len(res2.entries)},
    )

    # duplicate idempotency key -> duplicated=true, same result as res1
    res1dup = await ledger.consume(consume_input)
    log(
        "consume_120_duplicate",
        {
            "duplicated": res1dup.duplicated,
            "ok": res1dup.ok,
            "sameEntryCount": len(res1dup.entries) == len(res1.entries),
        },
    )

    # EC:G1 next_period: 2026-01-31 monthly anchor 31 -> 2026-02-28 -> 2026-03-31
    p0 = Period(
        start=datetime(2026, 1, 1, tzinfo=UTC),
        end=datetime(2026, 1, 31, tzinfo=UTC),
    )
    p1 = next_period(p0, "month", 31, "UTC", "clamp_keep_original_day")
    p2 = next_period(p1, "month", 31, "UTC", "clamp_keep_original_day")

    def iso(dt: datetime) -> str:
        return dt.astimezone(UTC).isoformat().replace("+00:00", ".000Z")

    log("next_period_step1", {"start": iso(p1.start), "end": iso(p1.end)})
    log("next_period_step2", {"start": iso(p2.start), "end": iso(p2.end)})

    # EC:G2 proration_ratio mid-period (15 of 30 days elapsed -> 0.5 remaining)
    period = Period(
        start=datetime(2026, 3, 1, tzinfo=UTC),
        end=datetime(2026, 3, 31, tzinfo=UTC),
    )
    mid = datetime(2026, 3, 16, tzinfo=UTC)
    ratio = proration_ratio(period, mid, "actual_days_in_period")
    log("proration_ratio_mid_period", {"ratio": ratio})


if __name__ == "__main__":
    asyncio.run(main())
