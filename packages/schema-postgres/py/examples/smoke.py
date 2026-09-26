"""Runs the real Postgres-backed code path once against a live local database.

Usage:
  PAYKIT_SMOKE_DB=paykit_smoke_XXXXX .venv/bin/python packages/schema-postgres/py/examples/smoke.py
"""

from __future__ import annotations

import asyncio
import os
from datetime import UTC, datetime, timedelta

import psycopg
from boilpayment_core import (
    DEFAULT_POLICY,
    ConsumeInput,
    CsCase,
    Customer,
    LedgerReference,
    NewLedgerEntry,
    Period,
    Plan,
    PlanPrice,
    Subscription,
)
from boilpayment_schema_postgres import (
    PostgresLedgerStore,
    PostgresRepo,
    consistency_check,
    migrate,
)


async def main() -> None:
    db_name = os.environ["PAYKIT_SMOKE_DB"]
    dsn = f"dbname={db_name}"

    print("== migrate ==")
    result = await migrate(
        conninfo=dsn, modules=["core", "credits", "usage", "webhook", "refund", "cs"]
    )
    print("applied:", result["applied"])

    ledger = PostgresLedgerStore(dsn)
    repo = PostgresRepo(dsn)

    customer_id = "cust_py_smoke_1"
    await repo.customers.put(
        Customer(
            id=customer_id,
            email="py@smoke.test",
            provider_refs=[],
            status="active",
            created_at=datetime.now(UTC),
        )
    )
    print("== customer created ==", customer_id)

    now = datetime.now(UTC)
    in_30d = now + timedelta(days=30)

    print("== grant 100 paid + 50 promo ==")
    g1 = await ledger.append(
        NewLedgerEntry(
            customer_id=customer_id,
            pool="paid",
            kind="grant",
            amount=100,
            unit_price_minor=10,
            currency="USD",
            expires_at=in_30d,
            source="subscription",
            reference=LedgerReference(subscription_id="sub_py_1", period_start=now),
            idempotency_key="grant:sub_py_1:p1",
            actor="system",
        )
    )
    g2 = await ledger.append(
        NewLedgerEntry(
            customer_id=customer_id,
            pool="promo",
            kind="grant",
            amount=50,
            unit_price_minor=0,
            currency="USD",
            expires_at=in_30d,
            source="promo",
            reference=LedgerReference(),
            idempotency_key="grant:promo:py1",
            actor="system",
        )
    )
    assert g1.duplicated is False
    assert g2.duplicated is False
    print("grants ok:", g1.entry.id, g2.entry.id)

    print("== consume 120 pool_order [promo, paid] ==")
    consume_key = "consume:py:req1"
    c1 = await ledger.consume(
        ConsumeInput(
            customer_id=customer_id,
            pool_order=["promo", "paid"],
            amount=120,
            idempotency_key=consume_key,
            meta=LedgerReference(),
            now=now,
            negative_balance="block",
            negative_floor=0,
            reason="smoke test",
            actor="app",
        )
    )
    assert c1.ok is True
    assert c1.shortfall == 0
    assert len(c1.entries) == 2, (
        "expected 2 consume rows (promo bucket then paid bucket)"
    )
    promo_row = next(e for e in c1.entries if e.pool == "promo")
    paid_row = next(e for e in c1.entries if e.pool == "paid")
    assert promo_row.amount == -50
    assert paid_row.amount == -70
    assert promo_row.reference.grant_id == g2.entry.id
    assert paid_row.reference.grant_id == g1.entry.id
    print("consume ok: promo -50, paid -70, grant_id tagging correct")

    bal_after_consume = await ledger.balance(customer_id, None, now)
    print("balance after consume:", bal_after_consume)
    assert bal_after_consume.available == 30, "paid 100-70 + promo 50-50 = 30"
    assert len(bal_after_consume.expiring) == 1, (
        "promo grant is fully consumed (remaining 0) and must not appear in expiring"
    )
    assert bal_after_consume.expiring[0].amount == 30, (
        "only the paid grant remainder (30) should be in expiring"
    )

    print("== duplicate idempotency key ==")
    c1dup = await ledger.consume(
        ConsumeInput(
            customer_id=customer_id,
            pool_order=["promo", "paid"],
            amount=120,
            idempotency_key=consume_key,
            meta=LedgerReference(),
            now=now,
            negative_balance="block",
            negative_floor=0,
            reason="smoke test",
            actor="app",
        )
    )
    assert c1dup.duplicated is True
    assert len(c1dup.entries) == 2
    print("duplicate consume ok: duplicated=True, same 2 rows returned")

    print("== attempt UPDATE on ledger_entries (must be rejected by trigger) ==")
    conn = await psycopg.AsyncConnection.connect(dsn, autocommit=True)
    try:
        async with conn.cursor() as cur:
            await cur.execute(
                "update ledger_entries set amount = 999999 where id = %s",
                (paid_row.id,),
            )
        raise AssertionError("expected UPDATE to be rejected but it succeeded")
    except psycopg.errors.IntegrityConstraintViolation as e:
        msg = str(e)
        assert "append-only" in msg, f"expected append-only rejection, got: {msg}"
        print("UPDATE correctly rejected:", msg.splitlines()[0])
    finally:
        await conn.close()

    print("== block policy overshoot ==")
    overshoot = await ledger.consume(
        ConsumeInput(
            customer_id=customer_id,
            pool_order=["promo", "paid"],
            amount=1000,
            idempotency_key="consume:py:overshoot",
            meta=LedgerReference(),
            now=now,
            negative_balance="block",
            negative_floor=0,
        )
    )
    assert overshoot.ok is False
    assert len(overshoot.entries) == 0
    assert overshoot.shortfall == 970
    bal_after_overshoot = await ledger.balance(customer_id, None, now)
    assert bal_after_overshoot.available == 30, "overshoot must not write any rows"
    print(
        "overshoot correctly blocked: ok=False, shortfall=970, no rows written, balance unchanged"
    )

    print("== consistency_check ==")
    mismatches = await consistency_check(dsn)
    mine = [m for m in mismatches if m.customer_id == customer_id]
    assert len(mine) == 0, f"expected 0 mismatches for {customer_id}, got {mine}"
    print(
        f"consistency_check ok: 0 mismatches for {customer_id} (total mismatches in db: {len(mismatches)})"
    )

    print("== PgTable roundtrip: plans + plan_prices ==")
    plan = Plan(
        id="plan_py_pro",
        name="Pro (py smoke)",
        interval="month",
        credits_per_period=100,
        usage_included=0,
        trial_days=7,
        prices=[
            PlanPrice(currency="USD", amount_minor=2900),
            PlanPrice(currency="KRW", amount_minor=39000),
        ],
    )
    await repo.plans.put(plan)
    plan_back = await repo.plans.get("plan_py_pro")
    assert plan_back is not None
    assert len(plan_back.prices) == 2
    print("plan roundtrip ok:", plan_back.name, plan_back.prices)

    print("== PgTable roundtrip: subscriptions (Period) ==")
    sub = Subscription(
        id="sub_py_smoke_1",
        customer_id=customer_id,
        plan_id=plan.id,
        provider="stripe",
        provider_ref="sub_ref_py_1",
        status="active",
        current_period=Period(start=now, end=in_30d),
        anchor_day=now.day,
        cancel_at_period_end=False,
        grace_until=None,
        billing_key=None,
        scheduled_plan_id=None,
        created_at=now,
    )
    await repo.subscriptions.put(sub)
    sub_back = await repo.subscriptions.get(sub.id)
    assert sub_back is not None
    assert sub_back.current_period.start == now
    assert sub_back.current_period.end == in_30d
    print("subscription roundtrip ok:", sub_back.id, sub_back.current_period)

    print("== PgTable roundtrip: cs_cases + policy_snapshots dedup ==")
    cs_case = CsCase(
        id="cs_py_smoke_1",
        customer_id=customer_id,
        kind="reconcile_mismatch",
        status="open",
        reference_id="ref1",
        policy_snapshot=DEFAULT_POLICY,
        decision=None,
        churn_reason=None,
        churn_text=None,
        opened_at=now,
        resolved_at=None,
    )
    await repo.cs_cases.put(cs_case)
    cs_back = await repo.cs_cases.get(cs_case.id)
    assert cs_back is not None
    assert cs_back.policy_snapshot.upgrade.mode == DEFAULT_POLICY.upgrade.mode
    print(
        "cs_case roundtrip ok:",
        cs_back.id,
        "policy_snapshot.upgrade.mode =",
        cs_back.policy_snapshot.upgrade.mode,
    )

    print("\nALL SMOKE CHECKS PASSED")


if __name__ == "__main__":
    asyncio.run(main())
