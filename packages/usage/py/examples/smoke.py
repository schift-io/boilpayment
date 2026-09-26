"""Smoke test -- real code path (no mocks of our own modules), only a fake PaymentProvider.
Run: .venv/bin/python packages/usage/py/examples/smoke.py
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
from datetime import UTC, datetime

from schift_payment_kit_core import (
    DEFAULT_POLICY,
    Customer,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    Period,
    Plan,
    ProviderCapabilities,
    ProviderRef,
    SequentialIdGen,
    Subscription,
)
from schift_payment_kit_usage import (
    UsageEventInput,
    check,
    close_period,
    flush_outbox,
    record,
)

_report_usage_calls = 0
_report_usage_customer_refs: list[str] = []


class FakeProvider:
    """report_usage fails once then succeeds; meters=True so record() enqueues outbox."""

    name = "stripe"

    def capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            native_subscriptions=True,
            partial_refund=True,
            meters=True,
            scheduling="provider",
            webhook_signature=True,
        )

    async def report_usage(
        self, *, meter, customer_ref, quantity, occurred_at, idempotency_key
    ):
        global _report_usage_calls
        _report_usage_calls += 1
        _report_usage_customer_refs.append(customer_ref)
        if _report_usage_calls == 1:
            raise RuntimeError("provider unavailable")


def _to_dict(obj):
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return {f.name: _to_dict(getattr(obj, f.name)) for f in dataclasses.fields(obj)}
    if isinstance(obj, datetime):
        return obj.isoformat()
    return obj


async def main() -> None:
    ids = SequentialIdGen("id_")
    clock = FixedClock(
        datetime(2026, 2, 2, tzinfo=UTC)
    )  # 1 day into the Feb period
    ledger = InMemoryLedger(ids)
    repo = InMemoryRepo()
    provider = FakeProvider()

    policy = dataclasses.replace(
        DEFAULT_POLICY,
        usage=dataclasses.replace(
            DEFAULT_POLICY.usage,
            included_quantity=5,
            overage="hard_block",
            late_report_window_hours=48,
        ),
    )

    sub = Subscription(
        id="sub_1",
        customer_id="cust_1",
        plan_id="plan_pro",
        provider="stripe",
        provider_ref="sub_stripe_1",
        status="active",
        current_period=Period(
            start=datetime(2026, 2, 1, tzinfo=UTC),
            end=datetime(2026, 3, 1, tzinfo=UTC),
        ),
        anchor_day=1,
        cancel_at_period_end=False,
        grace_until=None,
        billing_key=None,
        scheduled_plan_id=None,
        created_at=datetime(2026, 1, 1, tzinfo=UTC),
    )

    # EC:C2 (plan-aware attribution) -- monthly plan, so period_containing(sub.created_at, 'month', ...) applies.
    plan = Plan(
        id="plan_pro",
        name="Pro",
        interval="month",
        credits_per_period=0,
        usage_included=5,
        trial_days=0,
        prices=[],
    )

    # -- EC:C2 -- on-time event, provider passed so it enqueues the one outbox item this smoke uses --
    r1 = await record(
        event=UsageEventInput(
            customer_id=sub.customer_id,
            meter="api_call",
            quantity=3,
            occurred_at=datetime(2026, 2, 2, tzinfo=UTC),
            idempotency_key="evt_1",
        ),
        sub=sub,
        policy=policy,
        repo=repo,
        clock=clock,
        ids=ids,
        provider=provider,
    )
    print(
        "record #1 (on-time, qty=3):", r1.duplicated, r1.event.period_start.isoformat()
    )

    # -- EC:C2 -- late report WITHIN window, no `plan` -> length-approximation previous period --
    r2_approx = await record(
        event=UsageEventInput(
            customer_id=sub.customer_id,
            meter="api_call",
            quantity=2,
            occurred_at=datetime(2026, 1, 30, tzinfo=UTC),
            idempotency_key="evt_2a",
        ),
        sub=sub,
        policy=policy,
        repo=repo,
        clock=clock,
        ids=ids,
    )
    print(
        "record #2a (late, within window, no plan -> approximation):",
        r2_approx.event.period_start.isoformat(),
    )

    # -- EC:C2 -- same late report WITH `plan` -> exact period_containing(sub.created_at, plan.interval, ...) --
    # sub.created_at=2026-01-01, interval='month' -> the period containing 2026-01-30 is [2026-01-01, 2026-02-01), so .start = Jan 1 exactly (vs the ~Jan 4 approximation above).
    r2_exact = await record(
        event=UsageEventInput(
            customer_id=sub.customer_id,
            meter="api_call",
            quantity=2,
            occurred_at=datetime(2026, 1, 30, tzinfo=UTC),
            idempotency_key="evt_2b",
        ),
        sub=sub,
        policy=policy,
        repo=repo,
        clock=clock,
        ids=ids,
        plan=plan,
    )
    print(
        "record #2b (late, within window, WITH plan -> exact):",
        r2_exact.event.period_start.isoformat(),
        "(exact Jan 1, vs approximation above)",
    )

    # -- EC:C2 -- late report OUTSIDE window (clock advances past 48h) -> attributed to current period --
    clock.advance(9 * 24 * 60 * 60 * 1000)  # now 10 days into the period
    r3 = await record(
        event=UsageEventInput(
            customer_id=sub.customer_id,
            meter="api_call",
            quantity=4,
            occurred_at=datetime(2026, 1, 25, tzinfo=UTC),
            idempotency_key="evt_3",
        ),
        sub=sub,
        policy=policy,
        repo=repo,
        clock=clock,
        ids=ids,
    )
    print(
        "record #3 (late, outside window, qty=4):",
        r3.event.period_start.isoformat(),
        "(== current period start)",
    )

    # -- EC:C2 -- dedupe by idempotency_key --
    r3dup = await record(
        event=UsageEventInput(
            customer_id=sub.customer_id,
            meter="api_call",
            quantity=4,
            occurred_at=datetime(2026, 1, 25, tzinfo=UTC),
            idempotency_key="evt_3",
        ),
        sub=sub,
        policy=policy,
        repo=repo,
        clock=clock,
        ids=ids,
    )
    print("record #3 dup:", r3dup.duplicated)

    # -- EC:C1 EC:C5 -- check(): current-period total is 3+4=7, already over included=5 --
    check_result = await check(
        customer_id=sub.customer_id,
        meter="api_call",
        quantity=1,
        sub=sub,
        policy=policy,
        repo=repo,
        ledger=ledger,
        clock=clock,
    )
    print("\n[check hard_block]", json.dumps(_to_dict(check_result), indent=2))

    fresh_sub = dataclasses.replace(sub, customer_id="cust_2")
    check_ok = await check(
        customer_id=fresh_sub.customer_id,
        meter="api_call",
        quantity=3,
        sub=fresh_sub,
        policy=policy,
        repo=repo,
        ledger=ledger,
        clock=clock,
    )
    print("[check within_included]", json.dumps(_to_dict(check_ok), indent=2))

    # -- EC:C9 -- close_period aggregate --
    closed = await close_period(
        sub=sub, policy=policy, repo=repo, provider=provider, clock=clock, ids=ids
    )
    print("\n[close_period]", json.dumps(_to_dict(closed), indent=2))

    # -- EC:C4 -- flush_outbox customer_ref resolution --
    # cust_1 has a stripe provider_ref registered; cust_3 (a stray, unlinked customer) does not.
    await repo.customers.put(
        Customer(
            id="cust_1",
            email=None,
            provider_refs=[ProviderRef(provider="stripe", ref="cus_stripe_1")],
            status="active",
            created_at=sub.created_at,
        )
    )
    stray_event = await record(
        event=UsageEventInput(
            customer_id="cust_3",
            meter="api_call",
            quantity=1,
            occurred_at=clock.now(),
            idempotency_key="evt_stray",
        ),
        sub=sub,
        policy=policy,
        repo=repo,
        clock=clock,
        ids=ids,
        provider=provider,
    )
    print("\nrecorded stray event for unlinked customer cust_3:", stray_event.event.id)

    # fails once (attempt 1, cust_1's item), no_provider_ref immediately (cust_3's item, no retry needed)
    flush1 = await flush_outbox(
        repo=repo, providers={"stripe": provider}, clock=clock, max_attempts=8
    )
    print("\n[flush_outbox #1]", json.dumps(_to_dict(flush1)))
    pending_after_1 = await repo.outbox.list(kind="usage.report")
    print(
        "outbox after #1:",
        [
            {
                "status": i.status,
                "attempts": i.attempts,
                "error": i.payload.get("error"),
            }
            for i in pending_after_1
        ],
    )

    clock.advance(70 * 60 * 1000)  # past the 2^1=2min backoff
    flush2 = await flush_outbox(
        repo=repo, providers={"stripe": provider}, clock=clock, max_attempts=8
    )
    print("[flush_outbox #2]", json.dumps(_to_dict(flush2)))
    pending_after_2 = await repo.outbox.list(kind="usage.report")
    print(
        "outbox after #2 (cust_1 item: attempts=2 sent; cust_3 item: unchanged, failed/no_provider_ref):",
        [
            {
                "status": i.status,
                "attempts": i.attempts,
                "error": i.payload.get("error"),
            }
            for i in pending_after_2
        ],
    )
    print(
        "report_usage was called with customer_ref (never the internal customer_id):",
        _report_usage_customer_refs,
    )

    print("\nsmoke: OK")


if __name__ == "__main__":
    asyncio.run(main())
