"""EC:E24 -- one provider payment can be named by several refs.

Stripe records a renewal under its invoice (``in_...``) but refunds and disputes name the
PaymentIntent (``pi_...``) or charge (``ch_...``). The kit keeps the extra refs of a recorded payment
in the operations table (no schema change) and resolves an event's ref exact-first, then by alias.
Mirrors payment-refs.ts."""

from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime

from .types import Operation, Payment, Repo


def _alias_key(provider: str, ref: str) -> str:
    return f"payment-ref-alias:{provider}:{ref}"


async def record_payment_ref_aliases(repo: Repo, payment: Payment, aliases: Iterable[str | None], now: datetime) -> None:
    for ref in aliases:
        if not ref or ref == payment.provider_ref:
            continue
        key = _alias_key(payment.provider, ref)
        if await repo.operations.get(key) is not None:
            continue
        await repo.operations.put(Operation(id=key, key=key, kind="payment.ref_alias", payload_hash="", status="done",
                                            created_at=now, result={"paymentId": payment.id}, completed_at=now, attempts=1))


async def find_local_payment(repo: Repo, provider: str, ref: str) -> Payment | None:
    exact = await repo.payments.list(provider=provider, provider_ref=ref)
    if exact:
        return exact[0]
    op = await repo.operations.get(_alias_key(provider, ref))
    pid = (op.result or {}).get("paymentId") if op is not None and isinstance(op.result, dict) else None
    return await repo.payments.get(pid) if pid else None
