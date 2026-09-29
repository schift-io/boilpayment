"""DC-07 -- a 100% discount is not supported: the sale is recorded, nothing is granted, one case opens."""

from __future__ import annotations

from copy import deepcopy

from .idempotent import run_idempotent
from .types import Clock, CsCase, Notification, Notifier, Payment, Policy, Repo


def zero_sale_key(payment_id: str) -> str:
    """Operation key that marks a paid-zero sale as handled."""
    return f"zero-sale:{payment_id}"


async def is_zero_sale_handled(repo: Repo, payment_id: str) -> bool:
    """True once the paid-zero sale for this payment was recorded and handed to a person."""
    operation = await repo.operations.get(zero_sale_key(payment_id))
    return (
        operation is not None
        and operation.kind == "payment.zeroSale"
        and operation.status == "done"
    )


async def open_zero_sale_case(
    *, repo: Repo, clock: Clock, policy: Policy, payment: Payment,
    notifier: Notifier | None = None,
) -> CsCase:
    """Open exactly one needs_human case for a paid-zero sale (idempotent per payment).

    The caller records the payment; this never grants or accrues anything.
    """

    async def open_once() -> dict[str, str]:
        case_id = zero_sale_key(payment.id)
        if await repo.cs_cases.get(case_id) is None:
            now = clock.now()
            await repo.cs_cases.put(CsCase(
                id=case_id, customer_id=payment.customer_id, kind="reconcile_mismatch",
                status="needs_human", reference_id=payment.id,
                policy_snapshot=deepcopy(policy),
                decision={"reason": "zero_amount_sale", "paymentId": payment.id},
                churn_reason=None, churn_text=None, opened_at=now,
                resolved_at=None, escalated_at=now,
            ))
            if notifier is not None:
                await notifier.send(Notification(
                    type="cs.needs_human", customer_id=payment.customer_id or None,
                    payload={"caseId": case_id, "paymentId": payment.id, "reason": "zero_amount_sale"},
                ))
        return {"paymentId": payment.id}

    await run_idempotent(
        repo=repo, key=zero_sale_key(payment.id), kind="payment.zeroSale",
        payload={"paymentId": payment.id}, clock=clock, fn=open_once,
    )
    opened = await repo.cs_cases.get(zero_sale_key(payment.id))
    if opened is None:
        raise RuntimeError("zero-sale case missing after it was opened")
    return opened
