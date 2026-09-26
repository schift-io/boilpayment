"""Durable provider request checkpoint: submitted requests are never automatically repeated."""
from __future__ import annotations

from dataclasses import replace
from typing import TYPE_CHECKING

from schift_payment_kit_core import (
    LedgerReference,
    NewLedgerEntry,
    Operation,
    PaymentFailure,
    PaymentKitError,
    Refund,
    deserialize_refund,
    hash_payload,
    serialize_refund,
)

if TYPE_CHECKING:
    from .execute import ExecuteInput


async def request_refund(input: ExecuteInput, execution_key: str) -> Refund:
    decision, repo, ledger, clock = input.decision, input.repo, input.ledger, input.clock
    key = f"refund.provider:{execution_key}"
    existing = await repo.operations.get(key)
    if existing is not None and existing.result is None:
        raise PaymentKitError("refund request preparation needs reconciliation", "idempotency_in_progress")
    if existing is not None and (existing.status == "done" or existing.error == "refund_submitted"):
        return deserialize_refund(existing.result)
    payment = await repo.payments.get(decision.payment_id)
    if payment is None:
        raise PaymentKitError("payment not found", "not_found")
    pending = deserialize_refund(existing.result) if existing is not None else Refund(
        id=input.ids.new_id(), payment_id=payment.id, customer_id=decision.customer_id,
        amount=decision.amount, status="pending", provider_ref=None, credits_revoked=0,
        rule_id=decision.rule_id, reason=decision.reason, created_at=clock.now(),
        failure=PaymentFailure(code="refund_outcome_unknown", provider_code=None, retryable=False,
            user_message="Refund outcome requires provider confirmation; do not resubmit"),
    )
    committed = sum(
        refund.amount.amount_minor for refund in await repo.refunds.list(payment_id=payment.id)
        if refund.id != pending.id and refund.status in ("succeeded", "pending")
    )
    if (
        payment.customer_id != decision.customer_id or payment.amount.currency != decision.amount.currency
        or type(decision.amount.amount_minor) is not int or type(decision.credits_to_revoke) is not int
        or decision.amount.amount_minor > 9007199254740991 or decision.credits_to_revoke > 9007199254740991
        or decision.amount.amount_minor <= 0 or decision.credits_to_revoke < 0
        or decision.amount.amount_minor > payment.amount.amount_minor - committed
        or payment.status not in ("succeeded", "partially_refunded")
    ):
        raise PaymentKitError("refund decision does not match current payment", "refund_invalid_decision", decision)
    claimed = await repo.operations.claim(Operation(
        id=key, key=key, kind="refund.provider", payload_hash=hash_payload({"decision": decision, "extra": input.extra}),
        status="in_progress", result=serialize_refund(pending), error="refund_prepared",
        created_at=clock.now(), completed_at=None, attempts=1,
    ))
    if claimed is None:
        raise PaymentKitError("refund request already in progress", "idempotency_in_progress")
    operation = replace(claimed, result=serialize_refund(pending), error="refund_prepared")
    await repo.operations.put(operation)
    try:
        if decision.credits_to_revoke > 0:
            await ledger.append(NewLedgerEntry(
                customer_id=decision.customer_id, pool="paid", kind="hold", amount=-decision.credits_to_revoke,
                source="refund", reference=LedgerReference(payment_id=payment.id, refund_id=pending.id,
                    correlation_id=input.correlation_id), idempotency_key=f"hold:refund:{pending.id}",
                actor="system", reason=decision.reason,
            ))
        await repo.refunds.put(pending)
    except Exception:  # preparation boundary; no network call happened, retain identity on retry
        await repo.operations.put(replace(operation, status="failed"))
        raise
    # A lost response checkpoint leaves this marker pending, preventing another provider call.
    await repo.operations.put(replace(operation, error="refund_submitted"))
    provider = input.provider
    if input.correlation_id:
        scope = getattr(provider, "with_correlation_id", None)
        if callable(scope):
            provider = scope(input.correlation_id)
    try:
        response = await provider.refund(
            payment_ref=payment.provider_ref, amount=decision.amount, reason=decision.reason,
            idempotency_key=f"refund:{payment.id}:{pending.id}", extra=input.extra,
        )
        result = replace(pending, amount=response.amount, status=response.status,
            provider_ref=response.provider_ref or response.id, failure=response.failure)
    except Exception as error:  # noqa: BLE001 -- provider boundary: unknown transport outcomes stay pending
        # This specific adapter preflight rejects before submitting a network request.
        match error:
            case PaymentKitError(code="refund_receive_account_required"):
                result = replace(pending, status="failed", failure=PaymentFailure(
                    code=error.code, provider_code=None, retryable=True, user_message=str(error)))
            case _:
                result = pending
    await repo.operations.put(replace(operation, status="done", result=serialize_refund(result),
        error=None, completed_at=clock.now()))
    return result
