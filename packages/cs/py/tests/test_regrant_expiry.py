"""EC:B19 -- a regrant without plan.expires_at takes policy.credits.expiry_days.regrant from the case
snapshot; an explicit plan expiry wins. Mirrors the last test in ts/test/regrant.test.ts."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

from boilpayment_core import (
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    SequentialIdGen,
    resolve_policy,
)
from boilpayment_cs import OpenCaseInput, RegrantInput, RegrantPlan, open_case, regrant


def test_regrant_uses_case_policy_regrant_expiry():
    async def body():
        clock = FixedClock(datetime(2026, 3, 1, tzinfo=UTC))
        ids = SequentialIdGen("exp_")
        repo, ledger = InMemoryRepo(), InMemoryLedger(ids)

        async def run(policy, customer, ref, plan):
            case = await open_case(
                OpenCaseInput(customer_id=customer, kind="regrant", reference_id=ref, policy=policy, repo=repo, clock=clock, ids=ids)
            )
            await regrant(RegrantInput(case=case, ledger=ledger, repo=repo, policy=policy, clock=clock, ids=ids, plan=plan))

        policy = resolve_policy({"cs": {"regrant": {"mode": "auto"}}, "credits": {"expiryDays": {"regrant": 30}}})
        await run(policy, "e", "r1", RegrantPlan(pool="paid", amount=10))
        explicit = datetime(2026, 3, 5, tzinfo=UTC)
        await run(policy, "e", "r2", RegrantPlan(pool="paid", amount=5, expires_at=explicit))
        a, b = await ledger.entries("e", kind="grant")
        assert a.expires_at == clock.now() + timedelta(days=30)
        assert b.expires_at == explicit
        await run(resolve_policy({"cs": {"regrant": {"mode": "auto"}}}), "f", "r3", RegrantPlan(pool="paid", amount=1))
        assert (await ledger.entries("f", kind="grant"))[0].expires_at is None

    asyncio.run(body())
