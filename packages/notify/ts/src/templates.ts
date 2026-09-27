// Templates per NotifyType, EN + KO. Plain string interpolation, no engine dep.
import type { Notification, NotifyType } from 'boilpayment-core';

export type Locale = 'en' | 'ko';
export interface Rendered { subject: string; text: string }
export type TemplateFn = (payload: Record<string, unknown>) => Rendered;
export type TemplateSet = { en: TemplateFn; ko: TemplateFn };

function interp(s: string, payload: Record<string, unknown>): string {
  return s.replace(/\{(\w+)\}/g, (_, k) => (payload[k] !== undefined && payload[k] !== null ? String(payload[k]) : `{${k}}`));
}

/** EC:I11 — `{detail}`: every payload field as `key=value`, for templates whose senders carry different fields. */
function detailOf(payload: Record<string, unknown>): string {
  return Object.entries(payload)
    .filter(([k, v]) => v !== undefined && v !== null && k !== 'customerId') // the customer has its own placeholder
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(', ');
}

function tpl(enSubject: string, enText: string, koSubject: string, koText: string): TemplateSet {
  return {
    en: (p) => ({ subject: interp(enSubject, p), text: interp(enText, p) }),
    ko: (p) => ({ subject: interp(koSubject, p), text: interp(koText, p) }),
  };
}

export const templates: Record<NotifyType, TemplateSet> = {
  'payment.failed': tpl(
    'Payment failed', 'We could not process the payment for your subscription. We will try again; please check your billing info.',
    '결제 실패', '구독 결제를 처리하지 못했습니다. 다시 시도하며, 결제 정보를 확인해 주세요.',
  ),
  'grace.started': tpl(
    'Payment issue — grace period started', 'We could not process your payment. You have {graceDays} days to update your billing info before service is paused.',
    '결제 문제 — 유예 기간 시작', '결제를 처리하지 못했습니다. 서비스가 중단되기 전까지 {graceDays}일의 유예 기간이 있습니다.',
  ),
  'grace.ending': tpl(
    'Grace period ending soon', 'Your grace period ends on {graceUntil}. Update your billing info to avoid interruption.',
    '유예 기간 종료 임박', '유예 기간이 {graceUntil}에 종료됩니다. 서비스 중단을 피하려면 결제 정보를 업데이트하세요.',
  ),
  'subscription.canceled': tpl(
    'Subscription canceled', 'Your subscription has been canceled. {detail}',
    '구독 취소됨', '구독이 취소되었습니다. {detail}',
  ),
  'refund.executed': tpl(
    'Refund processed', 'A refund of {amount} has been issued to your original payment method.',
    '환불 처리 완료', '{amount} 환불이 원래 결제 수단으로 처리되었습니다.',
  ),
  'cs.needs_human': tpl(
    'Case needs review', 'Customer {customerId} needs human review ({kind}). {detail}',
    '상담원 확인 필요', '고객 {customerId} 건은 상담원 확인이 필요합니다 ({kind}). {detail}',
  ),
  'reconcile.mismatch': tpl(
    'Reconciliation mismatch', 'Provider payments vs grants mismatch detected for customer {customerId}: {detail}',
    '정합성 불일치', '고객 {customerId} 의 provider 결제와 지급 내역이 일치하지 않습니다: {detail}',
  ),
  'card.expiring': tpl(
    'Card expiring soon', 'Your card on file expires on {expiresAt}. Please update it to avoid an interrupted renewal.',
    '카드 만료 예정', '등록된 카드가 {expiresAt} 에 만료됩니다. 갱신이 중단되지 않도록 업데이트해 주세요.',
  ),
  // EC:B16 — the credits expiring, NOT the card on file. Reusing 'card.expiring' would tell the
  // customer to update a payment method, which is the wrong instruction entirely.
  'credits.expiring': tpl(
    'Credits expiring soon', '{amount} credits expire on {expiresAt}. Use them before then — they do not roll over.',
    '크레딧 만료 예정', '크레딧 {amount} 개가 {expiresAt} 에 만료됩니다. 이월되지 않으니 그 전에 사용해 주세요.',
  ),
  'usage.soft_cap': tpl(
    'Usage limit reached', 'You have used {overage} units beyond your included {included} for {meter}.',
    '이용량 한도 도달', '{meter} 사용량이 포함 한도 {included} 을 {overage} 만큼 초과했습니다.',
  ),
};

export function render(type: NotifyType, locale: Locale, payload: Record<string, unknown>): Rendered {
  const set = templates[type];
  const fn = set[locale] ?? set.en;
  return fn({ detail: detailOf(payload), ...payload });
}

/** The notification's own customer fills `{customerId}` ('-' when it names none). */
export function renderNotification(n: Notification, locale: Locale): Rendered {
  return render(n.type, locale, { customerId: n.customerId ?? '-', ...n.payload });
}
