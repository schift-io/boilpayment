"""Persist native meter reports without claiming an invoice has been paid."""

from typing import Literal

from schift_payment_kit_core import (
    Clock,
    OutboxItem,
    PaymentKitError,
    PaymentProvider,
    Repo,
    Subscription,
    UsageEvent,
)

from .flush_outbox import flush_outbox


async def report_period(
    *,
    sub: Subscription,
    events: list[UsageEvent],
    repo: Repo,
    provider: PaymentProvider,
    clock: Clock,
) -> Literal["awaiting_provider_billing", "report_pending", "report_failed"]:
    if provider.name != sub.provider:
        raise PaymentKitError(
            "Usage provider does not match subscription", "unsupported_usage_billing"
        )
    existing = await repo.outbox.list(kind="usage.report")
    for event in events:
        if any(item.payload.get("eventId") == event.id for item in existing):
            continue
        await repo.outbox.put(
            OutboxItem(
                id=f"usage-report:{event.id}",
                kind="usage.report",
                payload={
                    "eventId": event.id,
                    "customerId": sub.customer_id,
                    "meter": event.meter,
                    "quantity": event.quantity,
                    "occurredAt": event.occurred_at,
                    "provider": provider.name,
                },
                status="pending",
                attempts=0,
                next_attempt_at=clock.now(),
                created_at=clock.now(),
            )
        )
    await flush_outbox(repo=repo, providers={provider.name: provider}, clock=clock)
    reports = await repo.outbox.list(kind="usage.report")
    relevant = [
        item
        for item in reports
        if any(item.payload.get("eventId") == event.id for event in events)
    ]
    if any(item.status == "failed" for item in relevant):
        return "report_failed"
    if any(item.status == "pending" for item in relevant):
        return "report_pending"
    return "awaiting_provider_billing"
