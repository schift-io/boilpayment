"""EC:G4 — Clock DI. All module functions take `clock` as a dependency; nothing calls
`datetime.now()` directly except the SystemClock implementation itself.
Mirrors packages/core/ts/src/clock.ts exactly.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta


class SystemClock:
    def now(self) -> datetime:
        return datetime.now(UTC)


class FixedClock:
    """Fixed point in time for tests/repro. `advance(ms)` moves it forward (or back with negative ms)."""

    def __init__(self, date: datetime) -> None:
        self._current = date

    def now(self) -> datetime:
        return self._current

    def advance(self, ms: int) -> None:
        self._current = self._current + timedelta(milliseconds=ms)


class UuidIdGen:
    def new_id(self) -> str:
        return str(uuid.uuid4())


class SequentialIdGen:
    """Deterministic, human-readable ids for tests/repro: prefix + incrementing counter."""

    def __init__(self, prefix: str) -> None:
        self._prefix = prefix
        self._counter = 0

    def new_id(self) -> str:
        self._counter += 1
        return f"{self._prefix}{self._counter}"
