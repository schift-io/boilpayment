"""cs.refundAssist's resolve() (packages/cs/py/src/schift_payment_kit_cs/refund_assist.py) stores
`CsCase.decision = {"decision": RefundDecision(...), "refund": Refund(...)}` -- nested dataclass
instances, and `Refund` carries `created_at: datetime`. On Postgres, `CsCasesTable.put` wraps
`cs.decision` with the `jsonb()` helper (psycopg `Jsonb`), which serializes via plain `json.dumps`
-- that can serialize neither a raw dataclass instance nor a `datetime`. This reproduces the
failure against a real throwaway DB (not a mock), then (once fixed) proves the round-trip works
and that InMemoryRepo's behavior is unchanged.

pytest-asyncio is not installed -> every test wraps its async body with asyncio.run().
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from db_helper import create_test_db, drop_test_db
from schift_payment_kit_core import (
    DEFAULT_POLICY,
    CsCase,
    Customer,
    InMemoryRepo,
    Money,
    Refund,
    RefundDecision,
)
from schift_payment_kit_schema_postgres import PostgresRepo


def _mk_decision(payment_id: str = "pay_1", customer_id: str = "cust_1") -> dict:
    decision = RefundDecision(
        eligible=True,
        amount=Money(amount_minor=1000, currency="USD"),
        credits_to_revoke=10,
        rule_id="D1",
        reason="no_questions_window",
        needs_human=False,
        payment_id=payment_id,
        customer_id=customer_id,
        subscription_id=None,
    )
    refund = Refund(
        id="refund_1",
        payment_id=payment_id,
        customer_id=customer_id,
        amount=Money(amount_minor=1000, currency="USD"),
        status="succeeded",
        provider_ref="re_1",
        credits_revoked=10,
        rule_id="D1",
        reason=None,
        failure=None,
        created_at=datetime(
            2026, 1, 1, tzinfo=UTC
        ),  # the datetime json.dumps chokes on
    )
    return {"decision": decision, "refund": refund}


def _mk_case(decision: dict) -> CsCase:
    now = datetime(2026, 1, 1, tzinfo=UTC)
    return CsCase(
        id="case_decision_ser_1",
        customer_id="cust_1",
        kind="refund",
        status="resolved_auto",
        reference_id="pay_1",
        policy_snapshot=DEFAULT_POLICY,
        decision=decision,
        churn_reason=None,
        churn_text=None,
        opened_at=now,
        resolved_at=now,
    )


def test_postgres_cs_cases_put_round_trips_a_decision_with_nested_dataclasses_and_datetimes():
    async def run():
        db = await create_test_db("py_cs_decision_ser")
        try:
            repo = PostgresRepo(db.dsn)
            await repo.customers.put(
                Customer(
                    id="cust_1",
                    email=None,
                    provider_refs=[],
                    status="active",
                    created_at=datetime.now(UTC),
                )
            )
            decision = _mk_decision()
            case = _mk_case(decision)

            # This is the real reproduction: before the fix, this raises (json.dumps can't
            # serialize a RefundDecision/Refund dataclass instance, let alone the datetime nested
            # inside Refund.created_at).
            stored = await repo.cs_cases.put(case)

            assert stored.decision is not None
            back = await repo.cs_cases.get(case.id)
            assert back is not None
            assert back.decision is not None
            # round-tripped through jsonb -> plain dict/str, not the original dataclass instances
            assert back.decision["decision"]["rule_id"] == "D1"
            assert back.decision["refund"]["id"] == "refund_1"
            assert back.decision["refund"]["created_at"] == "2026-01-01T00:00:00+00:00"
        finally:
            await drop_test_db(db)

    asyncio.run(run())


def test_in_memory_repo_cs_cases_put_keeps_the_original_dataclass_instances_unchanged():
    async def run():
        repo = InMemoryRepo()
        decision = _mk_decision()
        case = _mk_case(decision)

        stored = await repo.cs_cases.put(case)
        assert (
            stored.decision is decision
        )  # InMemory does not serialize at all -- unchanged behavior
        assert isinstance(stored.decision["refund"], Refund)
        assert stored.decision["refund"].created_at == datetime(2026, 1, 1, tzinfo=UTC)

    asyncio.run(run())
