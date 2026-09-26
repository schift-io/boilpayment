"""Bind completed provider payments to immutable checkout evidence."""

from __future__ import annotations

from dataclasses import asdict, dataclass, replace
from datetime import datetime

from boilpayment_core import Payment, PaymentKitError, run_idempotent

from .purchase_snapshot import (
    PurchaseSnapshot,
    matches_checkout_payment,
    parse_checkout_snapshot,
    parse_purchase_snapshot,
)
from .support import SupportDeps


@dataclass(frozen=True, slots=True, kw_only=True)
class RegisterCompletedCheckoutInput(SupportDeps):
    customer_id: str
    checkout_id: str
    payment_ref: str
    subscription_ref: str | None = None


async def register_completed_checkout(input: RegisterCompletedCheckoutInput) -> Payment:
    operation = await input.repo.operations.get(
        f"checkout-entitlement-by-id:{input.checkout_id}"
    )
    if (
        not operation
        or operation.kind != "checkout.entitlement"
        or operation.status != "done"
    ):
        raise PaymentKitError("checkout snapshot missing", "checkout_evidence_missing")
    snapshot = parse_checkout_snapshot(operation.result)
    if snapshot.customer_id != input.customer_id:
        raise PaymentKitError(
            "checkout customer mismatch", "checkout_evidence_mismatch"
        )
    provider = input.providers.get(snapshot.provider)
    if provider is None:
        raise PaymentKitError(
            "checkout provider unavailable", "checkout_evidence_missing"
        )
    live = await provider.get_payment(input.payment_ref)
    listed = await provider.list_payments(
        customer_ref=snapshot.customer_ref,
        since=datetime.fromisoformat(snapshot.captured_at),
    )
    if (
        not matches_checkout_payment(snapshot, live.raw, input.payment_ref)
        or live.provider_ref != input.payment_ref
        or live.provider != snapshot.provider
        or live.status != "succeeded"
        or live.amount.amount_minor != snapshot.price.amount_minor
        or live.amount.currency != snapshot.price.currency
        or not any(payment.provider_ref == input.payment_ref for payment in listed)
        or live.customer_id not in ("", snapshot.customer_id, snapshot.customer_ref)
    ):
        raise PaymentKitError(
            "provider payment does not match captured sale",
            "checkout_evidence_mismatch",
        )
    payment_id = f"payment:{snapshot.provider}:{input.payment_ref}"
    subscription_id = None
    period = live.period
    if snapshot.plan.interval is not None:
        subscription_ref = input.subscription_ref or live.subscription_id
        if not subscription_ref or live.subscription_id != subscription_ref:
            raise PaymentKitError(
                "subscription payment correlation missing", "checkout_evidence_missing"
            )
        live_sub = await provider.get_subscription(subscription_ref)
        if live_sub.customer_id not in (snapshot.customer_id, snapshot.customer_ref):
            raise PaymentKitError(
                "subscription ownership mismatch", "checkout_evidence_mismatch"
            )
        subscription_id = f"subscription:{snapshot.provider}:{subscription_ref}"
        period = live.period or live_sub.current_period
        if await input.repo.subscriptions.get(subscription_id) is None:
            await input.repo.subscriptions.put(
                replace(
                    live_sub,
                    id=subscription_id,
                    customer_id=snapshot.customer_id,
                    plan_id=snapshot.plan.id,
                    provider=snapshot.provider,
                    provider_ref=subscription_ref,
                )
            )
    purchase = PurchaseSnapshot(
        intent_key=snapshot.intent_key,
        checkout_id=snapshot.checkout_id,
        checkout_provider_ref=snapshot.checkout_provider_ref,
        customer_id=snapshot.customer_id,
        customer_ref=snapshot.customer_ref,
        provider=snapshot.provider,
        plan=snapshot.plan,
        price=snapshot.price,
        policy=snapshot.policy,
        captured_at=snapshot.captured_at,
        payment_id=payment_id,
        payment_ref=input.payment_ref,
        purchased_at=live.occurred_at.isoformat(),
        subscription_id=subscription_id,
        period={
            "start": period.start.isoformat(timespec="milliseconds").replace(
                "+00:00", "Z"
            ),
            "end": period.end.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        }
        if period
        else None,
    )

    async def capture() -> PurchaseSnapshot:
        return purchase

    recorded = await run_idempotent(
        repo=input.repo,
        clock=input.clock,
        key=f"purchase-entitlement:{payment_id}",
        kind="purchase.entitlement",
        payload={"checkout_id": input.checkout_id, "payment_ref": input.payment_ref},
        serialize=asdict,
        deserialize=parse_purchase_snapshot,
        fn=capture,
    )
    existing = await input.repo.payments.get(payment_id)
    if existing:
        return existing
    payment = replace(
        live,
        id=payment_id,
        customer_id=recorded.result.customer_id,
        subscription_id=recorded.result.subscription_id,
        kind="topup" if recorded.result.plan.interval is None else "subscription",
        period=period,
    )
    await input.repo.payments.put(payment)
    return payment
