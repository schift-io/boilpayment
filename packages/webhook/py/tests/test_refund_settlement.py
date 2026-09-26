"""Actual provider verification and default handlers settle the original refund hold."""

from datetime import UTC, datetime

import anyio
import httpx
import pytest
from _refund_fixtures import Status, delivery, provider_for
from boilpayment_core import (
    DEFAULT_POLICY,
    CollectingNotifier,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    LedgerReference,
    LedgerStore,
    Money,
    NewLedgerEntry,
    NormalizedEvent,
    Payment,
    ProviderName,
    Refund,
    Repo,
    SequentialIdGen,
)
from boilpayment_refund import OnExternalRefundInput, on_external_refund
from boilpayment_webhook import default_handlers, process, receive


@pytest.mark.parametrize("name", ["stripe", "polar", "toss", "portone"])
@pytest.mark.parametrize("status", ["succeeded", "failed", "pending"])
def test_verified_default_handler_settles_original_hold(
    name: ProviderName, status: Status
) -> None:
    async def run() -> None:
        # Given the actual stored pending refund and its approved hold.
        clock = FixedClock(datetime.now(UTC))
        ids = SequentialIdGen("id")
        repo = InMemoryRepo()
        ledger = InMemoryLedger(ids)
        currency = "KRW" if name in ("toss", "portone") else "USD"
        amount = Money(amount_minor=1000, currency=currency)
        await repo.payments.put(
            Payment(
                id="local-payment",
                customer_id="customer",
                provider=name,
                provider_ref="payment-1",
                subscription_id=None,
                amount=amount,
                status="succeeded",
                kind="topup",
                period=None,
                occurred_at=clock.now(),
                failure=None,
            )
        )
        await repo.refunds.put(
            Refund(
                id="local-refund",
                payment_id="local-payment",
                customer_id="customer",
                amount=amount,
                status="pending",
                provider_ref="refund-1",
                credits_revoked=0,
                rule_id="D1",
                reason=None,
                failure=None,
                created_at=clock.now(),
            )
        )
        await ledger.append(
            NewLedgerEntry(
                customer_id="customer",
                pool="paid",
                kind="grant",
                amount=100,
                source="topup",
                reference=LedgerReference(payment_id="local-payment"),
                idempotency_key="grant",
                actor="system",
                unit_price_minor=10,
                currency=currency,
            )
        )
        await ledger.append(
            NewLedgerEntry(
                customer_id="customer",
                pool="paid",
                kind="hold",
                amount=-100,
                source="refund",
                reference=LedgerReference(
                    payment_id="local-payment", refund_id="local-refund"
                ),
                idempotency_key="hold",
                actor="system",
            )
        )

        class Cs:
            async def open_reconcile_mismatch_case(
                self, *, customer_id: str, reference_id: str, reason: str
            ) -> None:
                return None

        class RefundAdapter:
            async def on_external_refund(
                self,
                *,
                event: NormalizedEvent,
                ledger: LedgerStore,
                repo: Repo,
                cs=None,
            ) -> Refund:
                return await on_external_refund(
                    OnExternalRefundInput(
                        event=event,
                        ledger=ledger,
                        repo=repo,
                        cs=Cs(),
                        clock=clock,
                        ids=ids,
                    )
                )

        def response(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "id": "payment-1",
                    "paymentKey": "payment-1",
                    "currency": "KRW",
                    "cancels": [
                        {
                            "transactionKey": "refund-1",
                            "cancelAmount": 1000,
                            "cancelStatus": "DONE"
                            if status == "succeeded"
                            else "PENDING",
                            "canceledAt": clock.now().isoformat(),
                        }
                    ],
                    "cancellations": [
                        {
                            "id": "refund-1",
                            "status": "SUCCEEDED"
                            if status == "succeeded"
                            else "FAILED"
                            if status == "failed"
                            else "REQUESTED",
                            "totalAmount": 1000,
                            "cancelledAt": clock.now().isoformat(),
                        }
                    ],
                },
            )

        async with httpx.AsyncClient(
            transport=httpx.MockTransport(response), base_url="https://fixture.invalid"
        ) as client:
            provider = provider_for(name, client)
            handlers = default_handlers(
                policy=DEFAULT_POLICY,
                ledger=ledger,
                repo=repo,
                notifier=CollectingNotifier(),
                clock=clock,
                ids=ids,
                refund=RefundAdapter(),
            )
            raw, headers = delivery(name, status)
            # When signed verification (IP-checked for unsigned Toss) reaches the default handler twice.
            received = await receive(
                provider=provider, raw_body=raw, headers=headers, repo=repo, clock=clock
            )
            assert received.status == 200
            assert received.event_id is not None
            for _ in range(2):
                await process(
                    event_id=received.event_id,
                    providers={name: provider},
                    handlers=handlers,
                    repo=repo,
                    clock=clock,
                )
            # Then only a known terminal API state releases the original hold once.
            expected = "pending" if name == "toss" and status == "failed" else status
            record = await repo.webhook_events.get(received.event_id)
            assert record is not None and record.status == "processed"
            refund = await repo.refunds.get("local-refund")
            assert refund is not None and refund.status == expected
            assert len(await repo.refunds.list()) == 1
            balance = await ledger.balance("customer", "paid", clock.now())
            assert balance.held == (100 if expected == "pending" else 0)
            assert balance.available == (100 if expected == "failed" else 0)
            assert len(await ledger.entries("customer", kind="revoke")) == (
                1 if expected == "succeeded" else 0
            )

    anyio.run(run)
