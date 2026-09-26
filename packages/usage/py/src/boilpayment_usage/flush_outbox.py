# EC:C4 — see spec/usage.pseudo.md
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from boilpayment_core import Clock, PaymentProvider, ProviderName, Repo


@dataclass(kw_only=True, slots=True)
class FlushOutboxResult:
    sent: int
    failed: int
    retried: int


def _backoff_seconds(attempts: int) -> float:
    return min(60, 2**attempts) * 60.0  # exponential minutes, capped at 60min


async def flush_outbox(
    *,
    repo: Repo,
    providers: dict[ProviderName, PaymentProvider],
    clock: Clock,
    max_attempts: int = 8,
) -> FlushOutboxResult:
    now = clock.now()
    pending = await repo.outbox.list(kind="usage.report", status="pending")

    sent = 0
    failed = 0
    retried = 0

    for item in pending:
        if item.next_attempt_at > now:
            continue
        payload = item.payload
        provider = providers.get(payload["provider"])
        if provider is None:
            continue  # no provider configured for this event — leave pending

        # resolve provider-side customer ref: the outbox payload only ever carries the
        # internal customerId, so look up the provider ref via the customer's repo row.
        customer = await repo.customers.get(payload["customerId"])
        provider_ref = next(
            (
                r.ref
                for r in (customer.provider_refs if customer else [])
                if r.provider == payload["provider"]
            ),
            None,
        )
        if provider_ref is None:
            # terminal, not transient — retrying won't link this customer to the provider by itself.
            item.attempts += 1
            item.status = "failed"
            item.payload = {
                **item.payload,
                "error": "no_provider_ref",
            }  # OutboxItem has no dedicated error field
            await repo.outbox.put(item)
            failed += 1
            continue

        item.attempts += 1  # counts every attempt, success or failure
        try:
            occurred_at = payload["occurredAt"]
            if isinstance(occurred_at, str):
                occurred_at = datetime.fromisoformat(occurred_at)
            await provider.report_usage(
                meter=payload["meter"],
                customer_ref=provider_ref,
                quantity=payload["quantity"],
                occurred_at=occurred_at,
                idempotency_key=payload["eventId"],
            )
            item.status = "sent"
            await repo.outbox.put(item)
            sent += 1
        except Exception:  # noqa: BLE001 -- outbox retries; failure is recorded, not raised
            if item.attempts >= max_attempts:
                item.status = "failed"
                failed += 1
            else:
                item.status = "pending"
                item.next_attempt_at = now + timedelta(
                    seconds=_backoff_seconds(item.attempts)
                )
                retried += 1
            await repo.outbox.put(item)

    return FlushOutboxResult(sent=sent, failed=failed, retried=retried)
