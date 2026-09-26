"""Webhook timestamps must support comparisons with aware policy clocks."""

from datetime import UTC, datetime

import pytest
from schift_payment_kit_toss import map_toss_webhook


def test_offset_free_webhook_time_is_aware() -> None:
    # Given Toss's documented offset-free createdAt representation.
    body = {
        "eventType": "PAYMENT_STATUS_CHANGED",
        "createdAt": "2022-05-12T00:00:00.000",
        "data": {"paymentKey": "test-payment", "status": "DONE"},
    }
    # When a webhook is normalized.
    event = map_toss_webhook(body)
    # Then its instant is usable with the core's timezone-aware clock.
    assert event.occurred_at == datetime(2022, 5, 11, 15, tzinfo=UTC)


@pytest.mark.parametrize(
    ("timestamp", "expected"),
    [
        ("2022-05-12T00:00:00+09:00", datetime(2022, 5, 11, 15, tzinfo=UTC)),
        ("2022-05-12T00:00:00Z", datetime(2022, 5, 12, tzinfo=UTC)),
        ("2022-05-12T00:00:00-04:00", datetime(2022, 5, 12, 4, tzinfo=UTC)),
    ],
)
def test_explicit_webhook_offset_preserves_instant(
    timestamp: str, expected: datetime,
) -> None:
    # Given a webhook whose timestamp includes its offset.
    body = {
        "eventType": "PAYMENT_STATUS_CHANGED",
        "createdAt": timestamp,
        "data": {"paymentKey": "test-payment", "status": "DONE"},
    }
    # When a webhook is normalized.
    event = map_toss_webhook(body)
    # Then the timestamp retains its original instant.
    assert event.occurred_at == expected
    assert event.id.endswith(timestamp)
