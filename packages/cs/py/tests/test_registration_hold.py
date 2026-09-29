from datetime import UTC, datetime

import anyio
from boilpayment_core import (
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    Operation,
    SequentialIdGen,
    hash_payload,
    resolve_policy,
)
from boilpayment_cs import ReconcileInput, reconcile


def test_ot_09_escalates_expired_unregistered_payment_hold_exactly_once():
    async def scenario() -> None:
        # Given
        clock = FixedClock(datetime(2026, 9, 29, 1, tzinfo=UTC))
        ids = SequentialIdGen("hold_")
        repo = InMemoryRepo()
        payload = {
            "paymentId": "payment:stripe:pi_1",
            "checkoutId": "cs_1",
            "customerId": "customer",
            "receivedAt": "2026-09-28T00:00:00+00:00",
        }
        created_at = datetime.fromisoformat(payload["receivedAt"])
        await repo.operations.put(Operation(
            id="checkout-payment-held:payment:stripe:pi_1",
            key="checkout-payment-held:payment:stripe:pi_1",
            kind="checkout.paymentHeld",
            payload_hash=hash_payload(payload),
            status="done",
            result=payload,
            error=None,
            created_at=created_at,
            completed_at=created_at,
            attempts=1,
        ))
        input = ReconcileInput(
            providers={}, ledger=InMemoryLedger(ids), repo=repo, policy=resolve_policy(), clock=clock, ids=ids,
            since=datetime(2026, 9, 28, tzinfo=UTC),
        )

        # When
        await reconcile(input)
        await reconcile(input)

        # Then
        cases = await repo.cs_cases.list(kind="reconcile_mismatch", reference_id=payload["paymentId"])
        assert len(cases) == 1

    anyio.run(scenario)
