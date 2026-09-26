"""spec/cs.pseudo.md -- EC:L5

cs.refund_assist deliberately does NOT import `boilpayment_refund` (refund_evaluate/
refund_execute are injected -- see refund_assist.py). This proves the wiring: the correlation_id
passed to refund_assist() reaches the injected refund_execute function unchanged.
Mirrors packages/cs/ts/test/refundAssist.test.ts.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

import pytest
from boilpayment_core import (
    DEFAULT_POLICY,
    FixedClock,
    InMemoryLedger,
    InMemoryRepo,
    Money,
    Payment,
    Refund,
    RefundDecision,
    SequentialIdGen,
    resolve_policy,
)
from boilpayment_cs import (
    OpenCaseInput,
    RefundAssistInput,
    open_case,
    refund_assist,
)

CLOCK = FixedClock(datetime(2026, 1, 1, tzinfo=UTC))
CUSTOMER_ID = "cust_1"


def run(coro):
    return asyncio.run(coro)


class FakeProvider:
    name = "stripe"

    def capabilities(self):
        return {
            "native_subscriptions": True,
            "partial_refund": True,
            "meters": False,
            "scheduling": "provider",
            "webhook_signature": True,
        }

    async def create_customer(self, **kwargs):
        raise NotImplementedError("unused: create_customer")

    async def create_checkout(self, *args, **kwargs):
        raise NotImplementedError("unused: create_checkout")

    async def get_payment(self, *args, **kwargs):
        raise NotImplementedError("unused: get_payment")

    async def list_payments(self, **kwargs):
        return []

    async def get_subscription(self, *args, **kwargs):
        raise NotImplementedError("unused: get_subscription")

    async def change_subscription(self, *args, **kwargs):
        raise NotImplementedError("unused: change_subscription")

    async def cancel_subscription(self, *args, **kwargs):
        raise NotImplementedError("unused: cancel_subscription")

    async def charge_billing_key(self, **kwargs):
        raise NotImplementedError("unused: charge_billing_key")

    async def refund(self, **kwargs):
        raise NotImplementedError("unused: refund_execute is faked directly")

    async def report_usage(self, **kwargs):
        return None

    async def verify_webhook(self, **kwargs):
        raise NotImplementedError("unused: verify_webhook")


@pytest.mark.parametrize("status", ["succeeded", "failed", "pending"])
def test_ec_l5_refund_assist_threads_correlation_id_to_refund_execute(status):
    async def go():
        repo = InMemoryRepo()
        ledger = InMemoryLedger(SequentialIdGen("led_"))
        ids = SequentialIdGen("id_")
        policy = DEFAULT_POLICY

        payment = Payment(
            id="pay_assist_l5",
            customer_id=CUSTOMER_ID,
            provider="stripe",
            provider_ref="pi_assist_l5",
            subscription_id=None,
            amount=Money(amount_minor=1000, currency="USD"),
            status="succeeded",
            kind="topup",
            period=None,
            occurred_at=CLOCK.now(),
            failure=None,
        )
        await repo.payments.put(payment)
        cs_case = await open_case(
            OpenCaseInput(
                customer_id=CUSTOMER_ID,
                kind="refund",
                reference_id=payment.id,
                policy=policy,
                repo=repo,
                clock=CLOCK,
                ids=ids,
            )
        )

        decision = RefundDecision(
            eligible=True,
            amount=payment.amount,
            credits_to_revoke=0,
            rule_id="D1",
            reason="test",
            needs_human=False,
            payment_id=payment.id,
            customer_id=CUSTOMER_ID,
            subscription_id=None,
        )
        received_correlation_ids: list[str | None] = []

        async def fake_refund_evaluate(**kwargs):
            assert kwargs["policy"] == cs_case.policy_snapshot
            return decision

        async def fake_refund_execute(*, correlation_id=None, **kwargs):
            received_correlation_ids.append(correlation_id)
            return Refund(
                id="rf_1",
                payment_id=payment.id,
                customer_id=CUSTOMER_ID,
                amount=payment.amount,
                status=status,
                provider_ref="pref_1",
                credits_revoked=0,
                rule_id="D1",
                reason=None,
                failure=None,
                created_at=CLOCK.now(),
            )

        resolved = await refund_assist(
            RefundAssistInput(
                case=cs_case,
                payment=payment,
                policy=resolve_policy({"refund": {"no_questions_days": 0}}),
                ledger=ledger,
                repo=repo,
                clock=CLOCK,
                ids=ids,
                provider=FakeProvider(),
                refund_evaluate=fake_refund_evaluate,
                refund_execute=fake_refund_execute,
                correlation_id="corr_assist_1",
            )
        )

        assert resolved.status == (
            "resolved_auto" if status == "succeeded" else "needs_human"
        )
        assert received_correlation_ids == ["corr_assist_1"]

    run(go())
