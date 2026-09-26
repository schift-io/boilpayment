"""spec/refund.pseudo.md — EC:D15 D12 B8 J1-J5 K5 K6"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from boilpayment_core import (
    Clock,
    IdGen,
    LedgerReference,
    LedgerStore,
    NewLedgerEntry,
    PaymentKitError,
    PaymentProvider,
    Policy,
    Refund,
    RefundDecision,
    Repo,
    deserialize_refund,
    run_idempotent,
    serialize_refund,
)

from .execute_request import request_refund
from .execute_settle import settle_refund


class RefundFailedCaseOpener(Protocol):
    """Injected instead of importing `boilpayment_cs` directly — keeps refund decoupled from cs (EC:D12)."""

    async def open_refund_failed_case(
        self,
        *,
        customer_id: str,
        reference_id: str,
        reason: str,
        needs: str | None = None,
    ) -> None: ...


@dataclass(kw_only=True, slots=True)
class ExecuteInput:
    decision: RefundDecision
    provider: PaymentProvider
    ledger: LedgerStore
    repo: Repo
    clock: Clock
    ids: IdGen
    approved_by: str | None = None
    # EC:K5 -- fallback only: payment.cash_receipt.receipt_key is preferred and is written by the
    # webhook auto-issue path. extra["cashReceiptKey"] (same camelCase-key convention as extra["refundReceiveAccount"],
    # EC:D13), set by the caller when the payment has an issued cash receipt (Toss: the real
    # receipt_key; PortOne: any truthy value, since PortOne's cancel endpoint is payment-scoped and
    # needs no receipt id -- see toss.pseudo.md/portone.pseudo.md). refund itself has no record of
    # issuance. core now has Payment.cash_receipt and the webhook auto-issue path fills it; the caller (whoever issued the
    # receipt, e.g. webhook.default_handlers) must supply it.
    extra: dict[str, Any] | None = None
    cs: RefundFailedCaseOpener | None = None
    # EC:K5 — only cash_receipt.cancel_on_refund is read; pass the resolved Policy or just this slice.
    policy: Policy | None = None
    # EC:J5 — default: "refund:{decision.payment_id}:{decision.amount.amount_minor}:{decision.rule_id}".
    idempotency_key: str | None = None
    # EC:L5 -- optional delivery-scoped correlation id for callers that did NOT come through
    # webhook.process's own ledger/provider wrapping (see
    # packages/webhook/py/src/boilpayment_webhook/correlation.py). When present: threaded
    # to provider.refund() via the provider's duck-typed with_correlation_id(id) (falls back to
    # the bare provider when absent), and merged into reference.correlation_id on every ledger
    # entry this call writes (hold/revoke/release).
    correlation_id: str | None = None


async def execute(input: ExecuteInput) -> Refund:
    """Submit once at the provider; retries resume durable local settlement only."""
    decision = input.decision
    if not decision.eligible:
        raise PaymentKitError("cannot execute an ineligible refund decision", "refund_ineligible", decision)
    if decision.needs_human and not (input.approved_by or "").strip():
        raise PaymentKitError("refund decision requires explicit approval", "refund_approval_required", decision)
    key = input.idempotency_key or f"refund:{decision.payment_id}:{decision.amount.amount_minor}:{decision.rule_id}"
    result = await run_idempotent(
        repo=input.repo, clock=input.clock, key=key, kind="refund.execute",
        payload={"decision": decision, "extra": input.extra},
        serialize=serialize_refund, deserialize=deserialize_refund,
        fn=lambda: _do_execute(input, key),
    )
    return await input.repo.refunds.get(result.result.id) or result.result


async def _do_execute(input: ExecuteInput, key: str) -> Refund:
    decision, repo = input.decision, input.repo
    provider_result = await request_refund(input, key)
    settled = await repo.refunds.get(provider_result.id)
    if settled is not None and settled.status != "pending":
        return settled
    if provider_result.status == "pending":
        await repo.refunds.put(provider_result)
        return provider_result
    if provider_result.status == "failed":
        if decision.credits_to_revoke > 0:
            await input.ledger.append(NewLedgerEntry(
                customer_id=decision.customer_id, pool="paid", kind="release", amount=decision.credits_to_revoke,
                source="refund", reference=LedgerReference(payment_id=decision.payment_id,
                    refund_id=provider_result.id, correlation_id=input.correlation_id),
                idempotency_key=f"release:refund:{provider_result.id}", actor="system", reason=decision.reason,
            ))
        await repo.refunds.put(provider_result)
        if input.cs:
            await input.cs.open_refund_failed_case(
                customer_id=decision.customer_id, reference_id=provider_result.id,
                reason=provider_result.failure.user_message if provider_result.failure else "provider refund failed",
                needs="refund_receive_account" if provider_result.failure and
                    provider_result.failure.code == "refund_receive_account_required" else None,
            )
        return provider_result
    payment = await repo.payments.get(decision.payment_id)
    if payment is None:
        raise PaymentKitError("payment not found", "not_found")
    return await settle_refund(input, provider_result, payment)
