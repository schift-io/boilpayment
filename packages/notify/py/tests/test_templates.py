"""Phase 6 regression tests -- templates.render() exhaustive coverage for every NotifyType
(the full union from schift_payment_kit_core.types), both locales ('en' and 'ko'). Expected
subject/text strings are copied verbatim from
packages/notify/py/src/schift_payment_kit_notify/templates.py (read, not guessed).

pytest-asyncio is not installed; render() is synchronous here so no asyncio.run() needed.
"""

from __future__ import annotations

from schift_payment_kit_notify import render, templates

# The exhaustive NotifyType union, per packages/core/py/src/schift_payment_kit_core/types.py.
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


def test_templates_dict_has_exactly_the_10_notify_types_with_en_and_ko():
    assert sorted(templates.keys()) == sorted(NOTIFY_TYPES)
    for t in NOTIFY_TYPES:
        assert callable(templates[t].en)
        assert callable(templates[t].ko)


def test_notify_payment_failed_en_ko():
    payload = {"amount": "$10.00", "reason": "card_declined"}
    en = render("payment.failed", "en", payload)
    assert en.subject == "Payment failed"
    assert (
        en.text
        == "Your payment of $10.00 failed: card_declined. We will retry during your grace period."
    )
    ko = render("payment.failed", "ko", payload)
    assert ko.subject == "결제 실패"
    assert (
        ko.text
        == "$10.00 결제가 실패했습니다: card_declined. 유예 기간 동안 재시도합니다."
    )


def test_notify_grace_started_en_ko():
    payload = {"graceDays": 7}
    en = render("grace.started", "en", payload)
    assert en.subject == "Payment issue — grace period started"
    assert (
        en.text
        == "We could not process your payment. You have 7 days to update your billing info before service is paused."
    )
    ko = render("grace.started", "ko", payload)
    assert ko.subject == "결제 문제 — 유예 기간 시작"
    assert (
        ko.text
        == "결제를 처리하지 못했습니다. 서비스가 중단되기 전까지 7일의 유예 기간이 있습니다."
    )


def test_notify_grace_ending_en_ko():
    payload = {"graceUntil": "2026-09-16"}
    en = render("grace.ending", "en", payload)
    assert en.subject == "Grace period ending soon"
    assert (
        en.text
        == "Your grace period ends on 2026-09-16. Update your billing info to avoid interruption."
    )
    ko = render("grace.ending", "ko", payload)
    assert ko.subject == "유예 기간 종료 임박"
    assert (
        ko.text
        == "유예 기간이 2026-09-16에 종료됩니다. 서비스 중단을 피하려면 결제 정보를 업데이트하세요."
    )


def test_notify_subscription_canceled_en_ko():
    payload = {"detail": "canceled at period end"}
    en = render("subscription.canceled", "en", payload)
    assert en.subject == "Subscription canceled"
    assert en.text == "Your subscription has been canceled. canceled at period end"
    ko = render("subscription.canceled", "ko", payload)
    assert ko.subject == "구독 취소됨"
    assert ko.text == "구독이 취소되었습니다. canceled at period end"


def test_notify_refund_executed_en_ko():
    payload = {"amount": "$25.00"}
    en = render("refund.executed", "en", payload)
    assert en.subject == "Refund processed"
    assert (
        en.text == "A refund of $25.00 has been issued to your original payment method."
    )
    ko = render("refund.executed", "ko", payload)
    assert ko.subject == "환불 처리 완료"
    assert ko.text == "$25.00 환불이 원래 결제 수단으로 처리되었습니다."


def test_notify_cs_needs_human_en_ko():
    payload = {"caseId": "case_1", "kind": "refund", "customerId": "cust_1"}
    en = render("cs.needs_human", "en", payload)
    assert en.subject == "Case needs review"
    assert en.text == "CS case case_1 (refund) for customer cust_1 needs human review."
    ko = render("cs.needs_human", "ko", payload)
    assert ko.subject == "상담원 확인 필요"
    assert (
        ko.text
        == "고객 cust_1 의 CS 케이스 case_1 (refund) 는 상담원 확인이 필요합니다."
    )


def test_notify_reconcile_mismatch_en_ko():
    payload = {"customerId": "cust_1", "detail": "2 payments, 1 grant"}
    en = render("reconcile.mismatch", "en", payload)
    assert en.subject == "Reconciliation mismatch"
    assert (
        en.text
        == "Provider payments vs grants mismatch detected for customer cust_1: 2 payments, 1 grant"
    )
    ko = render("reconcile.mismatch", "ko", payload)
    assert ko.subject == "정합성 불일치"
    assert (
        ko.text
        == "고객 cust_1 의 provider 결제와 지급 내역이 일치하지 않습니다: 2 payments, 1 grant"
    )


def test_notify_card_expiring_en_ko():
    payload = {"expiresAt": "2026-10-01"}
    en = render("card.expiring", "en", payload)
    assert en.subject == "Card expiring soon"
    assert (
        en.text
        == "Your card on file expires on 2026-10-01. Please update it to avoid an interrupted renewal."
    )
    ko = render("card.expiring", "ko", payload)
    assert ko.subject == "카드 만료 예정"
    assert (
        ko.text
        == "등록된 카드가 2026-10-01 에 만료됩니다. 갱신이 중단되지 않도록 업데이트해 주세요."
    )


def test_notify_usage_soft_cap_en_ko():
    payload = {"meter": "api_call", "overage": 2, "included": 5}
    en = render("usage.soft_cap", "en", payload)
    assert en.subject == "Usage limit reached"
    assert en.text == "You have used 2 units beyond your included 5 for api_call."
    ko = render("usage.soft_cap", "ko", payload)
    assert ko.subject == "이용량 한도 도달"
    assert ko.text == "api_call 사용량이 포함 한도 5 을 2 만큼 초과했습니다."


def test_notify_credits_expiring_en_ko():
    """EC:B16 -- credits, not the card on file."""
    payload = {"amount": 120, "expiresAt": "2026-03-01"}
    en = render("credits.expiring", "en", payload)
    assert en.subject == "Credits expiring soon"
    assert en.text == (
        "120 credits expire on 2026-03-01. Use them before then -- they do not roll over."
    )
    ko = render("credits.expiring", "ko", payload)
    assert ko.subject == "크레딧 만료 예정"
    assert ko.text == "크레딧 120 개가 2026-03-01 에 만료됩니다. 이월되지 않으니 그 전에 사용해 주세요."
