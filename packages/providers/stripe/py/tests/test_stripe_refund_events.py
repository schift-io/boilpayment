from typing import Literal, TypedDict

import pytest
from schift_payment_kit_stripe import to_normalized_event


class RefundPayload(TypedDict):
    id: str
    object: Literal["refund"]
    amount: int
    currency: str
    payment_intent: str
    status: str | None


@pytest.mark.parametrize(
    "event_type", ["refund.created", "refund.updated", "charge.refund.updated"]
)
@pytest.mark.parametrize(
    "status,expected",
    [
        ("pending", "refund.pending"),
        ("requires_action", "refund.pending"),
        (None, "refund.pending"),
        ("succeeded", "refund.created"),
        ("failed", "refund.failed"),
        ("canceled", "refund.failed"),
    ],
)
def test_refund_identity_and_status(event_type: str, status: str | None, expected: str):
    refund: RefundPayload = {
        "id": "re_actual",
        "object": "refund",
        "amount": 250,
        "currency": "usd",
        "payment_intent": "pi_actual",
        "status": status,
    }
    normalized = to_normalized_event(
        {
            "id": "evt_delivery",
            "type": event_type,
            "created": 1735689600,
            "data": {"object": refund},
        }
    )
    assert normalized.type == expected
    assert normalized.id == "evt_delivery"
    assert normalized.refund_ref == "re_actual"
    assert normalized.payment_ref == "pi_actual"
    assert normalized.amount is not None
    assert normalized.amount.amount_minor == 250


def test_refund_failed_preserves_refund_reference():
    normalized = to_normalized_event(
        {
            "id": "evt_failed",
            "type": "refund.failed",
            "created": 1735689600,
            "data": {
                "object": {
                    "id": "re_actual",
                    "status": "failed",
                    "amount": 250,
                    "currency": "usd",
                }
            },
        }
    )
    assert normalized.type == "refund.failed"
    assert normalized.refund_ref == "re_actual"
