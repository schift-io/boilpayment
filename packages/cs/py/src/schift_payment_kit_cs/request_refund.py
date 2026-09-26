"""Identifier-only rule-based customer refund entry point."""

from __future__ import annotations

from dataclasses import dataclass
from typing import assert_never

from schift_payment_kit_core import (
    CsCase,
    Money,
    deserialize_cs_case,
    run_idempotent,
    serialize_cs_case,
)
from schift_payment_kit_refund import EvaluateInput, ExecuteInput, evaluate, execute

from .cases import EscalateInput, escalate
from .refund_assist import RefundAssistInput, refund_assist
from .support import (
    SupportPaymentInput,
    UnverifiedPayment,
    VerifiedPayment,
    verify_support_payment,
)


@dataclass(frozen=True, slots=True, kw_only=True)
class RequestRefundInput(SupportPaymentInput):
    request_id: str | None = None
    requested_amount: Money | None = None


async def request_refund(input: RequestRefundInput) -> CsCase:
    """Callers provide identifiers and requested money, never a refund decision or approval."""

    async def process() -> CsCase:
        verification = await verify_support_payment(
            input, kind="refund", case_key=input.request_id or input.payment_id
        )
        match verification:
            case UnverifiedPayment(case=case):
                return case
            case VerifiedPayment(case=case, payment=payment, provider=provider):
                pass
            case unreachable:
                assert_never(unreachable)
        sub = (
            await input.repo.subscriptions.get(payment.subscription_id)
            if payment.subscription_id
            else None
        )
        if payment.subscription_id and (
            sub is None
            or sub.customer_id != input.customer_id
            or sub.provider != payment.provider
        ):
            return await escalate(
                EscalateInput(
                    case=case,
                    repo=input.repo,
                    clock=input.clock,
                    reason="subscription ownership evidence is unavailable",
                    notifier=input.notifier,
                    on_case_event=input.on_case_event,
                )
            )

        async def refund_evaluate(**kwargs):
            requested = kwargs.pop("requested_amount", None)
            return await evaluate(EvaluateInput(**kwargs, requested_amount=requested))

        async def refund_execute(**kwargs):
            return await execute(ExecuteInput(**kwargs, policy=case.policy_snapshot))

        amount = input.requested_amount
        return await refund_assist(
            RefundAssistInput(
                case=case,
                payment=payment,
                sub=sub,
                policy=case.policy_snapshot,
                ledger=input.ledger,
                repo=input.repo,
                clock=input.clock,
                ids=input.ids,
                provider=provider,
                refund_evaluate=refund_evaluate,
                refund_execute=refund_execute,
                requested_amount={
                    "amount_minor": amount.amount_minor,
                    "currency": amount.currency,
                }
                if amount
                else None,
                notifier=input.notifier,
                on_case_event=input.on_case_event,
                reporter=input.reporter,
                idempotency_key=f"support-refund-assist:{case.id}:{input.request_id or input.payment_id}",
            )
        )

    result = await run_idempotent(
        repo=input.repo,
        clock=input.clock,
        key=f"support-refund:{input.customer_id}:{input.request_id or input.payment_id}",
        kind="cs.requestRefund",
        payload={
            "customer_id": input.customer_id,
            "payment_id": input.payment_id,
            "amount": input.requested_amount,
        },
        serialize=serialize_cs_case,
        deserialize=deserialize_cs_case,
        fn=process,
    )
    return await input.repo.cs_cases.get(result.result.id) or result.result
