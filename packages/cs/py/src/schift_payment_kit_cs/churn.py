"""spec/cs.pseudo.md — EC:I4"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from schift_payment_kit_core import Clock, CsCase, Repo

from .cases import CsMetricEvent, OnCaseEvent

ChurnReason = Literal[
    "too_expensive",
    "not_using",
    "missing_feature",
    "bugs",
    "switched_competitor",
    "temporary",
    "other",
]


@dataclass(kw_only=True, slots=True)
class ChurnRecordInput:
    customer_id: str
    reason: ChurnReason
    text: str | None = None
    # CsCase already carries churn_reason/churn_text (core types.py) -- recorded onto it when given.
    case: CsCase | None = None
    repo: Repo | None = None
    clock: Clock | None = None
    on_case_event: OnCaseEvent | None = None


@dataclass(kw_only=True, slots=True)
class ChurnRecord:
    customer_id: str
    reason: ChurnReason
    text: str | None
    recorded_at: datetime | None


async def record(input: ChurnRecordInput) -> ChurnRecord:
    """EC:I4 -- cs.churn.record({customer_id, reason, text}). A bare customer_id-only call (no `case`)
    has nowhere to persist under the current Repo contract (no churn_reasons table) -- see spec's
    contract-gap note. When `case` is given, this writes onto CsCase.churn_reason/churn_text (always
    collected; surfacing it to the merchant is a paid feature -- this function only records, never gates
    access).
    """
    now = input.clock.now() if input.clock else None
    if input.case is not None:
        input.case.churn_reason = input.reason
        input.case.churn_text = input.text
        if input.repo is not None:
            await input.repo.cs_cases.put(input.case)
        if input.on_case_event:
            input.on_case_event(
                CsMetricEvent(
                    type="churn",
                    case=input.case,
                    at=now or input.case.opened_at,
                    churn_reason=input.reason,
                )
            )
    return ChurnRecord(
        customer_id=input.customer_id,
        reason=input.reason,
        text=input.text,
        recorded_at=now,
    )
