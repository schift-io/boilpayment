"""Phase 6 regression tests -- packages/webhook/py/src/schift_payment_kit_webhook/receive.py
Ground truth measured via `.venv/bin/python packages/webhook/py/examples/smoke.py` this session.
pytest-asyncio is not installed -- wrap async bodies in asyncio.run()."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime

from _helpers import FakeProvider, json_verify
from schift_payment_kit_core import FixedClock, InMemoryRepo
from schift_payment_kit_webhook import receive


def _setup():
    clock = FixedClock(datetime(2026, 2, 2, tzinfo=UTC))
    repo = InMemoryRepo()
    provider = FakeProvider(verify=json_verify())
    return clock, repo, provider


def test_ec_e4_bad_signature_returns_400_and_stores_nothing():
    async def run():
        clock, repo, provider = _setup()
        raw_body = json.dumps(
            {
                "id": "evt_bad_sig",
                "type": "payment.succeeded",
                "occurredAt": clock.now().isoformat(),
            }
        )

        result = await receive(
            provider=provider,
            headers={"x-sig": "nope"},
            raw_body=raw_body,
            repo=repo,
            clock=clock,
        )

        assert result.status == 400
        assert result.event_id is None
        assert result.duplicated is None
        assert await repo.webhook_events.list() == []

    asyncio.run(run())


def test_ec_e5_good_signature_stores_record_with_status_received_and_returns_200():
    async def run():
        clock, repo, provider = _setup()
        raw_body = json.dumps(
            {
                "id": "evt_good_sig",
                "type": "payment.succeeded",
                "occurredAt": clock.now().isoformat(),
            }
        )

        result = await receive(
            provider=provider,
            headers={"x-sig": "ok"},
            raw_body=raw_body,
            repo=repo,
            clock=clock,
        )

        assert result.status == 200
        assert result.event_id == "evt_good_sig"
        assert result.duplicated is False

        stored = await repo.webhook_events.get("evt_good_sig")
        assert stored is not None
        assert stored.status == "received"
        assert stored.provider == "stripe"
        assert stored.type == "payment.succeeded"
        assert stored.raw_body == raw_body
        assert stored.processed_at is None
        assert stored.error is None
        assert stored.attempts == 0

    asyncio.run(run())


def test_ec_e5_b12_resend_of_identical_event_id_is_a_no_op():
    async def run():
        clock, repo, provider = _setup()
        raw_body = json.dumps(
            {
                "id": "evt_dup",
                "type": "payment.succeeded",
                "occurredAt": clock.now().isoformat(),
            }
        )

        first = await receive(
            provider=provider,
            headers={"x-sig": "ok"},
            raw_body=raw_body,
            repo=repo,
            clock=clock,
        )
        assert first.duplicated is False

        second = await receive(
            provider=provider,
            headers={"x-sig": "ok"},
            raw_body=raw_body,
            repo=repo,
            clock=clock,
        )
        assert second.status == 200
        assert second.event_id == "evt_dup"
        assert second.duplicated is True

        all_records = await repo.webhook_events.list()
        assert len(all_records) == 1
        assert all_records[0].attempts == 0
        assert all_records[0].status == "received"

    asyncio.run(run())


# EC:I9 finding (2026-09-09, cs.timeline) -- WebhookEventRecord now carries customer_id/payment_id/
# subscription_id, resolved by (provider, provider_ref) lookup, so a customer-scoped CS timeline can
# query webhook_events directly.
def test_ec_i9_resolves_customer_id_payment_id_from_local_payment_matched_by_provider_ref():
    async def run():
        from schift_payment_kit_core import Money, Payment

        clock, repo, provider = _setup()
        await repo.payments.put(
            Payment(
                id="pay_local_1",
                customer_id="cus_local_1",
                provider="stripe",
                provider_ref="pi_stripe_1",
                subscription_id=None,
                amount=Money(amount_minor=1000, currency="USD"),
                status="succeeded",
                kind="subscription",
                period=None,
                occurred_at=clock.now(),
                failure=None,
                cash_receipt=None,
            )
        )
        raw_body = json.dumps(
            {
                "id": "evt_with_payment",
                "type": "payment.succeeded",
                "occurredAt": clock.now().isoformat(),
                "paymentRef": "pi_stripe_1",
            }
        )

        await receive(
            provider=provider,
            headers={"x-sig": "ok"},
            raw_body=raw_body,
            repo=repo,
            clock=clock,
        )

        stored = await repo.webhook_events.get("evt_with_payment")
        assert stored.payment_id == "pay_local_1"
        assert stored.customer_id == "cus_local_1"
        assert stored.subscription_id is None

    asyncio.run(run())


def test_ec_i9_leaves_ids_none_when_no_local_row_matches():
    async def run():
        clock, repo, provider = _setup()
        raw_body = json.dumps(
            {
                "id": "evt_no_match",
                "type": "payment.succeeded",
                "occurredAt": clock.now().isoformat(),
                "paymentRef": "pi_unknown",
            }
        )

        await receive(
            provider=provider,
            headers={"x-sig": "ok"},
            raw_body=raw_body,
            repo=repo,
            clock=clock,
        )

        stored = await repo.webhook_events.get("evt_no_match")
        assert stored.payment_id is None
        assert stored.customer_id is None
        assert stored.subscription_id is None

    asyncio.run(run())
