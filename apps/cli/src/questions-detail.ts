// Wizard questions for the finer-grained options added after the tvc comparison (2026-09-27):
// EC:C10 reservations, EC:D16 refund reasons, EC:B19 per-source expiry, EC:I10 reports.
// Spread into QUESTIONS at their place in docs/EDGE_CASES.md "위저드 질문 순서" by questions.ts.
import { DEFAULT_POLICY } from 'boilpayment-core';
import { getPath } from './util/path.js';
import type { Question } from './questions.js';
import type { WizardConfig } from './wizard-state.js';

const hasCredits = (c: WizardConfig) => c.goods.includes('credits');
const def = (p: string) => getPath(DEFAULT_POLICY, p);

export const RESERVATION_QUESTIONS: Question[] = [
  {
    id: 'reservations',
    configPath: 'reservations',
    ec: ['C10'],
    type: 'confirm',
    group: 'usage',
    when: hasCredits,
    message: '오래 걸리는 작업(영상 처리, 대량 변환 등)에 크레딧을 미리 잡아 두고, 성공하면 쓴 만큼만 청구할까요? (Reservations)',
    default: false,
  },
  {
    id: 'usage_reservation_ttl_minutes',
    policyPath: 'usage.reservationTtlMinutes',
    ec: ['C10'],
    type: 'number',
    group: 'usage',
    when: (c) => hasCredits(c) && c.reservations === true,
    message: '작업 예약 만료 (Reservation TTL, 분). 오래 걸리는 작업 전에 잡아 둔 크레딧을 이 시간 안에 확정하거나 풀지 않으면 자동으로 풉니다',
    default: def('usage.reservationTtlMinutes'),
  },
];

export const REFUND_REASON_QUESTIONS: Question[] = [
  {
    id: 'refund_reason_technical_failure',
    policyPath: 'refund.reasons.technicalFailure',
    ec: ['D16'],
    type: 'select',
    group: 'refund',
    when: (c) => !!c.refundAdvanced,
    message: '환불 사유가 기술 실패(우리 쪽 오류)일 때 (Refund reason: technical failure)',
    options: [
      { value: 'rules', label: '위 금액 규칙대로', hint: '사유를 보지 않습니다' },
      { value: 'full', label: '남은 결제 전액 환불', hint: '환불 창·방식·연간 제한과 무관, 남은 크레딧만 회수' },
    ],
    default: def('refund.reasons.technicalFailure'),
  },
  {
    id: 'refund_reason_dissatisfied',
    policyPath: 'refund.reasons.dissatisfied',
    ec: ['D16'],
    type: 'select',
    group: 'refund',
    when: (c) => !!c.refundAdvanced,
    message: '환불 사유가 결과 불만족일 때 (Refund reason: dissatisfied)',
    options: [
      { value: 'rules', label: '위 금액 규칙대로' },
      { value: 'evidence_required', label: '증빙(작업 id 등)이 있으면 규칙대로, 없으면 담당자 확인' },
      { value: 'needs_human', label: '항상 담당자 확인' },
    ],
    default: def('refund.reasons.dissatisfied'),
  },
  {
    id: 'refund_reason_user_error',
    policyPath: 'refund.reasons.userError',
    ec: ['D16'],
    type: 'select',
    group: 'refund',
    when: (c) => !!c.refundAdvanced,
    message: '환불 사유가 사용자 과실일 때 (Refund reason: user error)',
    options: [
      { value: 'rules', label: '위 금액 규칙대로' },
      { value: 'deny', label: '거절' },
    ],
    default: def('refund.reasons.userError'),
  },
];

export const CREDITS_ADVANCED_QUESTIONS: Question[] = [
  {
    id: 'credits_advanced',
    configPath: 'creditsAdvanced',
    ec: ['B19'],
    type: 'confirm',
    group: 'credits',
    when: hasCredits,
    message: '크레딧 고급 옵션 (Advanced credit options — 프로모션·수동·재지급 크레딧의 출처별 기본 만료) 을 설정할까요?',
    default: false,
  },
  {
    id: 'credits_expiry_days_promo',
    policyPath: 'credits.expiryDays.promo',
    ec: ['B19'],
    type: 'number',
    group: 'credits',
    when: (c) => hasCredits(c) && !!c.creditsAdvanced,
    message: '프로모션 크레딧의 기본 만료일 수 (0 = 무만료, 지급 시 만료일을 따로 주면 그 값이 우선)',
    default: 0,
    parse: (raw: string) => (Number(raw) > 0 ? Number(raw) : null),
  },
  {
    id: 'credits_expiry_days_trial',
    policyPath: 'credits.expiryDays.trial',
    ec: ['B19'],
    type: 'number',
    group: 'credits',
    when: (c) => hasCredits(c) && !!c.creditsAdvanced,
    message: '트라이얼 직접 지급 크레딧의 기본 만료일 수 (0 = 무만료, 지급 시 만료일을 따로 주면 그 값이 우선)',
    default: 0,
    parse: (raw: string) => (Number(raw) > 0 ? Number(raw) : null),
  },
  {
    id: 'credits_expiry_days_manual',
    policyPath: 'credits.expiryDays.manual',
    ec: ['B19'],
    type: 'number',
    group: 'credits',
    when: (c) => hasCredits(c) && !!c.creditsAdvanced,
    message: '운영자 수동 지급 크레딧의 기본 만료일 수 (0 = 무만료, 지급 시 만료일을 따로 주면 그 값이 우선)',
    default: 0,
    parse: (raw: string) => (Number(raw) > 0 ? Number(raw) : null),
  },
  {
    id: 'credits_expiry_days_regrant',
    policyPath: 'credits.expiryDays.regrant',
    ec: ['B19'],
    type: 'number',
    group: 'credits',
    when: (c) => hasCredits(c) && !!c.creditsAdvanced,
    message: 'CS 재지급 크레딧의 기본 만료일 수 (0 = 무만료, 지급 시 만료일을 따로 주면 그 값이 우선)',
    default: 0,
    parse: (raw: string) => (Number(raw) > 0 ? Number(raw) : null),
  },
];

export const REPORT_QUESTIONS: Question[] = [
  {
    id: 'reports',
    configPath: 'reports',
    ec: ['I10'],
    type: 'confirm',
    group: 'cs',
    message: '월 정산 집계 함수(결제·환불·순액·크레딧 이동, 통화별)를 만들까요? (Settlement report)',
    default: false,
  },
];
