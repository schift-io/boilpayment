"""EC:J11 -- canonical time in keys.

Every idempotency / grant / period key built from a date uses ``iso_z`` (UTC, milliseconds,
'Z' -- the TS ``Date.toISOString()`` form), identical in TS and Python and independent of the
database session time zone. ``key_matches_instant`` also recognises keys written before this rule
(``datetime.isoformat()`` forms such as ``+09:00`` / ``+00:00``), so an upgrade never grants a
second time for a period granted under an old key.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Any

_TS = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$")


def iso_z(dt: datetime) -> str:
    utc = dt.astimezone(UTC)
    return utc.strftime("%Y-%m-%dT%H:%M:%S.") + f"{utc.microsecond // 1000:03d}Z"


def key_matches_instant(key: str, prefix: str, at: datetime, suffix: str = "") -> bool:
    """True when ``key`` is ``prefix + <timestamp> + suffix`` and that timestamp is the same instant as ``at``."""
    if key == prefix + iso_z(at) + suffix:
        return True
    if not key.startswith(prefix) or not key.endswith(suffix) or len(key) < len(prefix) + len(suffix):
        return False
    rest = key[len(prefix):len(key) - len(suffix)] if suffix else key[len(prefix):]
    if not _TS.match(rest):
        return False
    try:
        parsed = datetime.fromisoformat(rest)
    except ValueError:
        return False
    if parsed.tzinfo is None:
        return False
    return int(parsed.timestamp() * 1000) == int(at.timestamp() * 1000)


# EC:J13 (A7-3) -- a key an earlier release wrote with datetime.isoformat() ("...T09:00:00+09:00")
# names the same instant as today's iso_z key. Every date-bearing key is looked up in any form before a
# new one is written, so an upgrade never repeats a revoke, a restore, a charge or an operation.


async def ledger_instant_key(ledger: Any, customer_id: str, prefix: str, at: datetime, suffix: str = "") -> str:
    """The ledger key for ``prefix + <at> + suffix``: the one already written in any form, else the iso_z one."""
    for e in await ledger.entries(customer_id):
        if key_matches_instant(e.idempotency_key, prefix, at, suffix):
            return e.idempotency_key
    return prefix + iso_z(at) + suffix


async def operation_instant_key(repo: Any, kind: str, prefix: str, at: datetime) -> tuple[str, str]:
    """``(key, stamp)`` for the run_idempotent key ``prefix + <at>``: an earlier release's key in an older
    form when one exists (no iso_z key yet), else the iso_z key. ``stamp`` is the timestamp text inside the
    key; payloads hash that same text, so the earlier operation replays instead of being refused."""
    stamp = iso_z(at)
    if await repo.operations.get(prefix + stamp) is None:
        for op in await repo.operations.list(kind=kind):
            if op.key != prefix + stamp and key_matches_instant(op.key, prefix, at):
                return op.key, op.key[len(prefix):]
    return prefix + stamp, stamp
