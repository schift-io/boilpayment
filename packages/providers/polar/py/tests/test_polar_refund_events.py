from typing import TypedDict

import pytest
from schift_payment_kit_polar import to_normalized_event


class RefundPayload(TypedDict):
    id: str
    order_id: str
    customer_id: str
    subscription_id: str
    amount: int
    currency: str
    status: str | None


@pytest.mark.parametrize("event_type", ["refund.created", "refund.updated"])
@pytest.mark.parametrize(
    "status,expected",
    [
        ("pending", "refund.pending"),
        (None, "refund.pending"),
        ("succeeded", "refund.created"),
        ("failed", "refund.failed"),
        ("canceled", "refund.failed"),
    ],
)
def test_refund_identity_and_status(event_type: str, status: str | None, expected: str):
    data: RefundPayload = {
        "id": "refund_actual",
        "order_id": "order_actual",
        "customer_id": "customer_actual",
        "subscription_id": "sub_actual",
        "amount": 250,
        "currency": "usd",
        "status": status,
    }
    normalized = to_normalized_event(
        {
            "type": event_type,
            "id": "delivery_actual",
            "timestamp": "2026-01-01T00:00:00Z",
            "data": data,
        }
    )
    assert normalized.type == expected
    assert normalized.id == "delivery_actual"
    assert normalized.refund_ref == "refund_actual"
    assert normalized.payment_ref == "order_actual"
    assert normalized.subscription_ref == "sub_actual"
    assert normalized.amount is not None
    assert normalized.amount.amount_minor == 250


def test_aggregate_order_refund_has_no_singular_refund():
    normalized = to_normalized_event(
        {"type": "order.refunded", "data": {"id": "order_actual"}}
    )
    assert normalized.type == "unknown"
    assert normalized.refund_ref is None
