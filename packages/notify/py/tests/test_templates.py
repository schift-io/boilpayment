"""templates.render() coverage for every NotifyType (the full union from boilpayment_core.types),
both locales. The rule checked is the contract, not the wording: a payload carrying the fields its
senders send leaves no ``{placeholder}`` in the subject or text (EC:I11). Real sender payloads are
rendered in packages/sdk/py/tests/test_round7_notify.py.

pytest-asyncio is not installed; render() is synchronous here so no asyncio.run() needed.
"""

from __future__ import annotations

import re

import pytest
from boilpayment_notify import render, templates

# The exhaustive NotifyType union, per packages/core/py/src/boilpayment_core/types.py.
NOTIFY_TYPES = [
    "payment.failed",
    "grace.started",
    "grace.ending",
    "subscription.canceled",
    "refund.executed",
    "cs.needs_human",
    "reconcile.mismatch",
    "card.expiring",
    "usage.soft_cap",
    "credits.expiring",
]

# The fields each type's senders carry (the kit's own senders use snake_case keys).
FIXTURES = {
    "payment.failed": {"subscription_id": "sub_1", "grace_until": "2026-09-16T00:00:00.000Z"},
    "grace.started": {"subscription_id": "sub_1", "grace_until": "2026-09-16T00:00:00.000Z", "grace_days": 7},
    "grace.ending": {"subscription_id": "sub_1", "grace_until": "2026-09-16T00:00:00.000Z"},
    "subscription.canceled": {"detail": "canceled at period end"},
    "refund.executed": {"amount": "$25.00"},
    "cs.needs_human": {"case_id": "case_1", "kind": "refund", "customer_id": "cust_1"},
    "reconcile.mismatch": {"customer_id": "cust_1", "detail": "2 payments, 1 grant"},
    "card.expiring": {"expires_at": "2026-10-01"},
    "usage.soft_cap": {"meter": "api_call", "overage": 2, "included": 5},
    "credits.expiring": {"amount": 120, "expires_at": "2026-03-01"},
}

_PLACEHOLDER = re.compile(r"\{\w+\}")


def test_templates_dict_has_exactly_the_10_notify_types_with_en_and_ko():
    assert sorted(templates.keys()) == sorted(NOTIFY_TYPES)
    assert sorted(FIXTURES) == sorted(NOTIFY_TYPES)
    for t in NOTIFY_TYPES:
        assert callable(templates[t].en)
        assert callable(templates[t].ko)


@pytest.mark.parametrize("kind", NOTIFY_TYPES)
@pytest.mark.parametrize("locale", ["en", "ko"])
def test_every_placeholder_is_filled(kind: str, locale: str) -> None:
    out = render(kind, locale, FIXTURES[kind])
    assert out.subject and out.text
    assert not _PLACEHOLDER.search(f"{out.subject} {out.text}"), out.text


def test_a_field_a_template_does_not_name_still_reaches_a_person_through_detail() -> None:
    """EC:I11 -- {detail} lists every payload field (camelCase, as in TS)."""
    out = render("cs.needs_human", "en", {"customer_id": "c1", "kind": "renewal_double_charge", "payment_id": "pay_2"})
    assert "paymentId=pay_2" in out.text
    assert not _PLACEHOLDER.search(out.text)
