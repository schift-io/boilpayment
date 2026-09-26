"""[EC:J8] Amounts from Toss are checked at the provider boundary (mirrors the TS test)."""
from __future__ import annotations

import pytest
from boilpayment_toss import map_toss_webhook


def _body(total):
    return {"eventType": "PAYMENT_STATUS_CHANGED", "createdAt": "2026-01-01T00:00:00+09:00",
            "data": {"paymentKey": "pk_1", "orderId": "o_1", "status": "DONE", "totalAmount": total, "currency": "KRW"}}


def test_ec_j8_whole_amount_passes() -> None:
    assert map_toss_webhook(_body(5000)).amount.amount_minor == 5000


@pytest.mark.parametrize("n", [1.5, 2**53])
def test_ec_j8_unsafe_amount_refused(n) -> None:
    with pytest.raises((TypeError, ValueError)):
        map_toss_webhook(_body(n))
