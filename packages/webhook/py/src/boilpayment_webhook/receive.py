# EC:E4 EC:E5 L5 — see spec/webhook.pseudo.md
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from boilpayment_core import (
    Clock,
    Logger,
    PaymentProvider,
    Repo,
    WebhookEventRecord,
    WebhookSignatureError,
)

from .correlation import mint_correlation_id
from .identity import resolve_webhook_identity
from .process import accepts_kwarg


@dataclass(kw_only=True, slots=True)
class ReceiveResult:
    status: Literal[200, 400]
    event_id: str | None = None
    duplicated: bool | None = None


async def receive(
    *,
    provider: PaymentProvider,
    headers: dict[str, str],
    raw_body: str,
    repo: Repo,
    clock: Clock,
    # EC:L1 L5 -- optional; when given, logs a `webhook.received` event carrying the minted
    # correlation_id. Omit and nothing is logged (backward compatible with every existing caller).
    logger: Logger | None = None,
    # EC:E18 -- the peer address from the app's socket (for IP-allowlisted providers such as Toss).
    remote_address: str | None = None,
) -> ReceiveResult:
    try:
        # EC:E4 E18 -- pass the peer address only when given, so adapters without the parameter work.
        extra = (
            {"remote_address": remote_address}
            if remote_address and accepts_kwarg(provider.verify_webhook, "remote_address")
            else {}
        )
        event = await provider.verify_webhook(headers=headers, raw_body=raw_body, **extra)  # EC:E4
    except WebhookSignatureError:
        return ReceiveResult(status=400)  # nothing stored

    existing = await repo.webhook_events.get(event.id)
    if existing is not None:
        return ReceiveResult(
            status=200, event_id=event.id, duplicated=True
        )  # EC:E5 dedupe

    # EC:I9 -- best-effort at first sighting; process() re-resolves later once more local rows exist.
    identity = await resolve_webhook_identity(repo, provider, event)
    # EC:L5 -- minted here, deterministic from the provider event id (`corr_{id}`) so a redelivery
    # of the same event mints the same correlation_id, no state needed. Threaded by process() into
    # every handler invocation, ledger append, and provider call for this delivery.
    correlation_id = mint_correlation_id(event.id)
    record = WebhookEventRecord(
        id=event.id,
        provider=provider.name,
        type=event.type,
        status="received",
        raw_body=raw_body,
        headers=headers,
        received_at=clock.now(),
        processed_at=None,
        error=None,
        attempts=0,
        customer_id=identity.customer_id,
        payment_id=identity.payment_id,
        subscription_id=identity.subscription_id,
        correlation_id=correlation_id,
    )
    await repo.webhook_events.put(record)
    if logger is not None:
        await logger.log(
            {
                "level": "info",
                "event": "webhook.received",
                "at": clock.now(),
                "correlationId": correlation_id,
                "provider": provider.name,
                "eventId": event.id,
                "eventType": event.type,
            }
        )

    return ReceiveResult(
        status=200, event_id=event.id, duplicated=False
    )  # EC:E5 — 200 immediately
