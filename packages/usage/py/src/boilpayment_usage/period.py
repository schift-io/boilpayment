# EC:C2 — previous-period approximation. See spec/usage.pseudo.md design note.
from __future__ import annotations

from datetime import datetime

from boilpayment_core import Period


def previous_period_start(period: Period) -> datetime:
    length = period.end - period.start
    return period.start - length


def hours_between(a: datetime, b: datetime) -> float:
    return abs((b - a).total_seconds()) / 3600.0
