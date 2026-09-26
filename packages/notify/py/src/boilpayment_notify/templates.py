# Templates per NotifyType, EN + KO. Plain string interpolation, no engine dep.
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

from boilpayment_core import Notification, NotifyType

Locale = Literal["en", "ko"]


@dataclass(kw_only=True, slots=True)
class Rendered:
    subject: str
    text: str


TemplateFn = Callable[[dict[str, Any]], Rendered]


@dataclass(kw_only=True, slots=True)
class TemplateSet:
    en: TemplateFn
    ko: TemplateFn


def _interp(s: str, payload: dict[str, Any]) -> str:
    out = s
    for k, v in payload.items():
        out = out.replace("{" + k + "}", str(v))
    return out


def _tpl(en_subject: str, en_text: str, ko_subject: str, ko_text: str) -> TemplateSet:
    return TemplateSet(
        en=lambda p: Rendered(subject=_interp(en_subject, p), text=_interp(en_text, p)),
        ko=lambda p: Rendered(subject=_interp(ko_subject, p), text=_interp(ko_text, p)),
    )


templates: dict[NotifyType, TemplateSet] = {
    "payment.failed": _tpl(
        "Payment failed",
        "Your payment of {amount} failed: {reason}. We will retry during your grace period.",
        "결제 실패",
        "{amount} 결제가 실패했습니다: {reason}. 유예 기간 동안 재시도합니다.",
    ),
    "grace.started": _tpl(
        "Payment issue — grace period started",
        "We could not process your payment. You have {graceDays} days to update your billing info before service is paused.",
        "결제 문제 — 유예 기간 시작",
        "결제를 처리하지 못했습니다. 서비스가 중단되기 전까지 {graceDays}일의 유예 기간이 있습니다.",
    ),
    "grace.ending": _tpl(
        "Grace period ending soon",
        "Your grace period ends on {graceUntil}. Update your billing info to avoid interruption.",
        "유예 기간 종료 임박",
        "유예 기간이 {graceUntil}에 종료됩니다. 서비스 중단을 피하려면 결제 정보를 업데이트하세요.",
    ),
    "subscription.canceled": _tpl(
        "Subscription canceled",
        "Your subscription has been canceled. {detail}",
        "구독 취소됨",
        "구독이 취소되었습니다. {detail}",
    ),
    "refund.executed": _tpl(
        "Refund processed",
        "A refund of {amount} has been issued to your original payment method.",
        "환불 처리 완료",
        "{amount} 환불이 원래 결제 수단으로 처리되었습니다.",
    ),
    "cs.needs_human": _tpl(
        "Case needs review",
        "CS case {caseId} ({kind}) for customer {customerId} needs human review.",
        "상담원 확인 필요",
        "고객 {customerId} 의 CS 케이스 {caseId} ({kind}) 는 상담원 확인이 필요합니다.",
    ),
    "reconcile.mismatch": _tpl(
        "Reconciliation mismatch",
        "Provider payments vs grants mismatch detected for customer {customerId}: {detail}",
        "정합성 불일치",
        "고객 {customerId} 의 provider 결제와 지급 내역이 일치하지 않습니다: {detail}",
    ),
    "card.expiring": _tpl(
        "Card expiring soon",
        "Your card on file expires on {expiresAt}. Please update it to avoid an interrupted renewal.",
        "카드 만료 예정",
        "등록된 카드가 {expiresAt} 에 만료됩니다. 갱신이 중단되지 않도록 업데이트해 주세요.",
    ),
    # EC:B16 -- the credits expiring, NOT the card on file. Reusing "card.expiring" would tell the
    # customer to update a payment method, which is the wrong instruction entirely.
    "credits.expiring": _tpl(
        "Credits expiring soon",
        "{amount} credits expire on {expiresAt}. Use them before then -- they do not roll over.",
        "크레딧 만료 예정",
        "크레딧 {amount} 개가 {expiresAt} 에 만료됩니다. 이월되지 않으니 그 전에 사용해 주세요.",
    ),
    "usage.soft_cap": _tpl(
        "Usage limit reached",
        "You have used {overage} units beyond your included {included} for {meter}.",
        "이용량 한도 도달",
        "{meter} 사용량이 포함 한도 {included} 을 {overage} 만큼 초과했습니다.",
    ),
}


def render(type: NotifyType, locale: Locale, payload: dict[str, Any]) -> Rendered:
    set_ = templates[type]
    fn = set_.en if locale == "en" else set_.ko
    return fn(payload)


def render_notification(n: Notification, locale: Locale) -> Rendered:
    return render(n.type, locale, n.payload)
