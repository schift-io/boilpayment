"""Local credit/payment settlement after a durably confirmed provider refund."""
from __future__ import annotations

from dataclasses import replace
from typing import TYPE_CHECKING

from schift_payment_kit_core import LedgerReference, NewLedgerEntry, Payment, Refund

if TYPE_CHECKING:
    from .execute import ExecuteInput


async def settle_refund(input: ExecuteInput, provider_result: Refund, payment: Payment) -> Refund:
    decision, ledger, repo, clock = input.decision, input.ledger, input.repo, input.clock
    correlation_id = input.correlation_id
    scoped_provider = input.provider
    if correlation_id:
        scope = getattr(scoped_provider, "with_correlation_id", None)
        if callable(scope):
            scoped_provider = scope(correlation_id)
    refund_id = provider_result.id
    if decision.credits_to_revoke > 0:
        # EC:B8/B13 -- attribute the revoke to the payment's grant buckets (reference.grant_id) so the
        # ledger, dunning (A16) and expiry (B14) see those grants as consumed; an unattributed revoke
        # would be double-counted later (found by examples/e2e). Remainder stays unattributed.
        all_entries = await ledger.entries(decision.customer_id, pool="paid")
        grants = [
            e
            for e in all_entries
            if e.kind == "grant" and e.reference.payment_id == decision.payment_id
        ]
        # Retry-safe: subtract what this refund_id already revoked (a retried execute must not revoke twice).
        already_revoked = sum(
            -e.amount
            for e in all_entries
            if e.kind == "revoke" and e.reference.refund_id == refund_id
        )
        left = max(0, decision.credits_to_revoke - already_revoked)
        for g in grants:
            if left <= 0:
                break
            used = sum(
                e.amount
                for e in all_entries
                if e.kind != "grant" and e.reference.grant_id == g.id
            )
            take = min(max(0, g.amount + used), left)
            if take <= 0:
                continue
            await ledger.append(
                NewLedgerEntry(
                    customer_id=decision.customer_id,
                    pool="paid",
                    kind="revoke",
                    amount=-take,
                    source="refund",
                    reference=LedgerReference(
                        payment_id=decision.payment_id,
                        refund_id=refund_id,
                        grant_id=g.id,
                        correlation_id=correlation_id,
                    ),
                    idempotency_key=f"revoke:refund:{refund_id}:{g.id}",
                    actor="system",
                    reason=decision.reason,
                )
            )
            left -= take
        if left > 0:
            await ledger.append(
                NewLedgerEntry(
                    customer_id=decision.customer_id,
                    pool="paid",
                    kind="revoke",
                    amount=-left,
                    source="refund",
                    reference=LedgerReference(
                        payment_id=decision.payment_id,
                        refund_id=refund_id,
                        correlation_id=correlation_id,
                    ),
                    idempotency_key=f"revoke:refund:{refund_id}",
                    actor="system",
                    reason=decision.reason,
                )
            )
        # D15: release the hold now that the permanent revoke landed (net effect = revoke only).
        await ledger.append(
            NewLedgerEntry(
                customer_id=decision.customer_id,
                pool="paid",
                kind="release",
                amount=decision.credits_to_revoke,
                source="refund",
                reference=LedgerReference(
                    payment_id=decision.payment_id,
                    refund_id=refund_id,
                    correlation_id=correlation_id,
                ),
                idempotency_key=f"release:refund:{refund_id}",
                actor="system",
                reason=decision.reason,
            )
        )

    # provider.refund() carries none of our own ids (customer_id/rule_id come back empty,
    # `id` is the provider's own cancellation id) -- take only provider_ref/status/amount/failure
    # from it and overwrite everything we already know from `decision`.
    prior_refunded = sum(
        r.amount.amount_minor
        for r in await repo.refunds.list(payment_id=payment.id)
        if r.status == "succeeded" and r.id != refund_id
    )
    total_refunded = prior_refunded + provider_result.amount.amount_minor
    await repo.payments.put(replace(payment, status=(
        "refunded" if total_refunded >= payment.amount.amount_minor else "partially_refunded"
    )))

    refund = Refund(
        id=refund_id,
        payment_id=payment.id,
        customer_id=decision.customer_id,
        amount=provider_result.amount,
        status=provider_result.status,
        provider_ref=getattr(provider_result, "provider_ref", None)
        or getattr(provider_result, "id", None),
        credits_revoked=decision.credits_to_revoke,
        rule_id=decision.rule_id,
        reason=decision.reason,
        failure=getattr(provider_result, "failure", None),
        created_at=clock.now(),
    )
    await repo.refunds.put(refund)

    # EC:K5 K6 -- cancel the cash receipt AFTER the refund has already landed successfully. A
    # cash-receipt-cancel failure must NEVER roll back or downgrade the refund's own success --
    # it is recorded/escalated (K6) and the already-"succeeded" refund is still returned as-is.
    extra = input.extra or {}
    # EC:K5 -- prefer the receipt recorded on the payment (webhook auto-issue writes it there);
    # fall back to the caller-supplied extra for receipts issued outside the kit.
    receipt_key = (
        payment.cash_receipt.receipt_key
        if payment.cash_receipt is not None
        else extra.get("cashReceiptKey")
    )
    policy = input.policy
    if (
        policy is not None
        and policy.cash_receipt.cancel_on_refund
        and receipt_key
        and refund.status == "succeeded"
    ):
        canceler = (
            scoped_provider
            if hasattr(scoped_provider, "cancel_cash_receipt")
            else None
        )
        if canceler is not None:
            try:
                await canceler.cancel_cash_receipt(
                    payment_ref=payment.provider_ref,
                    receipt_key=receipt_key,
                    amount_minor=provider_result.amount.amount_minor,
                )
            except Exception as receipt_err:  # noqa: BLE001 -- never rolls back the refund
                if input.cs is not None:
                    await input.cs.open_refund_failed_case(
                        customer_id=decision.customer_id,
                        reference_id=refund.id,
                        reason=f"cash receipt cancel failed: {receipt_err}",
                        needs="cash_receipt_cancel_failed",
                    )

    return refund
