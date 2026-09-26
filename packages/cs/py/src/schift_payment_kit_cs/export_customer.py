"""spec/cs.pseudo.md — EC:H5

GDPR / 개인정보보호법 data-portability export. One JSON-serializable snapshot of everything the kit
knows about a customer, built purely against the `Repo`/`LedgerStore` interfaces (works on
InMemory and Postgres alike -- no schema assumptions beyond the core contract).

Relationship to EC:H2 (deletion vs 전자상거래법 5-year retention): this function only READS and
never deletes anything. H2's answer (anonymize `customers` PII, keep the ledger) is unaffected --
export is always safe to run; deletion is a separate, harder decision this function does not make.

Mirrors packages/cs/ts/src/exportCustomer.ts exactly.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, is_dataclass
from datetime import datetime
from typing import Any

from schift_payment_kit_core import Clock, LedgerStore, Repo, redact

from .timeline import TimelineOptions, timeline


@dataclass(kw_only=True, slots=True)
class ExportCustomerInput:
    customer_id: str
    repo: Repo
    ledger: LedgerStore
    clock: Clock
    # Default True -- every field is passed through `schift_payment_kit_core.redact()` before
    # being returned, so card numbers / 주민번호 / API secrets never leave the kit in the clear.
    # Pass False ONLY when legally answering a subject access request that requires the raw
    # values -- never as a default, never for anything other than that request.
    redact: bool = True


def _to_dict(value: Any) -> Any:
    """Recursively turns dataclass instances (including any nested inside plain dicts/lists, e.g.
    a Money value sitting inside a TimelineEvent.detail dict) into plain dicts, using stdlib
    dataclasses.asdict which already walks the full object graph regardless of static typing."""
    if is_dataclass(value) and not isinstance(value, type):
        return asdict(value)
    if isinstance(value, list):
        return [_to_dict(v) for v in value]
    if isinstance(value, dict):
        return {k: _to_dict(v) for k, v in value.items()}
    return value


def _to_jsonable(value: Any) -> Any:
    """Recursively turns every `datetime` into an ISO string so the result is plain-JSON
    round-trippable (json.dumps cannot serialize datetime on its own)."""
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: _to_jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_to_jsonable(v) for v in value]
    return value


async def export_customer(input: ExportCustomerInput) -> dict[str, Any]:
    """EC:H5 -- cs.export_customer(customer_id, repo, ledger, clock, redact=True) -> dict.
    A single JSON-serializable object covering the customer row, subscriptions, payments, ledger
    entries, usage events, refunds, cs cases, and the reconstructed timeline (EC:I9, reused as-is).
    """
    customer_id = input.customer_id
    repo = input.repo
    ledger = input.ledger
    clock = input.clock
    should_redact = input.redact

    customer = await repo.customers.get(customer_id)
    subscriptions = await repo.subscriptions.list(customer_id=customer_id)
    payments = await repo.payments.list(customer_id=customer_id)
    ledger_entries = await ledger.entries(customer_id)
    usage_events = await repo.usage_events.list(customer_id=customer_id)
    refunds = await repo.refunds.list(customer_id=customer_id)
    cs_cases = await repo.cs_cases.list(customer_id=customer_id)
    tl = await timeline(
        TimelineOptions(customer_id=customer_id, repo=repo, ledger=ledger, clock=clock)
    )

    raw: dict[str, Any] = {
        "schema_version": 1,
        "generated_at": clock.now(),
        "customer_id": customer_id,
        "redacted": should_redact,
        "customer": _to_dict(customer) if customer is not None else None,
        "subscriptions": [_to_dict(s) for s in subscriptions],
        "payments": [_to_dict(p) for p in payments],
        "ledger_entries": [_to_dict(e) for e in ledger_entries],
        "usage_events": [_to_dict(e) for e in usage_events],
        "refunds": [_to_dict(r) for r in refunds],
        "cs_cases": [_to_dict(c) for c in cs_cases],
        "timeline": _to_dict(tl),
    }

    shaped = redact(raw) if should_redact else raw
    return _to_jsonable(shaped)
