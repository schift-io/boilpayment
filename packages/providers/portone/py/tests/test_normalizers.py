"""Phase 6 regression tests — pure normalizers. Fixtures mirror py/examples/smoke.py
and spec/portone.pseudo.md. No network calls.
"""

from __future__ import annotations

from schift_payment_kit_portone import (
    map_portone_webhook,
    normalize_portone_cash_receipt,
    normalize_portone_failure,
    normalize_portone_payment,
    normalize_portone_status,
)


def test_ec_e8_status_table() -> None:
    table = [
        ("READY", "pending"),
        (
            "PAY_PENDING",
            "pending",
        ),  # real V2 status literal (verified against the OpenAPI spec)
        ("VIRTUAL_ACCOUNT_ISSUED", "pending"),
        ("PAID", "succeeded"),
        ("FAILED", "failed"),
        ("CANCELLED", "refunded"),
        ("PARTIAL_CANCELLED", "partially_refunded"),
    ]
    for raw, expected in table:
        assert normalize_portone_status(raw) == expected, f"[EC:E8] {raw} -> {expected}"


def test_ec_e8_virtual_account_issued_maps_to_pending_not_succeeded() -> None:
    # EC:E8 — grants only happen on PAID; VIRTUAL_ACCOUNT_ISSUED must never read as succeeded.
    assert normalize_portone_status("VIRTUAL_ACCOUNT_ISSUED") == "pending"


def test_ec_e8_unknown_status_falls_back_to_pending() -> None:
    assert normalize_portone_status("SOME_NEW_STATUS") == "pending"


def test_ec_e9_null_failure_is_none() -> None:
    assert normalize_portone_failure(None) is None
    assert normalize_portone_failure({}) is None


def test_ec_e9_insufficient_pgcode_maps_to_insufficient_funds() -> None:
    f = normalize_portone_failure(
        {"pgCode": "INSUFFICIENT_BALANCE", "pgMessage": "잔액이 부족합니다."}
    )
    assert f is not None
    assert f.code == "insufficient_funds"
    assert f.provider_code == "INSUFFICIENT_BALANCE"
    assert f.retryable is False
    assert f.user_message == "잔액이 부족합니다."


def test_ec_e9_expired_pgcode_maps_to_expired_card() -> None:
    f = normalize_portone_failure({"pgCode": "CARD_EXPIRED", "pgMessage": "expired"})
    assert f is not None
    assert f.code == "expired_card"
    assert f.retryable is False


def test_ec_e9_decline_pgcode_maps_to_card_declined() -> None:
    f = normalize_portone_failure({"pgCode": "CARD_DECLINED"})
    assert f is not None
    assert f.code == "card_declined"


def test_ec_e9_reject_pgcode_maps_to_card_declined() -> None:
    f = normalize_portone_failure({"pgCode": "ISSUER_REJECT"})
    assert f is not None
    assert f.code == "card_declined"


def test_ec_e9_timeout_network_unavailable_map_to_provider_unavailable_retryable() -> (
    None
):
    for code in ("GATEWAY_TIMEOUT", "NETWORK_ERROR", "PG_UNAVAILABLE"):
        f = normalize_portone_failure({"pgCode": code})
        assert f is not None
        assert f.code == "provider_unavailable", f"[EC:E9] {code}"
        assert f.retryable is True, f"[EC:E9] {code} must be retryable"


def test_ec_e9_unrecognized_pgcode_maps_to_unknown_preserves_provider_code() -> None:
    f = normalize_portone_failure({"pgCode": "SOME_WEIRD_PG_CODE", "pgMessage": "huh"})
    assert f is not None
    assert f.code == "unknown"
    assert f.retryable is False
    assert f.provider_code == "SOME_WEIRD_PG_CODE"
    assert f.user_message == "huh"


def test_ec_e9_falls_back_to_reason_then_default_korean_message() -> None:
    f1 = normalize_portone_failure({"pgCode": "X", "reason": "card issuer down"})
    assert f1 is not None
    assert f1.user_message == "card issuer down"
    f2 = normalize_portone_failure({"pgCode": "X"})
    assert f2 is not None
    assert f2.user_message == "결제에 실패했습니다."


PAID_FIXTURE = {
    "id": "example-payment-id",
    "status": "PAID",
    "amount": {"total": 15000, "taxFree": 0, "vat": 1364},
    "currency": "KRW",
    "customer": {"id": "cus_abc"},
    "paidAt": "2026-09-01T00:00:05.000Z",
    "requestedAt": "2026-09-01T00:00:00.000Z",
}

FAILED_FIXTURE = {
    "id": "example-payment-failed",
    "status": "FAILED",
    "amount": {"total": 8000},
    "currency": "KRW",
    "customer": {"id": "cus_abc"},
    "requestedAt": "2026-09-01T00:10:00.000Z",
    "failure": {"pgCode": "INSUFFICIENT_BALANCE", "pgMessage": "잔액이 부족합니다."},
}


def test_ec_f_paid_payment_maps_to_succeeded_no_failure() -> None:
    p = normalize_portone_payment(PAID_FIXTURE)
    assert p.status == "succeeded"
    assert p.id == "example-payment-id"
    assert p.customer_id == "cus_abc"
    assert p.amount.amount_minor == 15000
    assert p.amount.currency == "KRW"
    assert p.failure is None
    assert p.occurred_at.isoformat() == "2026-09-01T00:00:05+00:00"


def test_ec_e9_failed_payment_carries_normalized_failure() -> None:
    p = normalize_portone_payment(FAILED_FIXTURE)
    assert p.status == "failed"
    assert p.failure is not None
    assert p.failure.code == "insufficient_funds"
    assert p.failure.provider_code == "INSUFFICIENT_BALANCE"
    assert p.failure.retryable is False
    assert p.failure.user_message == "잔액이 부족합니다."


def test_ec_f_currency_defaults_to_krw_when_absent() -> None:
    p = normalize_portone_payment(
        {
            "id": "p1",
            "status": "PAID",
            "amount": {"total": 100},
            "customer": {},
            "paidAt": "2026-01-01T00:00:00.000Z",
        }
    )
    assert p.amount.currency == "KRW"


def test_ec_e4_webhook_type_table() -> None:
    table = [
        ("Transaction.Paid", "payment.succeeded"),
        ("Transaction.Failed", "payment.failed"),
        ("Transaction.Cancelled", "refund.created"),
        ("Transaction.PartialCancelled", "refund.created"),
        ("Transaction.VirtualAccountIssued", "payment.pending"),
        ("Transaction.PayPending", "payment.pending"),
        ("Transaction.CancelPending", "refund.pending"),
        ("Transaction.DisputeCreated", "dispute.opened"),
        ("Transaction.DisputeResolved", "dispute.closed"),
        ("BillingKey.Issued", "unknown"),
        ("BillingKey.Failed", "unknown"),
        ("BillingKey.Deleted", "unknown"),
        ("SomethingElseEntirely", "unknown"),
    ]
    for event_type, expected in table:
        event = map_portone_webhook(
            {
                "type": event_type,
                "timestamp": "2024-04-25T10:00:00.000Z",
                "data": {"paymentId": "pay_1"},
            }
        )
        assert event.type == expected, f"[EC:E4] {event_type} -> {expected}"
        assert event.provider == "portone"
        assert event.payment_ref == "pay_1"


def test_ec_e4_payment_ref_falls_back_to_none_when_absent() -> None:
    event = map_portone_webhook(
        {
            "type": "BillingKey.Issued",
            "timestamp": "2024-04-25T10:00:00.000Z",
            "data": {"billingKey": "bk_1"},
        }
    )
    assert event.payment_ref is None


def test_ec_k2_k3_issued_cash_receipt_maps_corporate_to_business() -> None:
    receipt = normalize_portone_cash_receipt(
        {
            "status": "ISSUED",
            "paymentId": "pay_1",
            "type": "CORPORATE",
            "amount": 10000,
            "currency": "KRW",
            "issueNumber": "12345",
            "url": "https://example.com/receipt",
        }
    )
    assert receipt.status == "issued"
    assert receipt.type == "business"
    assert receipt.amount.amount_minor == 10000


def test_ec_k5_cancelled_cash_receipt() -> None:
    receipt = normalize_portone_cash_receipt(
        {"status": "CANCELLED", "paymentId": "pay_1", "amount": 10000}
    )
    assert receipt.status == "canceled"


def test_ec_k6_issue_failed_cash_receipt() -> None:
    receipt = normalize_portone_cash_receipt({"status": "ISSUE_FAILED", "paymentId": "pay_1"})
    assert receipt.status == "issue_failed"
