"""Commit request, call provider outside the transaction, then finalize atomically."""

from dataclasses import replace
from typing import assert_never

from boilpayment_core import (
    Clock,
    LedgerStore,
    PaymentKitError,
    PaymentProvider,
    Period,
    Policy,
    Repo,
    Subscription,
)

from .prepare_settlement import prepare_settlement
from .report_period import report_period
from .settlement_types import (
    PreparedCharge,
    PreparedReport,
    SettlementInput,
    SettlePeriodResult,
)


async def settle_period(
    *,
    sub: Subscription,
    period: Period,
    policy: Policy,
    repo: Repo,
    ledger: LedgerStore,
    provider: PaymentProvider,
    clock: Clock,
    currency: str | None = None,
) -> SettlePeriodResult:
    if period.end <= period.start:
        raise PaymentKitError("Invalid usage period", "invalid_usage_period")
    if clock.now() < period.end:
        return SettlePeriodResult(status="not_due", total=0)
    input = SettlementInput(
        sub=sub,
        period=period,
        policy=policy,
        repo=repo,
        ledger=ledger,
        provider=provider,
        clock=clock,
        currency=currency,
    )
    prepared = await ledger.transaction(
        sub.customer_id, lambda: prepare_settlement(input)
    )
    match prepared:
        case SettlePeriodResult():
            return prepared
        case PreparedReport(events=events, total=total):
            return SettlePeriodResult(
                status=await report_period(
                    sub=sub, events=events, repo=repo, provider=provider, clock=clock
                ),
                total=total,
            )
        case PreparedCharge():
            pass
        case unreachable:
            assert_never(unreachable)
    operation, payment, total = prepared.operation, prepared.payment, prepared.total
    # No transaction spans this await: an unknown provider outcome cannot erase the request.
    response = (
        await provider.get_payment(payment.provider_ref)
        if payment.provider_ref != f"unresolved:{operation.key}"
        else await provider.charge_billing_key(
            billing_key=prepared.billing_key,
            amount=payment.amount,
            order_id=operation.key,
            customer_ref=prepared.customer_ref,
            idempotency_key=operation.key,
        )
    )
    if (
        response.provider != provider.name
        or response.amount != payment.amount
        or not response.provider_ref
    ):
        raise PaymentKitError(
            "Provider charge does not match the durable request",
            "usage_charge_unresolved",
        )

    async def finalize() -> SettlePeriodResult:
        current = await repo.operations.get(operation.key)
        if current and current.status == "done":
            return SettlePeriodResult(
                status="unchanged",
                total=total,
                payment=await repo.payments.get(operation.key),
            )
        saved = await repo.payments.put(
            replace(
                response,
                id=operation.key,
                customer_id=sub.customer_id,
                subscription_id=sub.id,
                kind="overage",
                period=period,
            )
        )
        match saved.status:
            case "succeeded" | "failed":
                paid = saved.status == "succeeded"
                await repo.operations.put(
                    replace(
                        operation,
                        status="done" if paid else "failed",
                        error=None
                        if paid
                        else saved.failure.code
                        if saved.failure
                        else "payment_failed",
                        completed_at=clock.now(),
                    )
                )
                claim = await repo.outbox.get(operation.key)
                if claim is None:
                    raise PaymentKitError(
                        "Settlement retry lease is missing", "usage_settlement_corrupt"
                    )
                await repo.outbox.put(
                    replace(claim, status="sent" if paid else "failed")
                )
                return SettlePeriodResult(
                    status="charged" if paid else "failed",
                    total=total,
                    charged_amount=saved.amount if paid else None,
                    payment=saved,
                )
            case (
                "pending"
                | "requires_action"
                | "refunded"
                | "partially_refunded"
                | "disputed"
            ):
                return SettlePeriodResult(status="pending", total=total, payment=saved)
            case unreachable:
                assert_never(unreachable)

    return await ledger.transaction(sub.customer_id, finalize)
