"""EC:L1 L2 -- Logger DI + redaction. Mirrors packages/core/ts/src/logger.ts exactly.
See docs/EDGE_CASES.md §L.

Design: `redact()` runs INSIDE `BaseLogger.log()`, not at call sites -- a call site can pass a raw
provider request/response body and every real (non-Noop) Logger implementation scrubs it before it
ever reaches console/DB/anywhere else. `NoopLogger` is the default so the kit stays silent unless
an app opts in (see packages/core/py/src/boilpayment_core/types.py `Deps.logger`).
"""

from __future__ import annotations

import json
import re
import sys
from abc import ABC, abstractmethod
from datetime import UTC, datetime
from typing import Any

# ── Redaction ────────────────────────────────────────────────────────────────

# EC:L2 -- normalized (lower-cased, separators stripped) key names that never leave this process
# in the clear. `billingKey`/`billing_key` is MASKED, not dropped -- CS needs to correlate charges
# by billing key, it just never needs the raw value in a log line.
_REDACT_KEYS = {
    "customeridentitynumber",  # 주민등록번호 / 사업자등록번호
    "cardnumber",
    "cardpassword",
    "customerbirthday",
    "secretkey",
    "apikey",
    "apisecret",
    "accesstoken",
    "authorization",
    "webhooksecret",
    "refundreceiveaccount",
}
_MASK_KEYS = {"billingkey"}


def _normalize_key(key: str) -> str:
    return key.lower().replace("_", "").replace("-", "")


def _mask_generic(value: str) -> str:
    """Keeps first 4 / last 4 chars, masks the middle. Falls back to full redaction for short values."""
    if len(value) <= 8:
        return "[redacted]"
    return f"{value[:4]}{'*' * max(4, len(value) - 8)}{value[-4:]}"


# EC:L2 -- card PAN: 13-19 digits, optionally grouped with spaces/dashes, wherever it appears in
# ANY string value (not just under a `card_number`-named key). Keeps first 6 / last 4 per the
# brief; masks the rest with `*`.
_PAN_RE = re.compile(r"\b\d(?:[ -]?\d){12,18}\b")


def _mask_pans_in_string(value: str) -> str:
    def _mask(m: re.Match[str]) -> str:
        digits = m.group(0).replace(" ", "").replace("-", "")
        if len(digits) < 13 or len(digits) > 19:
            return m.group(0)
        first6, last4 = digits[:6], digits[-4:]
        return f"{first6}{'*' * (len(digits) - 10)}{last4}"

    return _PAN_RE.sub(_mask, value)


def redact(value: Any) -> Any:
    """EC:L2 -- deep-clones `value`, replacing values under sensitive keys with `'[redacted]'` (or
    a partial mask for keys in _MASK_KEYS) and masking any string that looks like a card PAN. Safe
    to call on arbitrary provider payloads, webhook bodies, or ledger fields.
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, dict):
        out: dict[Any, Any] = {}
        for k, v in value.items():
            nk = _normalize_key(str(k))
            if nk in _REDACT_KEYS:
                out[k] = "[redacted]"
            elif nk in _MASK_KEYS:
                out[k] = _mask_generic(v) if isinstance(v, str) else "[redacted]"
            else:
                out[k] = redact(v)
        return out
    if isinstance(value, (list, tuple)):
        return [redact(v) for v in value]
    if isinstance(value, str):
        return _mask_pans_in_string(value)
    return value


# ── Logger implementations ──────────────────────────────────────────────────


class NoopLogger:
    """Default -- the kit stays silent unless an app opts into a real Logger. Deliberately skips redact()."""

    async def log(self, entry: dict[str, Any]) -> None:
        return None


class BaseLogger(ABC):
    """EC:L1 -- every concrete Logger extends this so redaction happens exactly once, in one
    place, and can't be forgotten at a call site. Subclasses implement `write()` with the
    already-redacted entry.
    """

    async def log(self, entry: dict[str, Any]) -> None:
        redacted = redact(dict(entry))
        redacted["at"] = entry.get("at") or datetime.now(UTC)
        await self.write(redacted)

    @abstractmethod
    async def write(self, entry: dict[str, Any]) -> None: ...


class ConsoleLogger(BaseLogger):
    async def write(self, entry: dict[str, Any]) -> None:
        level = entry.get("level", "info")
        line = json.dumps(entry, default=str, ensure_ascii=False)
        print(line, file=sys.stderr if level in ("warn", "error") else sys.stdout)


class CollectingLogger(BaseLogger):
    """For tests -- collects every redacted entry in order instead of emitting anywhere."""

    def __init__(self) -> None:
        self.entries: list[dict[str, Any]] = []

    async def write(self, entry: dict[str, Any]) -> None:
        self.entries.append(entry)
