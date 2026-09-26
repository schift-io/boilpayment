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

_TS = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$")


def iso_z(dt: datetime) -> str:
    utc = dt.astimezone(UTC)
    return utc.strftime("%Y-%m-%dT%H:%M:%S.") + f"{utc.microsecond // 1000:03d}Z"


def key_matches_instant(key: str, prefix: str, at: datetime) -> bool:
    """True when ``key`` is ``prefix + <timestamp>`` and that timestamp is the same instant as ``at``."""
    if key == prefix + iso_z(at):
        return True
    if not key.startswith(prefix):
        return False
    rest = key[len(prefix):]
    if not _TS.match(rest):
        return False
    try:
        parsed = datetime.fromisoformat(rest)
    except ValueError:
        return False
    if parsed.tzinfo is None:
        return False
    return int(parsed.timestamp() * 1000) == int(at.timestamp() * 1000)
