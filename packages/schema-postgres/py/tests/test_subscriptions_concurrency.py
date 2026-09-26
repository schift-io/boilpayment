"""[EC:K1] optimistic lock on `subscriptions` -- an upgrade racing a renewal webhook (or any two
independent writers) must not silently lose one of the two writes. `PostgresRepo.subscriptions.put`
enforces the same contract as `VersionedMemTable` (schift_payment_kit_core.memory).

pytest-asyncio is not installed -> every test wraps its async body with asyncio.run().
"""

from __future__ import annotations

import asyncio
import dataclasses
import uuid
from datetime import UTC, datetime, timedelta

from db_helper import create_test_db, drop_test_db
from schift_payment_kit_core import (
    Customer,
    PaymentKitError,
    Period,
    Plan,
    Subscription,
)
from schift_payment_kit_schema_postgres import PostgresRepo


async def _seed_plan(repo: PostgresRepo) -> None:
    await repo.plans.put(
        Plan(
            id="plan_a",
            name="A",
            interval="month",
            credits_per_period=100,
            usage_included=0,
            trial_days=0,
            prices=[],
        )
    )


def _mk_sub(*, id: str, customer_id: str, provider_ref: str) -> Subscription:
    start = datetime(2024, 1, 1, tzinfo=UTC)
    return Subscription(
        id=id,
        customer_id=customer_id,
        plan_id="plan_a",
        provider="stripe",
        provider_ref=provider_ref,
        status="active",
        current_period=Period(start=start, end=start + timedelta(days=31)),
        anchor_day=1,
        cancel_at_period_end=False,
        grace_until=None,
        billing_key=None,
        scheduled_plan_id=None,
        version=0,
        created_at=start,
    )


def test_two_independent_reads_racing_exactly_one_succeeds():
    async def run():
        db = await create_test_db("py_subconcur")
        try:
            repo = PostgresRepo(db.dsn)
            customer_id = f"cust_{uuid.uuid4()}"
            sub_id = f"sub_{uuid.uuid4()}"
            await repo.customers.put(
                Customer(
                    id=customer_id,
                    email=None,
                    provider_refs=[],
                    status="active",
                    created_at=datetime.now(UTC),
                )
            )
            await _seed_plan(repo)
            await repo.subscriptions.put(
                _mk_sub(
                    id=sub_id, customer_id=customer_id, provider_ref=f"pref_{sub_id}"
                )
            )

            # Two independent handles: each reads its own copy of the row (simulating an upgrade
            # handler and a renewal webhook both loading the subscription before either writes back).
            handle_a = await repo.subscriptions.get(sub_id)
            handle_b = await repo.subscriptions.get(sub_id)
            assert handle_a is not None
            assert handle_b is not None
            assert handle_a.version == handle_b.version

            write_a = repo.subscriptions.put(
                dataclasses.replace(handle_a, status="past_due")
            )
            write_b = repo.subscriptions.put(
                dataclasses.replace(handle_b, status="canceled")
            )

            results = await asyncio.gather(write_a, write_b, return_exceptions=True)
            fulfilled = [r for r in results if not isinstance(r, BaseException)]
            rejected = [r for r in results if isinstance(r, BaseException)]
            assert len(fulfilled) == 1
            assert len(rejected) == 1

            rejection = rejected[0]
            assert isinstance(rejection, PaymentKitError)
            assert rejection.code == "subscription_version_conflict"
            assert rejection.details["expected"] == handle_a.version + 1
            assert rejection.details["got"] == handle_a.version

            final = await repo.subscriptions.get(sub_id)
            assert final is not None
            assert final.version == handle_a.version + 1
            assert final.status in ("past_due", "canceled")
        finally:
            await drop_test_db(db)

    asyncio.run(run())


def test_same_object_read_once_write_twice_still_succeeds():
    async def run():
        db = await create_test_db("py_subconcur2")
        try:
            repo = PostgresRepo(db.dsn)
            customer_id = f"cust_{uuid.uuid4()}"
            sub_id = f"sub_{uuid.uuid4()}"
            await repo.customers.put(
                Customer(
                    id=customer_id,
                    email=None,
                    provider_refs=[],
                    status="active",
                    created_at=datetime.now(UTC),
                )
            )
            sub = _mk_sub(
                id=sub_id, customer_id=customer_id, provider_ref=f"pref_{sub_id}"
            )

            await _seed_plan(repo)
            await repo.subscriptions.put(sub)  # insert -- version stored as given (0)
            assert sub.version == 0

            sub.status = "past_due"
            first = await repo.subscriptions.put(
                sub
            )  # update: 0 -> 1, bumps sub.version in place
            assert first.version == 1
            assert sub.version == 1

            sub.status = "canceled"
            second = await repo.subscriptions.put(
                sub
            )  # same object handle, second write: 1 -> 2
            assert second.version == 2
            assert second.status == "canceled"
            assert sub.version == 2
        finally:
            await drop_test_db(db)

    asyncio.run(run())
