// Declarative wizard question list.
// Order follows docs/EDGE_CASES.md "위저드 질문 순서". Each P0 policy key in EDGE_CASES.md
// has exactly one question here (or is covered by a shared/derived question, noted in `ec`).
import { DEFAULT_POLICY } from 'boilpayment-core';
import { getPath } from './util/path.js';
import type { WizardConfig } from './wizard-state.js';
import { PROVIDER_OPTIONS, SITUATION_QUESTIONS, existing, has } from './situation.js';
export { questionDefault } from './situation.js';

export type QuestionType = 'select' | 'multiselect' | 'number' | 'text' | 'confirm';

export interface QuestionOption {
  value: string;
  label: string;
  hint?: string;
}

export interface Question {
  id: string;
  /** Dot path into config.policy, e.g. 'refund.method'. Mutually exclusive with configPath. */
  policyPath?: string;
  /** Dot path into config (outside policy), e.g. 'providers'. Mutually exclusive with policyPath. */
  configPath?: string;
  ec: string[];
  type: QuestionType;
  /** Korean primary, English in parens. Short. */
  message: string;
  options?: QuestionOption[];
  default: unknown;
  /** Default that follows earlier answers (EC:M1 situation). Falls back to `default` when it returns undefined. */
  defaultFrom?: (config: WizardConfig) => unknown;
  /** Only asked when this returns true. Receives the config as built so far (including prior answers). */
  when?: (config: WizardConfig) => boolean;
  /** Turns the raw prompt answer into the stored value (e.g. a comma list into number[]). */
  parse?: (raw: string) => unknown;
  group: string;
}

const hasSubscription = (c: WizardConfig) => c.models.includes('subscription');
const hasUsageModel = (c: WizardConfig) => c.models.includes('usage');
const hasTopup = (c: WizardConfig) => c.models.includes('topup');
const hasCredits = (c: WizardConfig) => c.goods.includes('credits');
const hasUsageQuota = (c: WizardConfig) => c.goods.includes('usage_quota');
const hasToss = (c: WizardConfig) => c.providers.includes('toss');
const hasPortone = (c: WizardConfig) => c.providers.includes('portone');
const hasKrProvider = (c: WizardConfig) => hasToss(c) || hasPortone(c);
const csEnabled = (c: WizardConfig) => c.cs.enabled;
const def = (p: string) => getPath(DEFAULT_POLICY, p);
export const QUESTIONS: Question[] = [
  ...SITUATION_QUESTIONS,

  // 1. Provider (F)
  {
    id: 'providers',
    configPath: 'providers',
    ec: ['F'],
    type: 'multiselect',
    group: 'provider',
    message: '결제 provider 를 선택하세요 (Payment providers, 다중 선택 가능)',
    options: PROVIDER_OPTIONS,
    default: ['stripe'],
    defaultFrom: (c) => (existing(c) && c.situation?.providers?.length ? [...c.situation.providers] : undefined),
  },

  // 2. 결제 모델
  {
    id: 'models',
    configPath: 'models',
    ec: ['PRD §4.1'],
    type: 'multiselect',
    group: 'model',
    message: '결제 모델을 선택하세요 (Payment models, 다중 선택 가능)',
    options: [
      { value: 'subscription', label: '구독 (Subscription)', hint: '정기 결제, 라이프사이클 모듈 사용' },
      { value: 'topup', label: '크레딧 충전 (Top-up)', hint: '일회성 결제로 크레딧 지급' },
      { value: 'usage', label: '이용량 (Usage)', hint: '사용량 기반 과금/한도' },
    ],
    default: ['subscription'],
    defaultFrom: (c) => (existing(c) && has(c, 'credits') && !has(c, 'subscriptions') ? ['topup'] : undefined),
  },

  // 3. 재화
  {
    id: 'goods',
    configPath: 'goods',
    ec: ['PRD §4.1'],
    type: 'multiselect',
    group: 'goods',
    message: '지급할 재화를 선택하세요 (Goods to grant, 다중 선택 가능)',
    options: [
      { value: 'credits', label: '크레딧 (Credits)', hint: '원장 기반 크레딧 풀' },
      { value: 'usage_quota', label: '이용량 쿼터 (Usage quota)', hint: '주기당 포함량 + 초과 정책' },
    ],
    default: ['credits'],
  },

  // 4. 주기 · 타임존 (C3, G1, G2)
  {
    id: 'period_timezone',
    policyPath: 'period.timezone',
    ec: ['C3'],
    type: 'text',
    group: 'period',
    message: '주기 계산 기준 타임존 (Timezone, IANA 이름 또는 UTC)',
    default: def('period.timezone'),
  },
  {
    id: 'month_end_anchor',
    policyPath: 'period.monthEndAnchor',
    ec: ['G1'],
    type: 'select',
    group: 'period',
    message: '월말 기준일 처리 (Month-end anchor, 예: 1/31 구독의 2월 갱신일)',
    options: [
      { value: 'clamp_keep_original_day', label: '원래 일자 기억, 짧은 달은 말일', hint: '3월엔 다시 31일로 복귀' },
      { value: 'clamp_permanently', label: '한 번 줄면 영구히 그 일자', hint: '2월 이후 계속 28일 고정' },
    ],
    default: def('period.monthEndAnchor'),
  },
  {
    id: 'proration_denominator',
    policyPath: 'proration.denominator',
    ec: ['G2'],
    type: 'select',
    group: 'period',
    message: '일할 계산 분모 (Proration denominator)',
    options: [
      { value: 'actual_days_in_period', label: '해당 주기의 실제 일수', hint: '28~31일 변동' },
      { value: 'fixed_30', label: '고정 30일', hint: '계산 단순, 약간의 오차' },
    ],
    default: def('proration.denominator'),
  },

  // 5. 크레딧: B1 B2 B3 B4 B7 B10
  {
    id: 'credits_rollover',
    policyPath: 'credits.rollover',
    ec: ['B1'],
    type: 'select',
    group: 'credits',
    when: hasCredits,
    message: '주기 말 미사용 크레딧 이월 (Rollover)',
    options: [
      { value: 'none', label: '없음', hint: '주기 말 소멸' },
      { value: 'banked', label: '상한까지 누적 (Banked)', hint: '상한 초과분은 소멸' },
      { value: 'full', label: '전액 이월', hint: '무제한 누적' },
    ],
    default: def('credits.rollover'),
  },
  {
    id: 'credits_bank_cap',
    policyPath: 'credits.bankCap',
    ec: ['B1'],
    type: 'number',
    group: 'credits',
    when: (c) => hasCredits(c) && getPath(c.policy, 'credits.rollover') === 'banked',
    message: '이월 상한 크레딧 수 (Bank cap)',
    default: 10000,
  },
  {
    id: 'credits_bank_reset',
    policyPath: 'credits.bankReset',
    ec: ['B2'],
    type: 'select',
    group: 'credits',
    when: (c) => hasCredits(c) && getPath(c.policy, 'credits.rollover') === 'banked',
    message: 'Banked 크레딧 리셋 시점 (Bank reset)',
    options: [
      { value: 'on_renewal', label: '매 갱신마다', hint: '갱신 시점에 재계산' },
      { value: 'never', label: '리셋 없음', hint: '계속 누적' },
      { value: 'on_cancel', label: '취소 시에만', hint: '구독 중엔 유지' },
    ],
    default: def('credits.bankReset'),
  },
  {
    id: 'credits_consume_order',
    policyPath: 'credits.consumeOrder',
    ec: ['B3'],
    type: 'select',
    group: 'credits',
    when: hasCredits,
    message: '크레딧 소비 순서 (Consume order, 여러 pool 이 있을 때)',
    options: [
      { value: 'expiring_first', label: '만료 임박분 먼저 (FIFO by expiry)', hint: '고객에게 가장 유리' },
      { value: 'promo_first_then_expiring', label: '프로모 먼저, 그다음 만료순', hint: '유료 크레딧 보존' },
      { value: 'paid_first', label: '유료 크레딧 먼저', hint: '프로모는 나중에 소진' },
    ],
    default: def('credits.consumeOrder'),
  },
  {
    id: 'credits_negative_balance',
    policyPath: 'credits.negativeBalance',
    ec: ['B4'],
    type: 'select',
    group: 'credits',
    when: hasCredits,
    message: '잔액 부족 시 소비 처리 (Negative balance)',
    options: [
      { value: 'block', label: '거절', hint: '잔액 부족이면 소비 실패' },
      { value: 'allow_to_floor', label: '하한까지 음수 허용', hint: '다음 지급에서 상계' },
      { value: 'allow_unbounded', label: '무제한 음수 허용', hint: '위험, 특수 목적만' },
    ],
    default: def('credits.negativeBalance'),
  },
  {
    id: 'credits_negative_floor',
    policyPath: 'credits.negativeFloor',
    ec: ['B4'],
    type: 'number',
    group: 'credits',
    when: (c) => hasCredits(c) && getPath(c.policy, 'credits.negativeBalance') === 'allow_to_floor',
    message: '음수 잔액 하한 (Negative floor, 0 이하 정수, 예: -1000)',
    default: -1000,
  },
  {
    id: 'credits_pools',
    policyPath: 'credits.pools',
    ec: ['B7'],
    type: 'select',
    group: 'credits',
    when: hasCredits,
    message: '유료 크레딧 vs 프로모 크레딧 풀 분리 (Credit pools)',
    options: [
      { value: 'separate', label: '분리', hint: '환불·회수는 유료 풀에만 적용' },
      { value: 'merged', label: '통합', hint: '풀 구분 없음' },
    ],
    default: def('credits.pools'),
  },
  {
    id: 'credits_topup_expiry_days',
    policyPath: 'credits.topupExpiryDays',
    ec: ['B10'],
    type: 'number',
    group: 'credits',
    when: (c) => hasCredits(c) && hasTopup(c),
    message: '충전(Top-up) 크레딧 만료일 수 (0 = 무만료)',
    default: 0,
    // 0 means NO expiry, not "expires today" — store null so credits.topup leaves expiresAt unset.
    parse: (raw: string) => (Number(raw) > 0 ? Number(raw) : null),
  },
  {
    id: 'credits_expiry_notice_days',
    policyPath: 'credits.expiryNoticeDays',
    ec: ['B16'],
    type: 'number',
    group: 'credits',
    when: hasCredits,
    message: '크레딧 만료 며칠 전에 알릴까요? (Expiry notice days, 0 = 알리지 않음)',
    default: 0,
    parse: (raw: string) => (Number(raw) > 0 ? Number(raw) : null),
  },
  {
    id: 'credits_negative_offset',
    policyPath: 'credits.negativeOffset',
    ec: ['B17'],
    type: 'select',
    group: 'credits',
    when: (c) => hasCredits(c) && String(getPath(c.policy, 'credits.negativeBalance')) !== 'block',
    message: '잔액이 음수인 상태에서 새로 지급될 때 (Negative balance offset)',
    options: [
      { value: 'offset_next_grant', label: '새 지급으로 먼저 상계', hint: '기본. -30 에 100 지급 → 70 사용 가능' },
      { value: 'never', label: '상계하지 않음', hint: '빚은 그대로 남고 100 이 전부 사용 가능' },
    ],
    default: def('credits.negativeOffset'),
  },

  // 6. 업그레이드: A1 A2
  {
    id: 'upgrade_mode',
    policyPath: 'upgrade.mode',
    ec: ['A1'],
    type: 'select',
    group: 'upgrade',
    when: hasSubscription,
    message: '업그레이드(중간 주기) 처리 (Upgrade mode)',
    options: [
      { value: 'immediate_prorate_reset_anchor', label: '차액 즉시 결제 + 재화 즉시 지급 + 기준일 리셋', hint: '가장 단순, 가장 흔함' },
      { value: 'immediate_prorate_keep_anchor', label: '차액 즉시, 기준일 유지', hint: '다음 갱신부터 새 요금' },
      { value: 'next_period', label: '다음 주기부터', hint: '지금은 변화 없음' },
    ],
    default: def('upgrade.mode'),
  },
  {
    id: 'upgrade_credit_delta',
    policyPath: 'upgrade.creditDelta',
    ec: ['A2'],
    type: 'select',
    group: 'upgrade',
    when: hasSubscription,
    message: '업그레이드 시 재화 차액 계산 (Credit delta, 이미 일부 소모한 경우)',
    options: [
      { value: 'full_delta', label: '전량 차액 (신플랜 − 구플랜)', hint: '단순, 고객에게 유리' },
      { value: 'prorated_delta', label: '남은 기간 비율만큼', hint: '정확하지만 계산 복잡' },
    ],
    default: def('upgrade.creditDelta'),
  },

  // 7. 다운그레이드: A3 A4
  {
    id: 'downgrade_mode',
    policyPath: 'downgrade.mode',
    ec: ['A3'],
    type: 'select',
    group: 'downgrade',
    when: hasSubscription,
    message: '다운그레이드 시 기지급 재화 처리 (Downgrade mode)',
    options: [
      { value: 'end_of_period', label: '다음 주기부터, 기지급 유지', hint: '가장 부드러움' },
      { value: 'immediate_keep', label: '즉시 요금 변경, 기지급 유지', hint: '환불 없이 즉시 저요금' },
      { value: 'immediate_clawback', label: '즉시 변경 + 초과분 회수', hint: '가장 엄격' },
    ],
    default: def('downgrade.mode'),
  },
  {
    id: 'downgrade_clawback_shortfall',
    policyPath: 'downgrade.clawbackShortfall',
    ec: ['A4'],
    type: 'select',
    group: 'downgrade',
    when: (c) => hasSubscription(c) && getPath(c.policy, 'downgrade.mode') === 'immediate_clawback',
    message: '다운그레이드 회수 시 잔액 부족 (Clawback shortfall, 이미 써버린 경우)',
    options: [
      { value: 'clamp_to_zero', label: '0까지만 회수', hint: '음수로 안 감' },
      { value: 'allow_negative', label: '음수 잔액 허용', hint: '다음 지급에서 상계' },
      { value: 'deny_downgrade', label: '다운그레이드 자체를 거절', hint: '가장 보수적' },
    ],
    default: def('downgrade.clawbackShortfall'),
  },

  // 8. 취소: A5 A6
  {
    id: 'cancel_mode',
    policyPath: 'cancel.mode',
    ec: ['A5'],
    type: 'select',
    group: 'cancel',
    when: hasSubscription,
    message: '취소 시점 처리 (Cancel mode)',
    options: [
      { value: 'end_of_period', label: '주기 말까지 이용', hint: '이미 낸 돈만큼 서비스' },
      { value: 'immediate', label: '즉시 종료', hint: '남은 기간 환불 없이 바로 종료' },
    ],
    default: def('cancel.mode'),
  },
  {
    id: 'cancel_credits',
    policyPath: 'cancel.credits',
    ec: ['A6'],
    type: 'select',
    group: 'cancel',
    when: hasSubscription,
    message: '취소 후 남은 재화 처리 (Cancel credits)',
    options: [
      { value: 'keep_until_period_end', label: '주기 말까지 유지', hint: '가장 흔함' },
      { value: 'revoke_immediately', label: '즉시 회수', hint: '가장 엄격' },
    ],
    default: def('cancel.credits'),
  },

  // 9. 트라이얼: A9 (있을 때만 — 아래 trial_enabled 로 게이트)
  {
    id: 'trial_enabled',
    configPath: 'trialEnabled',
    ec: ['PRD §4.1'],
    type: 'confirm',
    group: 'trial',
    when: hasSubscription,
    message: '무료 트라이얼을 제공하나요? (Offer a free trial?)',
    default: false,
  },
  {
    id: 'trial_credits_on_convert',
    policyPath: 'trial.creditsOnConvert',
    ec: ['A9'],
    type: 'select',
    group: 'trial',
    when: (c) => hasSubscription(c) && !!c.trialEnabled,
    message: '트라이얼 → 유료 전환 시 재화 (Trial → paid conversion)',
    options: [
      { value: 'grant_full', label: '유료분 전량 지급, 트라이얼 잔여 폐기', hint: '가장 단순' },
      { value: 'grant_full_keep_trial', label: '유료분 전량 지급 + 트라이얼 잔여 유지', hint: '고객에게 유리' },
      { value: 'no_grant_until_next_period', label: '다음 주기까지 지급 안 함', hint: '가장 보수적' },
    ],
    default: def('trial.creditsOnConvert'),
  },
  {
    id: 'trial_credits_on_cancel',
    policyPath: 'trial.creditsOnCancel',
    ec: ['A10'],
    type: 'select',
    group: 'trial',
    when: (c) => hasSubscription(c) && !!c.trialEnabled,
    message: '트라이얼 중 취소 시 트라이얼 재화 (Trial cancel)',
    options: [
      { value: 'revoke', label: '회수', hint: '기본' },
      { value: 'keep', label: '유지', hint: '만료까지 사용 가능' },
    ],
    default: def('trial.creditsOnCancel'),
  },
  {
    id: 'trial_abuse_guard',
    policyPath: 'trial.abuseGuard',
    ec: ['A11'],
    type: 'select',
    group: 'trial',
    when: (c) => hasSubscription(c) && !!c.trialEnabled,
    message: '트라이얼 반복 가입 방지 (Trial abuse guard)',
    options: [
      { value: 'one_per_customer', label: '이메일·결제수단 지문으로 1회 제한', hint: '권장' },
      { value: 'none', label: '제한 없음', hint: '어뷰징 위험' },
    ],
    default: def('trial.abuseGuard'),
  },

  // 10. 갱신 실패: A13 A14 A15 A16 A17
  {
    id: 'dunning_grace_days',
    policyPath: 'dunning.graceDays',
    ec: ['A13'],
    type: 'number',
    group: 'dunning',
    when: hasSubscription,
    message: '갱신 결제 실패 시 유예 기간 (Grace days, 일, 0 = 즉시 정지)',
    default: def('dunning.graceDays'),
  },
  {
    id: 'dunning_retry_attempts',
    policyPath: 'dunning.retryAttempts',
    ec: ['A24'],
    type: 'number',
    group: 'dunning',
    when: (c) => hasSubscription(c) && Number(getPath(c.policy, 'dunning.graceDays')) > 0,
    message: '유예 기간 안에서 결제를 몇 번 더 시도할까요? (Smart retry attempts, 0 = provider 재시도만)',
    default: def('dunning.retryAttempts'),
  },
  {
    id: 'dunning_retry_interval_hours',
    policyPath: 'dunning.retryIntervalHours',
    ec: ['A24'],
    type: 'text',
    group: 'dunning',
    when: (c) => hasSubscription(c) && Number(getPath(c.policy, 'dunning.retryAttempts')) > 0,
    message: '재시도 간격 (Retry intervals, 실패 후 시간 단위, 쉼표로 구분 — 목록이 짧으면 마지막 값이 반복됨)',
    default: (def('dunning.retryIntervalHours') as number[]).join(','),
    parse: (raw: string) => raw.split(',').map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n > 0),
  },
  {
    id: 'dunning_usage_during_grace',
    policyPath: 'dunning.usageDuringGrace',
    ec: ['A14'],
    type: 'select',
    group: 'dunning',
    when: (c) => hasSubscription(c) && (Number(getPath(c.policy, 'dunning.graceDays')) > 0),
    message: '유예 기간 중 재화 사용 허용 (Usage during grace)',
    options: [
      { value: 'allow', label: '허용', hint: '기존 잔액 계속 사용 가능' },
      { value: 'block', label: '차단', hint: '유예 중엔 소비 불가' },
      { value: 'allow_existing_only', label: '기존 잔액만, 신규 지급 없음', hint: '절충안' },
    ],
    default: def('dunning.usageDuringGrace'),
  },
  {
    id: 'dunning_grant_during_grace',
    policyPath: 'dunning.grantDuringGrace',
    ec: ['A15'],
    type: 'select',
    group: 'dunning',
    when: (c) => hasSubscription(c) && (Number(getPath(c.policy, 'dunning.graceDays')) > 0),
    message: '유예 기간 중 신규 주기 재화 지급 (Grant during grace)',
    options: [
      { value: 'defer_until_paid', label: '결제 성공까지 보류', hint: '기본' },
      { value: 'grant_anyway', label: '일단 지급', hint: '결제 실패 지속 시 손실 위험' },
    ],
    default: def('dunning.grantDuringGrace'),
  },
  {
    id: 'dunning_on_final_failure',
    policyPath: 'dunning.onFinalFailure',
    ec: ['A16'],
    type: 'select',
    group: 'dunning',
    when: hasSubscription,
    message: '유예 만료(최종 실패) 시 재화 처리 (On final failure)',
    options: [
      { value: 'revoke_unpaid_period', label: '미결제 주기분만 회수', hint: '기본' },
      { value: 'revoke_all', label: '전체 회수', hint: '가장 엄격' },
      { value: 'keep', label: '유지', hint: '가장 관대' },
    ],
    default: def('dunning.onFinalFailure'),
  },
  {
    id: 'dunning_on_recovery',
    policyPath: 'dunning.onRecovery',
    ec: ['A17'],
    type: 'select',
    group: 'dunning',
    when: hasSubscription,
    message: '최종 실패 후 결제 복구 시 재지급 (On recovery)',
    options: [
      { value: 'regrant_current_period', label: '현재 주기분만 재지급', hint: '기본' },
      { value: 'regrant_all_missed', label: '놓친 주기 전부 재지급', hint: '고객에게 유리' },
      { value: 'no_regrant', label: '재지급 안 함', hint: '가장 엄격' },
    ],
    default: def('dunning.onRecovery'),
  },

  // 11. 환불: D1 D2 D3 B13 (D7 D10 고급)
  {
    id: 'refund_no_questions_days',
    policyPath: 'refund.noQuestionsDays',
    ec: ['D1'],
    type: 'number',
    group: 'refund',
    message: '무조건 환불 창 (No-questions-asked window, 일, 0 = 없음). 창 안이면 사용량 무관 전액 환불',
    default: def('refund.noQuestionsDays'),
  },
  {
    id: 'refund_method',
    policyPath: 'refund.method',
    ec: ['D2'],
    type: 'select',
    group: 'refund',
    message: '무조건 환불 창 밖 — 환불액 산정 방식 (Refund method)',
    options: [
      { value: 'unused_credits', label: '미사용 크레딧 × 단가', hint: '재화 소비량 기준' },
      { value: 'time_prorated', label: '남은 일수 비율', hint: '시간 기준' },
      { value: 'min_of_both', label: '두 값 중 작은 쪽', hint: '가장 보수적' },
      { value: 'deny', label: '환불 거절', hint: '창 밖은 환불 없음' },
    ],
    default: def('refund.method'),
  },
  {
    id: 'refund_overuse_behavior',
    policyPath: 'refund.overuseBehavior',
    ec: ['D3'],
    type: 'select',
    group: 'refund',
    when: (c) => ['time_prorated', 'min_of_both'].includes(String(getPath(c.policy, 'refund.method'))),
    message: '사용량이 일할 비율을 초과했을 때 (Overuse behavior, 예: 90% 사용)',
    options: [
      { value: 'deny', label: '환불 거절', hint: '기본' },
      { value: 'refund_time_prorated_anyway', label: '그래도 일할 환불', hint: '고객에게 유리' },
    ],
    default: def('refund.overuseBehavior'),
  },
  {
    id: 'refund_rounding',
    policyPath: 'refund.rounding',
    ec: ['D4'],
    type: 'select',
    group: 'refund',
    when: (c) => ['time_prorated', 'min_of_both'].includes(String(getPath(c.policy, 'refund.method'))),
    message: '환불액 → 회수 크레딧 환산 시 반올림 방향 (Rounding of credits to revoke)',
    options: [
      { value: 'floor_credits', label: '내림', hint: '고객에게 유리 (기본)' },
      { value: 'ceil_credits', label: '올림', hint: '판매자에게 유리' },
      { value: 'round_credits', label: '반올림', hint: '중립' },
    ],
    default: def('refund.rounding'),
  },
  {
    id: 'refund_revoke_shortfall',
    policyPath: 'refund.revokeShortfall',
    ec: ['B13'],
    type: 'select',
    group: 'refund',
    when: hasCredits,
    message: '환불 시 크레딧 잔액 < 회수량 (Revoke shortfall, 이미 써버린 경우)',
    options: [
      { value: 'clamp_and_reduce_refund', label: '부족분만큼 환불액 감액', hint: '기본, 가장 공정' },
      { value: 'clamp_to_zero', label: '0까지만 회수, 환불액은 그대로', hint: '고객에게 유리' },
      { value: 'allow_negative', label: '음수 잔액 허용', hint: '위험' },
    ],
    default: def('refund.revokeShortfall'),
  },
  {
    id: 'refund_advanced',
    configPath: 'refundAdvanced',
    ec: ['D7', 'D10'],
    type: 'confirm',
    group: 'refund',
    message: '고급 환불 옵션 (Advanced refund options — 수수료 부담·연간 환불 횟수 제한) 을 설정할까요?',
    default: false,
  },
  {
    id: 'refund_fee_bearer',
    policyPath: 'refund.feeBearer',
    ec: ['D7'],
    type: 'select',
    group: 'refund',
    when: (c) => !!c.refundAdvanced,
    message: 'PG 수수료(환불 시 미반환분) 부담 주체 (Fee bearer)',
    options: [
      { value: 'merchant', label: '가맹점(우리)이 부담', hint: '기본, 고객 경험 좋음' },
      { value: 'customer', label: '고객이 부담 (수수료 차감 환불)', hint: '마진 보존' },
    ],
    default: def('refund.feeBearer'),
  },
  {
    id: 'refund_max_per_customer_per_year',
    policyPath: 'refund.maxPerCustomerPerYear',
    ec: ['D10'],
    type: 'number',
    group: 'refund',
    when: (c) => !!c.refundAdvanced,
    message: '고객당 연간 환불 허용 횟수 (Max refunds per year, 어뷰징 방지)',
    default: def('refund.maxPerCustomerPerYear'),
  },

  // 12. 이용량: C1 C2 C5 (usage 선택 시)
  {
    id: 'usage_overage',
    policyPath: 'usage.overage',
    ec: ['C1'],
    type: 'select',
    group: 'usage',
    when: hasUsageModel,
    message: '포함량 초과 사용 처리 (Overage)',
    options: [
      { value: 'hard_block', label: '차단', hint: '초과 시 사용 불가' },
      { value: 'soft_cap_notify', label: '허용 + 알림만', hint: '과금 없음' },
      { value: 'bill_overage', label: '초과분 과금', hint: '단가 필요' },
    ],
    default: def('usage.overage'),
  },
  {
    id: 'usage_overage_unit_price',
    policyPath: 'usage.overageUnitPriceMinor',
    ec: ['C1'],
    type: 'number',
    group: 'usage',
    when: (c) => hasUsageModel(c) && getPath(c.policy, 'usage.overage') === 'bill_overage',
    message: '초과분 단가 (Unit price, minor unit, 예: KRW 100 = 100원)',
    default: 100,
  },
  {
    id: 'usage_late_report_window_hours',
    policyPath: 'usage.lateReportWindowHours',
    ec: ['C2'],
    type: 'number',
    group: 'usage',
    when: hasUsageModel,
    message: '사용량 집계 지연 허용 시간 (Late report window, 시간, 주기 마감 후 이 안이면 직전 주기 귀속)',
    default: def('usage.lateReportWindowHours'),
  },
  {
    id: 'usage_included_quantity',
    policyPath: 'usage.includedQuantity',
    ec: ['C5'],
    type: 'number',
    group: 'usage',
    when: (c) => hasUsageModel(c) || hasUsageQuota(c),
    message: '무료 티어 포함 사용량 (Included quantity, 주기당)',
    default: def('usage.includedQuantity'),
  },
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

  // 14. 현금영수증(KR): K2 K3 K5 — provider 에 toss/portone 선택 시만
  {
    id: 'cash_receipt_mode',
    policyPath: 'cashReceipt.mode',
    ec: ['K2'],
    type: 'select',
    group: 'cashReceipt',
    when: hasKrProvider,
    message: '현금영수증 발행 (Cash receipt, KR 결제 법정 의무) — 카드 결제는 대상 아님',
    options: [
      { value: 'off', label: '미발행', hint: '직접 관리하거나 아직 대응 안 함' },
      { value: 'manual', label: '수동 발행', hint: 'CS·앱에서 나중에 요청' },
      { value: 'auto', label: '자동 발행', hint: '결제 성공 시 자동 (계좌이체·가상계좌·휴대폰만, 카드 제외)' },
    ],
    default: def('cashReceipt.mode'),
  },
  {
    id: 'cash_receipt_default_type',
    policyPath: 'cashReceipt.defaultType',
    ec: ['K3'],
    type: 'select',
    group: 'cashReceipt',
    when: (c) => hasKrProvider(c) && getPath(c.policy, 'cashReceipt.mode') !== 'off',
    message: '현금영수증 기본 종류 (Default receipt type)',
    options: [
      { value: 'personal', label: '소득공제 (개인)', hint: '식별번호 = 휴대폰번호 등' },
      { value: 'business', label: '지출증빙 (사업자)', hint: '식별번호 = 사업자등록번호' },
    ],
    default: def('cashReceipt.defaultType'),
  },
  {
    id: 'cash_receipt_cancel_on_refund',
    policyPath: 'cashReceipt.cancelOnRefund',
    ec: ['K5'],
    type: 'confirm',
    group: 'cashReceipt',
    when: (c) => hasKrProvider(c) && getPath(c.policy, 'cashReceipt.mode') !== 'off',
    message: '환불 시 현금영수증도 함께 취소할까요? (Cancel receipt on refund, 부분 환불은 부분 취소)',
    default: def('cashReceipt.cancelOnRefund'),
  },

  // 15. CS: E1(regrant mode) I1 I2 — CS 애드온 활성화 시
  {
    id: 'cs_enabled',
    configPath: 'cs.enabled',
    ec: ['PRD §4.3'],
    type: 'confirm',
    group: 'cs',
    message: 'CS 사용량 보고를 활성화할까요? (환불·재지급 규칙 실행은 기본 포함)',
    default: false,
  },
  // 13. 분쟁: B11 D9
  {
    id: 'dispute_on_open',
    policyPath: 'dispute.onOpen',
    ec: ['B11'],
    type: 'select',
    group: 'dispute',
    message: '차지백/분쟁 오픈 시 처리 (On dispute open)',
    options: [
      { value: 'freeze_customer', label: '고객 계정 동결 (소비 차단)', hint: '기본' },
      { value: 'revoke_disputed_grant', label: '분쟁 대상 지급분만 회수', hint: '계정은 정상 이용' },
      { value: 'none', label: '아무 조치 없음', hint: '수동 대응만' },
    ],
    default: def('dispute.onOpen'),
  },
  {
    id: 'dispute_on_lost',
    policyPath: 'dispute.onLost',
    ec: ['D9'],
    type: 'select',
    group: 'dispute',
    message: '분쟁 패소 시 처리 (On dispute lost)',
    options: [
      { value: 'revoke_and_ban', label: '회수 + 계정 정지', hint: '기본' },
      { value: 'revoke_only', label: '회수만', hint: '계정은 유지' },
    ],
    default: def('dispute.onLost'),
  },

  {
    id: 'cs_api_key',
    configPath: 'csApiKey',
    ec: ['CS_SERVER'],
    type: 'text',
    group: 'cs',
    when: csEnabled,
    message: 'CS SDK API 키 (PAYKIT_API_KEY, docs/CS_SERVER.md) — 비워두면 나중에 .env 에서 채우세요',
    default: '',
  },
  {
    id: 'cs_regrant_mode',
    policyPath: 'cs.regrant.mode',
    ec: ['A18', 'E1'],
    type: 'select',
    group: 'cs',
    message: '결제 성공 · 재화 미지급 시 재지급 (Regrant mode, webhook 유실)',
    options: [
      { value: 'auto', label: '규칙에 따라 재지급', hint: '결제와 원장 근거 확인 후 실행' },
      { value: 'manual_approve', label: '수동 승인', hint: '사람이 확인 후 실행' },
      { value: 'off', label: '끔', hint: 'CS 케이스만 생성, 실행 안 함' },
    ],
    default: def('cs.regrant.mode'),
  },
  {
    id: 'cs_auto_approve_max_amount',
    policyPath: 'cs.autoApprove.maxAmountMinor',
    ec: ['I1'],
    type: 'number',
    group: 'cs',
    message: '자동 승인 한도 — 금액 (Max amount, minor unit)',
    default: def('cs.autoApprove.maxAmountMinor'),
  },
  {
    id: 'cs_auto_approve_max_credits',
    policyPath: 'cs.autoApprove.maxCredits',
    ec: ['I1'],
    type: 'number',
    group: 'cs',
    message: '자동 승인 한도 — 크레딧 수 (Max credits)',
    default: def('cs.autoApprove.maxCredits'),
  },
  {
    id: 'cs_fraud_refund_velocity',
    policyPath: 'cs.fraud.refundVelocity',
    ec: ['I2'],
    type: 'number',
    group: 'cs',
    message: '환불 속도 이상 탐지 (Refund velocity) — 기간 내 최대 건수 초과 시 자동 거절',
    default: def('cs.fraud.refundVelocity'),
  },

  // 16. 인프라: 스키마 · webhook · 알림 · 언어
  {
    id: 'languages',
    configPath: 'languages',
    ec: ['ARCHITECTURE §6'],
    type: 'multiselect',
    group: 'infra',
    message: '생성할 언어 (Languages: TS · Py, 다중 선택 가능)',
    options: [
      { value: 'ts', label: 'TypeScript' },
      { value: 'py', label: 'Python' },
    ],
    default: ['ts'],
  },
  {
    id: 'infra_orm',
    configPath: 'infra.orm',
    ec: ['ARCHITECTURE §6'],
    type: 'select',
    group: 'infra',
    message: 'ORM (선택 안 하면 raw SQL 마이그레이션만 사용)',
    options: [
      { value: 'none', label: '없음 (raw SQL)', hint: '가장 단순, 마이그레이션 파일 그대로 적용' },
      { value: 'prisma', label: 'Prisma', hint: 'TS' },
      { value: 'drizzle', label: 'Drizzle', hint: 'TS' },
      { value: 'sqlalchemy', label: 'SQLAlchemy', hint: 'Py' },
    ],
    default: 'none',
  },
  {
    id: 'infra_webhook_path',
    configPath: 'infra.webhookPath',
    ec: ['ARCHITECTURE §6'],
    type: 'text',
    group: 'infra',
    message: 'Webhook 수신 경로 (Webhook path)',
    default: '/api/webhook/paykit',
  },
  {
    id: 'infra_notify_email',
    configPath: 'infra.notify.email',
    ec: ['Notifier'],
    type: 'select',
    group: 'infra',
    message: '이메일 알림 (Email notification)',
    options: [
      { value: 'none', label: '없음' },
      { value: 'resend', label: 'Resend' },
      { value: 'smtp', label: 'SMTP' },
    ],
    default: 'none',
  },
  {
    id: 'infra_notify_slack',
    configPath: 'infra.notify.slack',
    ec: ['Notifier'],
    type: 'confirm',
    group: 'infra',
    message: 'Slack 알림도 사용할까요? (Slack notification)',
    default: false,
  },
  {
    id: 'infra_logging',
    configPath: 'infra.logging',
    ec: ['L1', 'L2', 'L5'],
    type: 'select',
    group: 'infra',
    // CS 는 결제 실패에 대한 지원이 제품이다 — 증거 트레일(로그)이 없으면 "무슨 일이 있었는지"를
    // 재구성할 수 없다. database 는 항상 postgres 라 postgres 옵션이 항상 가능해 기본값이다.
    message: '결제 provider 왕복·오류를 어디에 기록할까요? (Audit logging, PII 는 자동 redact)',
    options: [
      { value: 'postgres', label: 'Postgres (audit_log 테이블)', hint: '기본, CS 조사에 쓸 수 있는 영구 기록' },
      { value: 'console', label: '콘솔 (stdout/stderr)', hint: '개발용, 영구 저장 안 됨' },
      { value: 'none', label: '끔', hint: '결제 실패를 재구성할 증거가 안 남습니다' },
    ],
    default: 'postgres',
  },
  {
    id: 'infra_scheduler',
    configPath: 'infra.scheduler',
    ec: ['F(Toss/Portone self)'],
    type: 'select',
    group: 'infra',
    // Toss 는 네이티브 구독이 없어 항상 자체 스케줄러를 씁니다 (질문 없이 강제). Portone 은
    // V2 schedule API 로 provider 측 예약도 가능해서 여기서만 선택을 묻는다.
    when: (c) => hasPortone(c),
    message: 'Portone 갱신 결제 스케줄링 방식 (Scheduler, Toss 는 네이티브 구독이 없어 항상 self)',
    options: [
      { value: 'provider', label: 'Provider 스케줄 (Portone V2 schedule API)', hint: '기본, provider 가 예약 결제 실행' },
      { value: 'self', label: '자체 스케줄러 (cron + billing key)', hint: '우리 cron 이 직접 결제 실행' },
    ],
    default: 'provider',
  },
];
