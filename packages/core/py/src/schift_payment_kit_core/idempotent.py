"""Operation-level idempotency. See spec/core.pseudo.md [EC:J1 J2 J3 J4 J5].
Mirrors packages/core/ts/src/idempotent.ts exactly.

Design note (documents the "choose one" in the task brief): results are made JSON-safe via
explicit serialize*/deserialize* helpers per entity (datetime <-> ISO strings), NOT by re-reading
the entity from Repo/LedgerStore on replay. Re-read-by-id was preferred where it was cheap, but
LedgerStore has no get(id) -- a grant/clawback/revoke LedgerEntry result cannot be re-fetched by
id at all -- so a single consistent strategy (serialize the whole result) is used for every call
site instead of mixing two strategies.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass, is_dataclass, replace
from datetime import datetime
from typing import Any, Protocol, TypeVar

from .types import (
    CsCase,
    LedgerEntry,
    LedgerReference,
    Operation,
    PaymentKitError,
    Refund,
    Repo,
    Subscription,
)

R = TypeVar("R")


class _ClockLike(Protocol):
    def now(self) -> datetime: ...


# ── Stable JSON hashing (EC:J1/J2 -- same payload vs different payload) ─────────────────────


def _sort_for_hash(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    if is_dataclass(value) and not isinstance(value, type):
        # Payload fields are often real dataclass instances (e.g. RefundDecision) passed straight
        # through by a caller, unlike TS where JSON.stringify duck-types plain objects for free.
        return _sort_for_hash(asdict(value))
    if isinstance(value, (list, tuple)):
        return [_sort_for_hash(v) for v in value]
    if isinstance(value, dict):
        return {k: _sort_for_hash(value[k]) for k in sorted(value.keys())}
    return value


def stable_stringify(value: Any) -> str:
    return json.dumps(_sort_for_hash(value), separators=(",", ":"))


def hash_payload(payload: Any) -> str:
    return hashlib.sha256(stable_stringify(payload).encode()).hexdigest()


# ── run_idempotent ───────────────────────────────────────────────────────────────────────────


@dataclass(kw_only=True, slots=True)
class RunIdempotentResult:
    result: Any
    replayed: bool


# EC:J1 same op retried after partial failure -> replay stored result, no re-execution.
# EC:J2 same key + different payload -> 'idempotency_key_reused'.
# EC:J3 in-flight duplicate -> 'idempotency_in_progress'.
# EC:J4 retention/TTL is documented policy (default 7 days), not enforced here -- see EDGE_CASES.md §J.
async def run_idempotent(
    *,
    repo: Repo,
    key: str,
    kind: str,
    payload: Any,
    clock: _ClockLike,
    fn: Callable[[], Awaitable[R]],
    serialize: Callable[[R], Any] | None = None,
    deserialize: Callable[[Any], R] | None = None,
) -> RunIdempotentResult:
    serialize = serialize or (lambda r: r)
    deserialize = deserialize or (lambda s: s)
    payload_hash = hash_payload(payload)

    base = await repo.operations.claim(Operation(
        id=key, key=key, kind=kind, payload_hash=payload_hash, status="in_progress",
        result=None, error=None, created_at=clock.now(), completed_at=None, attempts=1,
    ))
    if base is None:
        existing = await repo.operations.get(key)
        if existing is not None and existing.payload_hash != payload_hash:
            raise PaymentKitError(f"idempotency key reused with a different payload: {key}", "idempotency_key_reused", {"key": key, "kind": existing.kind})
        if existing is not None and existing.status == "done":
            await repo.operations.put(replace(existing, attempts=existing.attempts + 1))
            return RunIdempotentResult(result=deserialize(existing.result), replayed=True)
        raise PaymentKitError(f"operation already in progress: {key}", "idempotency_in_progress", {"key": key, "kind": kind})

    try:
        result = await fn()
        await repo.operations.put(
            replace(
                base, status="done", result=serialize(result), completed_at=clock.now()
            )
        )
        return RunIdempotentResult(result=result, replayed=False)
    except Exception as err:
        await repo.operations.put(
            replace(base, status="failed", error=str(err), completed_at=clock.now())
        )
        raise


# ── Entity serialize/deserialize helpers (datetime <-> ISO string) ──────────────────────────
# Used to build the serialize/deserialize pair for each wired call site's result shape.


def serialize_subscription(s: Subscription) -> dict[str, Any]:
    d = asdict(s)
    d["current_period"] = {
        "start": s.current_period.start.isoformat(),
        "end": s.current_period.end.isoformat(),
    }
    d["grace_until"] = s.grace_until.isoformat() if s.grace_until else None
    d["created_at"] = s.created_at.isoformat()
    return d


def deserialize_subscription(v: dict[str, Any]) -> Subscription:
    from .types import Period

    d = dict(v)
    cp = d.pop("current_period")
    grace_until = d.pop("grace_until")
    created_at = d.pop("created_at")
    d.pop("id", None)
    return Subscription(
        id=v["id"],
        current_period=Period(start=_parse_dt(cp["start"]), end=_parse_dt(cp["end"])),
        grace_until=_parse_dt(grace_until) if grace_until else None,
        created_at=_parse_dt(created_at),
        **{
            k: v2
            for k, v2 in d.items()
            if k not in ("current_period", "grace_until", "created_at")
        },
    )


def serialize_ledger_entry(e: LedgerEntry | None) -> dict[str, Any] | None:
    if e is None:
        return None
    d = asdict(e)
    d["expires_at"] = e.expires_at.isoformat() if e.expires_at else None
    d["created_at"] = e.created_at.isoformat()
    ref = dict(d["reference"])
    ref["period_start"] = (
        e.reference.period_start.isoformat() if e.reference.period_start else None
    )
    d["reference"] = ref
    return d


def deserialize_ledger_entry(v: dict[str, Any] | None) -> LedgerEntry | None:
    if v is None:
        return None
    d = dict(v)
    d["expires_at"] = _parse_dt(d["expires_at"]) if d.get("expires_at") else None
    d["created_at"] = _parse_dt(d["created_at"])
    ref = dict(d["reference"])
    ref["period_start"] = (
        _parse_dt(ref["period_start"]) if ref.get("period_start") else None
    )
    d["reference"] = LedgerReference(**ref)
    return LedgerEntry(**d)


def serialize_refund(r: Refund) -> dict[str, Any]:
    d = asdict(r)
    d["created_at"] = r.created_at.isoformat()
    return d


def deserialize_refund(v: dict[str, Any]) -> Refund:
    d = dict(v)
    d["created_at"] = _parse_dt(d["created_at"])
    from .types import Money, PaymentFailure

    d["amount"] = Money(**d["amount"])
    if d.get("failure"):
        d["failure"] = PaymentFailure(**d["failure"])
    return Refund(**d)


def serialize_cs_case(c: CsCase) -> dict[str, Any]:
    from .policy import policy_to_dict

    d = asdict(c)
    d["opened_at"] = c.opened_at.isoformat()
    d["resolved_at"] = c.resolved_at.isoformat() if c.resolved_at else None
    d["policy_snapshot"] = policy_to_dict(c.policy_snapshot)
    return d


def deserialize_cs_case(v: dict[str, Any]) -> CsCase:
    from .policy import policy_from_dict

    d = dict(v)
    d["opened_at"] = _parse_dt(d["opened_at"])
    d["resolved_at"] = _parse_dt(d["resolved_at"]) if d.get("resolved_at") else None
    d["policy_snapshot"] = policy_from_dict(d["policy_snapshot"])
    return CsCase(**d)


def _parse_dt(v: str) -> datetime:
    return datetime.fromisoformat(v)
