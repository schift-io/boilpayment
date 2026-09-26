# EC:E3 EC:E13 L5 — see spec/webhook.pseudo.md
from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from schift_payment_kit_core import (
    Clock,
    Logger,
    NormalizedEvent,
    PaymentProvider,
    Repo,
)

from .correlation import mint_correlation_id
from .identity import resolve_webhook_identity


@dataclass(kw_only=True, slots=True)
class HandlerCtx:
    event: NormalizedEvent
    provider: PaymentProvider
    repo: Repo
    clock: Clock
    # EC:L5 -- this delivery's correlation_id, minted by receive() (or here, defensively, for a
    # record written before this column existed). Threaded so every ledger append, provider call,
    # and log line for this delivery can be tied back to the webhook that produced it.
    correlation_id: str


Handler = Callable[[HandlerCtx], Awaitable[None]]
HandlerMap = dict[str, Handler]  # keyed by NormalizedEventType


async def process(
    *,
    event_id: str,
    providers: dict[str, PaymentProvider],
    handlers: HandlerMap,
    repo: Repo,
    clock: Clock,
    # EC:L1 L5 -- optional; when given, logs `webhook.processing`/`webhook.processed`/
    # `webhook.failed` events carrying this delivery's correlation_id. Omit and nothing is logged
    # (backward compatible with every existing caller).
    logger: Logger | None = None,
) -> None:
    record = await repo.webhook_events.get(event_id)
    if record is None:
        return

    # EC:L5 -- defensive fallback for a record written before the correlation_id column existed.
    correlation_id = record.correlation_id or mint_correlation_id(record.id)

    record.status = "processing"
    record.attempts += 1
    await repo.webhook_events.put(record)
    if logger is not None:
        await logger.log(
            {
                "level": "info",
                "event": "webhook.processing",
                "at": clock.now(),
                "correlationId": correlation_id,
                "provider": record.provider,
                "eventId": record.id,
                "attempts": record.attempts,
            }
        )

    try:
        raw_provider = providers.get(record.provider)
        if raw_provider is None:
            raise RuntimeError(f"no provider configured for {record.provider}")
        # EC:L5 -- scope every provider call this handler invocation makes to this delivery's
        # correlation_id. `with_correlation_id` is duck-typed (not part of the PaymentProvider
        # Protocol -- see spec/webhook.pseudo.md [EC:L5]); providers that don't implement it are
        # used as-is, unchanged from before.
        scope = getattr(raw_provider, "with_correlation_id", None)
        provider = scope(correlation_id) if callable(scope) else raw_provider
        # EC:E3 — re-verify/re-parse from the stored raw body, never trust cached payloads.
        event = await provider.verify_webhook(
            headers=record.headers, raw_body=record.raw_body
        )
        # EC:I9 -- re-resolve identity even on a re-process: a local row that didn't exist at
        # receive() time (e.g. checkout hadn't landed yet) may exist by now.
        identity = await resolve_webhook_identity(repo, provider, event)
        record.customer_id = identity.customer_id or record.customer_id
        record.payment_id = identity.payment_id or record.payment_id
        record.subscription_id = identity.subscription_id or record.subscription_id
        handler = handlers.get(event.type) or handlers.get("unknown")
        if handler is not None:
            await handler(
                HandlerCtx(
                    event=event,
                    provider=provider,
                    repo=repo,
                    clock=clock,
                    correlation_id=correlation_id,
                )
            )
        record.status = "processed"
        record.processed_at = clock.now()
        record.error = None
        if logger is not None:
            await logger.log(
                {
                    "level": "info",
                    "event": "webhook.processed",
                    "at": clock.now(),
                    "correlationId": correlation_id,
                    "provider": record.provider,
                    "eventId": record.id,
                }
            )
    except Exception as e:  # noqa: BLE001 — captured on the record, not re-raised
        record.status = "failed"
        record.error = str(e)
        if logger is not None:
            await logger.log(
                {
                    "level": "error",
                    "event": "webhook.failed",
                    "at": clock.now(),
                    "correlationId": correlation_id,
                    "provider": record.provider,
                    "eventId": record.id,
                    "error": record.error,
                }
            )
    await repo.webhook_events.put(record)


@dataclass(kw_only=True, slots=True)
class ProcessPendingResult:
    processed: int
    failed: int


async def process_pending(
    *,
    repo: Repo,
    providers: dict[str, PaymentProvider],
    handlers: HandlerMap,
    clock: Clock,
    max_attempts: int = 8,
    logger: Logger | None = None,
) -> ProcessPendingResult:
    received = await repo.webhook_events.list(status="received")
    failed_retryable = [
        r
        for r in await repo.webhook_events.list(status="failed")
        if r.attempts < max_attempts
    ]
    candidates = [*received, *failed_retryable]

    processed = 0
    failed = 0
    for record in candidates:
        await process(
            event_id=record.id,
            providers=providers,
            handlers=handlers,
            repo=repo,
            clock=clock,
            logger=logger,
        )
        after = await repo.webhook_events.get(record.id)
        if after is not None and after.status == "processed":
            processed += 1
        elif after is not None and after.status == "failed":
            failed += 1
    return ProcessPendingResult(processed=processed, failed=failed)
