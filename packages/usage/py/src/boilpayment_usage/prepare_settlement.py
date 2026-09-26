"""Commit an immutable usage request and retry lease before provider I/O."""

from dataclasses import replace
from datetime import timedelta
from typing import assert_never

from boilpayment_core import (
    Money,
    Operation,
    OutboxItem,
    Payment,
    PaymentKitError,
    hash_payload,
)

from .billing_currency import billing_currency
from .settlement_period import settlement_period
from .settlement_types import (
    PreparedCharge,
    PreparedReport,
    SettlementInput,
    SettlePeriodResult,
)


async def prepare_settlement(
    input: SettlementInput,
) -> SettlePeriodResult | PreparedCharge | PreparedReport:
    sub, period, policy, repo, provider, clock = (
        input.sub,
        input.period,
        input.policy,
        input.repo,
        input.provider,
        input.clock,
    )
    snapshot_currency = await settlement_period(repo, sub, period)
    events = [
        event
        for event in await repo.usage_events.list(customer_id=sub.customer_id)
        if event.period_start == period.start
    ]
    total = sum(event.quantity for event in events)
    if any(event.quantity < 0 for event in events) or total > 9007199254740991:
        raise PaymentKitError("Invalid usage quantity", "invalid_usage_quantity")
    unchanged = SettlePeriodResult(status="unchanged", total=total)
    kind = f"usage.settle:{sub.id}:{int(period.start.timestamp() * 1000)}"
    operations = await repo.operations.list(kind=kind)
    if not operations and (
        policy.usage.overage != "bill_overage"
        or policy.usage.credit_conversion is not None
        or total <= policy.usage.included_quantity
    ):
        return unchanged
    if provider.capabilities().meters and not operations:
        return PreparedReport(events=events, total=total)
    unit_price = policy.usage.overage_unit_price_minor
    if (
        policy.usage.overage != "bill_overage"
        or policy.usage.credit_conversion is not None
        or unit_price is None
        or unit_price < 0
    ):
        raise PaymentKitError(
            "Usage settlement requires configured overage pricing",
            "usage_billing_policy_changed",
        )
    if snapshot_currency and input.currency and snapshot_currency != input.currency:
        raise PaymentKitError(
            "Currency differs from original payment", "billing_currency_required"
        )
    currency = await billing_currency(
        repo, sub.plan_id, snapshot_currency or input.currency
    )
    target_amount = max(0, total - policy.usage.included_quantity) * unit_price
    if target_amount > 9007199254740991:
        raise PaymentKitError(
            "Usage amount exceeds safe integer range", "invalid_usage_quantity"
        )
    customer = await repo.customers.get(sub.customer_id)
    customer_ref = (
        next(
            (
                ref.ref
                for ref in customer.provider_refs
                if ref.provider == provider.name
            ),
            None,
        )
        if customer
        else None
    )
    policy_hash = hash_payload(
        {
            "currency": currency,
            "unitPrice": unit_price,
            "included": policy.usage.included_quantity,
            "provider": provider.name,
            "customerRef": customer_ref,
            "billingKey": sub.billing_key,
            "periodEnd": int(period.end.timestamp() * 1000),
        }
    )
    if any(operation.payload_hash != policy_hash for operation in operations):
        raise PaymentKitError(
            "Resolve existing settlement before changing its billing rules",
            "usage_billing_policy_changed",
        )
    settled_amount = 0
    pending: tuple[Operation, Payment] | None = None
    for operation in operations:
        payment = await repo.payments.get(operation.key)
        if payment is None:
            raise PaymentKitError(
                "Settlement payment record is missing", "usage_settlement_corrupt"
            )
        match operation.status:
            case "done":
                settled_amount += payment.amount.amount_minor
            case "failed":
                return SettlePeriodResult(status="failed", total=total, payment=payment)
            case "in_progress":
                pending = operation, payment
            case unreachable:
                assert_never(unreachable)
    amount_minor = target_amount - settled_amount
    if pending is None and amount_minor <= 0:
        return unchanged
    capabilities = provider.capabilities()
    event_ids = {event.id for event in events}
    reports = await repo.outbox.list(kind="usage.report")
    if (
        provider.name != sub.provider
        or capabilities.meters
        or capabilities.native_subscriptions
        or not sub.billing_key
        or not customer_ref
        or any(report.payload.get("eventId") in event_ids for report in reports)
    ):
        raise PaymentKitError(
            "Direct usage billing needs an unmetered billing-key provider and linked customer",
            "unsupported_usage_billing",
        )
    if pending is not None:
        operation, payment = pending
        claim = await repo.outbox.get(operation.key)
        if claim is None:
            raise PaymentKitError(
                "Settlement retry lease is missing", "usage_settlement_corrupt"
            )
        if claim.next_attempt_at > clock.now():
            return SettlePeriodResult(status="pending", total=total, payment=payment)
    else:
        key = f"usage_{hash_payload([kind, target_amount])[:40]}"
        payment = Payment(
            id=key,
            customer_id=sub.customer_id,
            subscription_id=sub.id,
            provider=provider.name,
            provider_ref=f"unresolved:{key}",
            amount=Money(amount_minor=amount_minor, currency=currency),
            status="pending",
            kind="overage",
            period=period,
            occurred_at=clock.now(),
        )
        operation = Operation(
            id=key,
            key=key,
            kind=kind,
            payload_hash=policy_hash,
            status="in_progress",
            result=key,
            created_at=clock.now(),
            attempts=0,
        )
        await repo.payments.put(payment)
    operation = await repo.operations.put(
        replace(operation, attempts=operation.attempts + 1)
    )
    await repo.outbox.put(
        OutboxItem(
            id=operation.key,
            kind="usage.charge",
            payload={"paymentId": payment.id},
            status="pending",
            attempts=operation.attempts,
            next_attempt_at=clock.now() + timedelta(minutes=5),
            created_at=operation.created_at,
        )
    )
    return PreparedCharge(
        operation=operation,
        payment=payment,
        customer_ref=customer_ref,
        billing_key=sub.billing_key,
        total=total,
    )
