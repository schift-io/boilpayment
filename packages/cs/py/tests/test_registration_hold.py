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


def _held_repo_and_provider(received_at: datetime):
    from boilpayment_core import Customer, Money, Payment
    from boilpayment_core import ProviderRef as CustomerProviderRef

    repo = InMemoryRepo()
    payload = {
        "paymentId": "payment:stripe:pi_1",
        "checkoutId": "cs_1",
        "customerId": "customer",
        "receivedAt": received_at.isoformat(),
    }
    key = "checkout-payment-held:payment:stripe:pi_1"
    held = Operation(
        id=key, key=key, kind="checkout.paymentHeld", payload_hash=hash_payload(payload),
        status="done", result=payload, error=None, created_at=received_at,
        completed_at=received_at, attempts=1,
    )
    payment = Payment(
        id="pi_1", customer_id="", provider="stripe", provider_ref="pi_1", subscription_id=None,
        amount=Money(amount_minor=1000, currency="USD"), status="succeeded", kind="topup",
        period=None, occurred_at=received_at, failure=None,
    )

    class Provider:
        async def list_payments(self, *, customer_ref, since):
            return [payment]

    return repo, held, Customer, CustomerProviderRef, Provider()


def test_ot_09_held_payment_is_left_alone_inside_window_and_opens_one_case_after():
    async def scenario() -> None:
        # Given
        received = datetime(2026, 9, 28, tzinfo=UTC)
        repo, held, Customer, Ref, provider = _held_repo_and_provider(received)
        await repo.operations.put(held)
        await repo.customers.put(Customer(
            id="customer", email=None, provider_refs=[Ref(provider="stripe", ref="cus_1")],
            status="active", created_at=received,
        ))
        ids = SequentialIdGen("hold_")

        def make(clock: FixedClock) -> ReconcileInput:
            return ReconcileInput(
                providers={"stripe": provider}, ledger=InMemoryLedger(ids), repo=repo,
                policy=resolve_policy(), clock=clock, ids=ids, since=received,
            )

        # When / Then -- 23h: nothing
        await reconcile(make(FixedClock(datetime(2026, 9, 28, 23, tzinfo=UTC))))
        assert await repo.cs_cases.list() == []

        # 25h and again: exactly one case, and no regrant
        later = make(FixedClock(datetime(2026, 9, 29, 1, tzinfo=UTC)))
        await reconcile(later)
        await reconcile(later)
        cases = await repo.cs_cases.list()
        assert len(cases) == 1
        assert cases[0].kind == "reconcile_mismatch" and cases[0].status == "needs_human"

    anyio.run(scenario)
