// Phase 6 regression tests — templates.render() exhaustive coverage for every NotifyType
// (the full union from @schift/payment-kit-core), both locales ('en' and 'ko'). Expected
// subject/text strings are copied verbatim from packages/notify/ts/src/templates.ts (read,
// not guessed) and cross-checked against a real `render()` call in this file.
import { describe, expect, it } from 'vitest';
import type { NotifyType } from '@schift/payment-kit-core';
import { render, templates } from '../src/index.js';

// The exhaustive NotifyType union, per packages/core/ts/src/types.ts.
const NOTIFY_TYPES: NotifyType[] = [
  'payment.failed',
  'grace.started',
  'grace.ending',
  'subscription.canceled',
  'refund.executed',
  'cs.needs_human',
  'reconcile.mismatch',
  'card.expiring',
  'usage.soft_cap',
  'credits.expiring',
];

interface Fixture {
  type: NotifyType;
  payload: Record<string, unknown>;
  en: { subject: string; text: string };
  ko: { subject: string; text: string };
}

const FIXTURES: Fixture[] = [
  {
    type: 'payment.failed',
    payload: { amount: '$10.00', reason: 'card_declined' },
    en: { subject: 'Payment failed', text: 'Your payment of $10.00 failed: card_declined. We will retry during your grace period.' },
    ko: { subject: '결제 실패', text: '$10.00 결제가 실패했습니다: card_declined. 유예 기간 동안 재시도합니다.' },
  },
  {
    type: 'grace.started',
    payload: { graceDays: 7 },
    en: { subject: 'Payment issue — grace period started', text: 'We could not process your payment. You have 7 days to update your billing info before service is paused.' },
    ko: { subject: '결제 문제 — 유예 기간 시작', text: '결제를 처리하지 못했습니다. 서비스가 중단되기 전까지 7일의 유예 기간이 있습니다.' },
  },
  {
    type: 'grace.ending',
    payload: { graceUntil: '2026-09-16' },
    en: { subject: 'Grace period ending soon', text: 'Your grace period ends on 2026-09-16. Update your billing info to avoid interruption.' },
    ko: { subject: '유예 기간 종료 임박', text: '유예 기간이 2026-09-16에 종료됩니다. 서비스 중단을 피하려면 결제 정보를 업데이트하세요.' },
  },
  {
    type: 'subscription.canceled',
    payload: { detail: 'canceled at period end' },
    en: { subject: 'Subscription canceled', text: 'Your subscription has been canceled. canceled at period end' },
    ko: { subject: '구독 취소됨', text: '구독이 취소되었습니다. canceled at period end' },
  },
  {
    type: 'refund.executed',
    payload: { amount: '$25.00' },
    en: { subject: 'Refund processed', text: 'A refund of $25.00 has been issued to your original payment method.' },
    ko: { subject: '환불 처리 완료', text: '$25.00 환불이 원래 결제 수단으로 처리되었습니다.' },
  },
  {
    type: 'cs.needs_human',
    payload: { caseId: 'case_1', kind: 'refund', customerId: 'cust_1' },
    en: { subject: 'Case needs review', text: 'CS case case_1 (refund) for customer cust_1 needs human review.' },
    ko: { subject: '상담원 확인 필요', text: '고객 cust_1 의 CS 케이스 case_1 (refund) 는 상담원 확인이 필요합니다.' },
  },
  {
    type: 'reconcile.mismatch',
    payload: { customerId: 'cust_1', detail: '2 payments, 1 grant' },
    en: { subject: 'Reconciliation mismatch', text: 'Provider payments vs grants mismatch detected for customer cust_1: 2 payments, 1 grant' },
    ko: { subject: '정합성 불일치', text: '고객 cust_1 의 provider 결제와 지급 내역이 일치하지 않습니다: 2 payments, 1 grant' },
  },
  {
    type: 'card.expiring',
    payload: { expiresAt: '2026-10-01' },
    en: { subject: 'Card expiring soon', text: 'Your card on file expires on 2026-10-01. Please update it to avoid an interrupted renewal.' },
    ko: { subject: '카드 만료 예정', text: '등록된 카드가 2026-10-01 에 만료됩니다. 갱신이 중단되지 않도록 업데이트해 주세요.' },
  },
  {
    type: 'usage.soft_cap',
    payload: { meter: 'api_call', overage: 2, included: 5 },
    en: { subject: 'Usage limit reached', text: 'You have used 2 units beyond your included 5 for api_call.' },
    ko: { subject: '이용량 한도 도달', text: 'api_call 사용량이 포함 한도 5 을 2 만큼 초과했습니다.' },
  },
  {
    // EC:B16 — credits, not the card on file
    type: 'credits.expiring',
    payload: { amount: 120, expiresAt: '2026-03-01' },
    en: { subject: 'Credits expiring soon', text: '120 credits expire on 2026-03-01. Use them before then — they do not roll over.' },
    ko: { subject: '크레딧 만료 예정', text: '크레딧 120 개가 2026-03-01 에 만료됩니다. 이월되지 않으니 그 전에 사용해 주세요.' },
  },
];

describe('notify: templates exhaustive coverage', () => {
  it('templates record has exactly the 10 NotifyTypes, each with en+ko template functions', () => {
    expect(Object.keys(templates).sort()).toEqual([...NOTIFY_TYPES].sort());
    expect(FIXTURES.map((f) => f.type).sort()).toEqual([...NOTIFY_TYPES].sort());
    for (const t of NOTIFY_TYPES) {
      expect(typeof templates[t].en).toBe('function');
      expect(typeof templates[t].ko).toBe('function');
    }
  });

  for (const fx of FIXTURES) {
    it(`notify: ${fx.type} en`, () => {
      expect(render(fx.type, 'en', fx.payload)).toEqual(fx.en);
    });
    it(`notify: ${fx.type} ko`, () => {
      expect(render(fx.type, 'ko', fx.payload)).toEqual(fx.ko);
    });
  }
});
