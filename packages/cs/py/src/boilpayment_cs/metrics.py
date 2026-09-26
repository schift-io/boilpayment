"""spec/cs.pseudo.md — Metrics (I4/I5 support), CaseMeter (I5), LicenseReporter"""

from __future__ import annotations

import asyncio
import json
import urllib.error
import urllib.request
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol

from boilpayment_core import CsCaseKind, CsCaseStatus, OutboxItem, Repo

from .cases import BILLABLE_STATUSES, CsMetricEvent


@dataclass(kw_only=True, slots=True)
class MetricsSnapshot:
    counts_by_kind: dict[str, int]
    counts_by_status: dict[str, int]
    durations_ms_by_kind: dict[str, list[int]]
    churn_reasons: dict[str, int]


class Metrics:
    """In-memory `on_case_event` collector. Not persisted -- a process-local view for dashboards/tests."""

    def __init__(self) -> None:
        self._events: list[CsMetricEvent] = []

    def record(self, event: CsMetricEvent) -> None:
        """Bind as `on_case_event` to open_case/escalate/resolve/reject/churn.record."""
        self._events.append(event)

    def snapshot(self) -> MetricsSnapshot:
        counts_by_kind: dict[str, int] = {}
        counts_by_status: dict[str, int] = {}
        durations_ms_by_kind: dict[str, list[int]] = {}
        churn_reasons: dict[str, int] = {}

        for e in self._events:
            if e.type == "opened":
                counts_by_kind[e.case.kind] = counts_by_kind.get(e.case.kind, 0) + 1
            if e.type in ("escalated", "resolved"):
                counts_by_status[e.case.status] = (
                    counts_by_status.get(e.case.status, 0) + 1
                )
            if e.type == "resolved" and e.case.resolved_at:
                ms = int((e.case.resolved_at - e.case.opened_at).total_seconds() * 1000)
                durations_ms_by_kind.setdefault(e.case.kind, []).append(ms)
            if e.type == "churn" and e.churn_reason:
                churn_reasons[e.churn_reason] = churn_reasons.get(e.churn_reason, 0) + 1

        return MetricsSnapshot(
            counts_by_kind=counts_by_kind,
            counts_by_status=counts_by_status,
            durations_ms_by_kind=durations_ms_by_kind,
            churn_reasons=churn_reasons,
        )


class CaseMeter:
    """EC:I5 -- 1 CsCase row = 1 billable unit once resolved_auto/resolved_human/rejected."""

    def __init__(self, repo: Repo) -> None:
        self._repo = repo

    async def count_billable(self, **filter: Any) -> int:
        cases = await self._repo.cs_cases.list(**filter)
        return len([c for c in cases if c.status in BILLABLE_STATUSES])


@dataclass(kw_only=True, slots=True)
class CaseReportInput:
    """EC:I5 -- one call per billable case transition (resolved_auto/resolved_human/rejected)."""

    case_id: str
    kind: CsCaseKind
    status: CsCaseStatus
    occurred_at: datetime
    tenant_ref: str | None = None


@dataclass(kw_only=True, slots=True)
class Entitlement:
    """GET {base_url}/entitlement response. Pricing/tiers are DB-based on Schift's server
    (docs/CS_SERVER.md) -- the SDK only reports usage and asks entitlement, never computes price."""

    tier: str
    included_cases_per_month: int
    used_this_month: int
    overage_price_minor: int
    currency: str
    hard_limit: bool


class LicenseReporter(Protocol):
    """EC:I5 -- reports billable case transitions to Schift's server (API-key auth) and asks
    entitlement. Implementations MUST be offline-safe: a failed report_case/entitlement/heartbeat
    call never raises into the caller's business logic (resolve/reject/regrant/refund_assist/
    dispute all call this synchronously in their success path)."""

    async def report_case(self, input: CaseReportInput) -> None: ...
    async def entitlement(self) -> Entitlement | None: ...
    async def heartbeat(self) -> None: ...


class NoopLicenseReporter:
    """v0 stub -- used by tests/smokes and as the default when no api_key is configured."""

    async def report_case(self, input: CaseReportInput) -> None:
        return None

    async def entitlement(self) -> Entitlement | None:
        return None

    async def heartbeat(self) -> None:
        return None


_DEFAULT_BASE_URL = "https://api.schift.io/paykit/v1"  # placeholder -- owner must confirm (docs/CS_SERVER.md)

# Injectable HTTP call: (method, url, headers, body_bytes_or_None) -> (status, response_bytes)
_HttpCall = Callable[
    [str, str, dict[str, str], bytes | None], Awaitable[tuple[int, bytes]]
]


async def _default_http_call(
    method: str, url: str, headers: dict[str, str], body: bytes | None
) -> tuple[int, bytes]:
    """No httpx in cs's py deps (ARCHITECTURE.md -- no new dependencies) -- urllib.request run in a
    thread via asyncio.to_thread keeps this async without blocking the event loop."""

    def _do() -> tuple[int, bytes]:
        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    return await asyncio.to_thread(_do)


class HttpLicenseReporter:
    """EC:I5 -- real HTTP client for the CS SDK license server (docs/CS_SERVER.md). Offline-safe:
    network/HTTP failures in report_case/entitlement/heartbeat are caught and never raised. A
    failed report_case is queued in-memory; call flush() to retry (e.g. from a cron/outbox sweeper).
    """

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str = _DEFAULT_BASE_URL,
        http_call: _HttpCall | None = None,
        repo: Repo | None = None,
    ) -> None:
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._http_call = http_call or _default_http_call
        self._repo = repo
        self._buffer: list[CaseReportInput] = []

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }

    def _serialize(self, input: CaseReportInput) -> dict[str, Any]:
        return {
            "caseId": input.case_id,
            "kind": input.kind,
            "status": input.status,
            "tenantRef": input.tenant_ref,
            "occurredAt": input.occurred_at.isoformat(),
        }

    async def report_case(self, input: CaseReportInput) -> None:
        """POST {base_url}/cases -- idempotent by case_id on the server. Never raises."""
        try:
            status, _ = await self._http_call(
                "POST",
                f"{self._base_url}/cases",
                self._headers(),
                json.dumps(self._serialize(input)).encode(),
            )
            if status >= 300:
                raise RuntimeError(f"cs license report_case failed: HTTP {status}")
        except Exception:  # noqa: BLE001 -- license reporter never throws (EC:I5)
            await self._enqueue(input)

    async def _enqueue(self, input: CaseReportInput) -> None:
        self._buffer.append(input)
        if self._repo is not None:
            await self._repo.outbox.put(
                OutboxItem(
                    id=f"cs.license:{input.case_id}",
                    kind="cs.license",
                    payload=self._serialize(input),
                    status="pending",
                    attempts=0,
                    next_attempt_at=input.occurred_at,
                    created_at=input.occurred_at,
                )
            )

    async def flush(self) -> dict[str, int]:
        """Retries every queued report_case. Items that still fail stay queued for the next flush()."""
        pending, self._buffer = self._buffer, []
        sent = 0
        for item in pending:
            try:
                status, _ = await self._http_call(
                    "POST",
                    f"{self._base_url}/cases",
                    self._headers(),
                    json.dumps(self._serialize(item)).encode(),
                )
                if status >= 300:
                    raise RuntimeError(f"cs license report_case failed: HTTP {status}")
                sent += 1
                if self._repo is not None:
                    row = await self._repo.outbox.get(f"cs.license:{item.case_id}")
                    if row is not None:
                        row.status = "sent"
                        await self._repo.outbox.put(row)
            except Exception:  # noqa: BLE001 -- license reporter never throws (EC:I5)
                self._buffer.append(item)
        return {"sent": sent, "remaining": len(self._buffer)}

    async def entitlement(self) -> Entitlement | None:
        """GET {base_url}/entitlement. Returns None on any failure (offline-safe)."""
        try:
            status, body = await self._http_call(
                "GET", f"{self._base_url}/entitlement", self._headers(), None
            )
            if status >= 300:
                return None
            data = json.loads(body)
            return Entitlement(
                tier=data["tier"],
                included_cases_per_month=data["includedCasesPerMonth"],
                used_this_month=data["usedThisMonth"],
                overage_price_minor=data["overagePriceMinor"],
                currency=data["currency"],
                hard_limit=data["hardLimit"],
            )
        except Exception:  # noqa: BLE001 -- license reporter never throws (EC:I5)
            return None

    async def heartbeat(self) -> None:
        """POST {base_url}/heartbeat. Best-effort, never raises, no queueing (point-in-time)."""
        try:
            await self._http_call(
                "POST", f"{self._base_url}/heartbeat", self._headers(), None
            )
        except Exception:  # noqa: BLE001, S110 -- heartbeat is best-effort (EC:I5)
            pass  # offline-safe -- dropped silently
