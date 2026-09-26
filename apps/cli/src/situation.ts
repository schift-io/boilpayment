// EC:M1 — the situation questions asked before every policy question. Their answers only set the
// defaults of later questions (`Question.defaultFrom`); every later question is still asked.
import type { Question, QuestionOption } from './questions.js';
import type { WizardConfig } from './wizard-state.js';

export const existing = (c: WizardConfig) => c.situation?.existingCustomers === true;
export const has = (c: WizardConfig, g: 'subscriptions' | 'credits') => existing(c) && (c.situation?.has ?? []).includes(g);
export const PROVIDER_OPTIONS: QuestionOption[] = [
  { value: 'stripe', label: 'Stripe', hint: '글로벌, 네이티브 구독' },
  { value: 'polar', label: 'Polar', hint: 'Merchant of Record, 글로벌 세금 위임' },
  { value: 'toss', label: 'Toss', hint: 'KR, 네이티브 구독 없음 → 자체 스케줄러 필요' },
  { value: 'portone', label: 'Portone', hint: 'KR, PG 여럿을 정규화, provider 스케줄 가능' },
];

/** The answer the wizard would store for `q` given the answers so far. */
export function questionDefault(q: Question, config: WizardConfig): unknown {
  return q.defaultFrom?.(config) ?? q.default;
}

export const SITUATION_QUESTIONS: Question[] = [
  // 0. 지금 상황 (M1) — 답이 뒤 질문의 기본값을 정한다. 뒤 질문은 전부 그대로 묻는다.
  {
    id: 'situation_existing',
    configPath: 'situation.existingCustomers',
    ec: ['M1'],
    type: 'confirm',
    group: 'situation',
    message: '이미 결제 중인 고객이 있나요? (Existing paying customers)',
    default: false,
  },
  {
    id: 'situation_providers',
    configPath: 'situation.providers',
    ec: ['M1'],
    type: 'multiselect',
    group: 'situation',
    when: existing,
    message: '지금 어느 결제사로 받고 있나요? (Current providers, 다중 선택 가능)',
    options: PROVIDER_OPTIONS,
    default: ['stripe'],
  },
  {
    id: 'situation_has',
    configPath: 'situation.has',
    ec: ['M1', 'M4'],
    type: 'multiselect',
    group: 'situation',
    when: existing,
    message: '옮겨 올 것이 무엇인가요? (What exists now, 다중 선택 가능)',
    options: [
      { value: 'subscriptions', label: '진행 중인 구독 (Active subscriptions)', hint: '다음 갱신이 kit 으로 이어지도록 구독 행을 만든다' },
      { value: 'credits', label: '크레딧 잔액 (Credit balances)', hint: '잔액을 원장 grant 한 건으로 들인다' },
    ],
    default: ['subscriptions'],
  },
];
