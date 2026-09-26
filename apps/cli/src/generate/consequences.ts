// Plain-language KO+EN consequence sentences for POLICY.md, keyed by policy path.
// Each sentence explains the selected rule and any required application integration.
export interface Consequence {
  ko: string;
  en: string;
}

type EnumTable = Record<string, Consequence>;
type NumberFn = (v: number) => Consequence;

const ENUM: Record<string, EnumTable> = {
  'period.monthEndAnchor': {
    clamp_keep_original_day: { ko: '월말 기준일 구독은 원래 가입일을 기억합니다. 짧은 달엔 말일에 청구되고, 긴 달이 오면 원래 일자로 돌아갑니다.', en: 'Month-end anchor subscriptions remember the original signup day; short months bill on the last day, then revert once a longer month returns.' },
    clamp_permanently: { ko: '월말 기준일 구독이 짧은 달을 한 번 만나면, 그 이후로는 영구히 그 날짜(예: 매월 28일)로 청구됩니다.', en: 'Once a month-end anchor subscription hits a short month, it permanently bills on that clamped day (e.g. the 28th) going forward.' },
  },
  'proration.denominator': {
    actual_days_in_period: { ko: '일할 계산은 해당 결제 주기의 실제 일수(28~31일)를 기준으로 합니다.', en: 'Proration uses the actual number of days in the billing period (28-31).' },
    fixed_30: { ko: '일할 계산은 모든 달을 30일로 취급합니다. 계산은 단순하지만 약간의 오차가 있습니다.', en: 'Proration treats every month as 30 days — simpler math, small rounding drift.' },
  },
  'credits.rollover': {
    none: { ko: '미사용 크레딧은 결제 주기가 끝나면 소멸합니다.', en: 'Unused credits expire at the end of each billing period.' },
    banked: { ko: '미사용 크레딧은 상한까지 다음 주기로 이월됩니다. 상한을 넘는 분량은 소멸합니다.', en: 'Unused credits roll over to the next period up to a cap; anything above the cap is forfeited.' },
    full: { ko: '미사용 크레딧은 상한 없이 전액 다음 주기로 이월됩니다.', en: 'All unused credits roll over to the next period with no cap.' },
  },
  'credits.bankReset': {
    on_renewal: { ko: '이월된(Banked) 크레딧은 매 갱신마다 상한 기준으로 다시 계산됩니다.', en: 'Banked credits are recalculated against the cap on every renewal.' },
    never: { ko: '이월된(Banked) 크레딧은 리셋되지 않고 계속 누적됩니다(상한 내에서).', en: 'Banked credits are never reset and keep accumulating within the cap.' },
    on_cancel: { ko: '이월된(Banked) 크레딧은 구독을 취소할 때만 리셋됩니다.', en: 'Banked credits are only reset when the subscription is canceled.' },
  },
  'credits.consumeOrder': {
    expiring_first: { ko: '크레딧은 만료일이 가장 임박한 것부터 먼저 소비됩니다(고객에게 가장 유리).', en: 'Credits closest to expiry are consumed first — most favorable to the customer.' },
    promo_first_then_expiring: { ko: '프로모션 크레딧을 먼저 소비하고, 그다음 만료 임박 순으로 소비합니다.', en: 'Promotional credits are consumed first, then remaining credits by expiry order.' },
    paid_first: { ko: '유료로 구매한 크레딧을 먼저 소비하고, 프로모션 크레딧은 나중에 소비합니다.', en: 'Paid credits are consumed before promotional credits.' },
  },
  'credits.negativeBalance': {
    block: { ko: '잔액이 부족하면 소비 요청 자체가 거절됩니다.', en: 'Consumption requests are rejected outright when the balance is insufficient.' },
    allow_to_floor: { ko: '잔액이 부족해도 정해진 하한까지는 음수로 허용되고, 다음 지급 시 상계됩니다.', en: 'Balances may go negative down to a floor; the deficit is offset against the next grant.' },
    allow_unbounded: { ko: '잔액이 무제한으로 음수가 될 수 있습니다(위험, 특수 목적 전용을 권장).', en: 'Balances may go negative without limit — high risk, recommended only for special cases.' },
  },
  'credits.pools': {
    separate: { ko: '유료 크레딧과 프로모션 크레딧은 별도 풀로 관리되며, 환불·회수는 유료 풀에만 적용됩니다.', en: 'Paid and promotional credits are tracked in separate pools; refunds and clawbacks only touch the paid pool.' },
    merged: { ko: '유료 크레딧과 프로모션 크레딧은 하나의 풀로 합산 관리됩니다.', en: 'Paid and promotional credits are combined into a single pool.' },
  },
  'upgrade.mode': {
    immediate_prorate_reset_anchor: { ko: '업그레이드 즉시 차액이 결제되고 늘어난 재화가 즉시 지급되며, 다음 결제일이 업그레이드한 날로 바뀝니다.', en: 'On upgrade, the price difference is charged and extra credits are granted immediately, and the billing anchor resets to the upgrade date.' },
    immediate_prorate_keep_anchor: { ko: '업그레이드 즉시 차액이 결제되지만, 다음 결제일은 원래대로 유지됩니다(다음 갱신부터 새 요금 적용).', en: 'The price difference is charged immediately, but the billing anchor stays the same — the new price applies from the next renewal.' },
    next_period: { ko: '업그레이드는 다음 결제 주기부터 적용됩니다. 지금 당장은 아무 변화가 없습니다.', en: 'The upgrade takes effect from the next billing period; nothing changes immediately.' },
  },
  'upgrade.creditDelta': {
    full_delta: { ko: '업그레이드 시 지급되는 재화는 신플랜과 구플랜의 전체 차이만큼입니다(이미 소모한 양과 무관).', en: 'The credits granted on upgrade equal the full difference between the new and old plan, regardless of what was already used.' },
    prorated_delta: { ko: '업그레이드 시 지급되는 재화는 남은 기간 비율만큼만 차감된 차이입니다.', en: 'The credits granted on upgrade are prorated by the remaining time in the period.' },
  },
  'downgrade.mode': {
    end_of_period: { ko: '다운그레이드는 다음 결제 주기부터 적용되며, 이미 지급된 재화는 그대로 유지됩니다.', en: 'Downgrades take effect from the next billing period; already-granted credits are kept.' },
    immediate_keep: { ko: '다운그레이드는 즉시 적용되어 요금이 바로 낮아지지만, 이미 지급된 재화는 회수하지 않습니다.', en: 'The lower price applies immediately, but already-granted credits are not clawed back.' },
    immediate_clawback: { ko: '다운그레이드는 즉시 적용되고, 새 플랜 기준을 초과하는 재화는 즉시 회수됩니다.', en: 'The downgrade applies immediately and any credits above the new plan’s allowance are clawed back right away.' },
  },
  'downgrade.clawbackShortfall': {
    clamp_to_zero: { ko: '회수할 재화보다 잔액이 적으면, 잔액이 0이 될 때까지만 회수합니다(음수로 만들지 않음).', en: 'If the balance is less than the clawback amount, the balance is reduced only to zero, never negative.' },
    allow_negative: { ko: '회수할 재화보다 잔액이 적으면 잔액이 음수가 될 수 있고, 다음 지급 시 상계됩니다.', en: 'If the balance is insufficient, it may go negative and is offset against the next grant.' },
    deny_downgrade: { ko: '회수할 재화보다 잔액이 적으면 다운그레이드 자체가 거절됩니다.', en: 'If the balance would be insufficient to cover the clawback, the downgrade is rejected outright.' },
  },
  'cancel.mode': {
    end_of_period: { ko: '구독을 취소해도 이미 결제한 주기가 끝날 때까지는 서비스를 계속 이용할 수 있습니다.', en: 'Canceling keeps the service active until the end of the already-paid period.' },
    immediate: { ko: '구독을 취소하면 즉시 서비스가 종료됩니다. 남은 기간에 대한 환불은 별도 정책(D1/D2)을 따릅니다.', en: 'Canceling ends the service immediately; any refund for remaining time follows the separate refund policy (D1/D2).' },
  },
  'cancel.credits': {
    keep_until_period_end: { ko: '취소 후에도 남은 재화는 결제한 주기가 끝날 때까지 사용할 수 있습니다.', en: 'Remaining credits stay usable until the paid period ends, even after cancellation.' },
    keep_forever: { ko: '취소 후에도 남은 재화는 만료되지 않고 영구히 사용할 수 있습니다.', en: 'Remaining credits never expire and stay usable indefinitely after cancellation.' },
    revoke_immediately: { ko: '취소하는 즉시 남은 재화는 모두 회수됩니다.', en: 'All remaining credits are revoked the moment the subscription is canceled.' },
  },
  'trial.creditsOnConvert': {
    grant_full: { ko: '트라이얼이 유료로 전환되면 유료 플랜의 재화가 전량 지급되고, 트라이얼 중 남은 재화는 폐기됩니다.', en: 'On trial-to-paid conversion, the full paid-plan credits are granted and any leftover trial credits are discarded.' },
    grant_full_keep_trial: { ko: '트라이얼이 유료로 전환되면 유료 플랜의 재화가 전량 지급되고, 트라이얼 중 남은 재화도 그대로 유지됩니다.', en: 'On conversion, the full paid-plan credits are granted and leftover trial credits are kept as well.' },
    no_grant_until_next_period: { ko: '트라이얼이 유료로 전환되어도 재화는 다음 결제 주기가 시작될 때까지 지급되지 않습니다.', en: 'Even after conversion, paid credits are not granted until the next billing period begins.' },
  },
  'trial.creditsOnCancel': {
    revoke: { ko: '트라이얼 중 취소하면 트라이얼 재화는 즉시 회수됩니다.', en: 'Canceling during the trial immediately revokes trial credits.' },
    keep: { ko: '트라이얼 중 취소해도 트라이얼 재화는 만료일까지 그대로 사용할 수 있습니다.', en: 'Trial credits remain usable until they expire, even if canceled during the trial.' },
  },
  'trial.abuseGuard': {
    one_per_customer: { ko: '동일한 이메일·결제수단으로는 트라이얼을 한 번만 받을 수 있습니다.', en: 'Only one trial is allowed per email address or payment method fingerprint.' },
    none: { ko: '트라이얼 반복 가입에 대한 제한이 없습니다.', en: 'There is no restriction on repeat trial signups.' },
  },
  'dunning.usageDuringGrace': {
    allow: { ko: '결제 실패 유예 기간 중에도 기존 재화를 계속 사용할 수 있습니다.', en: 'Existing credits remain usable throughout the payment-failure grace period.' },
    block: { ko: '결제 실패 유예 기간 중에는 재화 사용이 차단됩니다.', en: 'Credit usage is blocked during the payment-failure grace period.' },
    allow_existing_only: { ko: '유예 기간 중 기존 잔액은 사용할 수 있지만, 새 주기분 재화는 지급되지 않습니다.', en: 'Existing balances remain usable during grace, but no new period credits are granted.' },
  },
  'dunning.grantDuringGrace': {
    defer_until_paid: { ko: '유예 기간 중에는 새 주기 재화 지급이 결제 성공 시점까지 보류됩니다.', en: 'New-period credit grants are deferred until payment succeeds during the grace period.' },
    grant_anyway: { ko: '유예 기간 중이라도 새 주기 재화가 먼저 지급됩니다(결제가 계속 실패하면 손실 위험).', en: 'New-period credits are granted regardless during grace, risking loss if payment keeps failing.' },
  },
  'dunning.onFinalFailure': {
    revoke_unpaid_period: { ko: '유예 기간이 끝나도록 결제가 안 되면, 결제되지 않은 그 주기분 재화만 회수됩니다.', en: 'If grace expires unpaid, only the credits for that unpaid period are revoked.' },
    revoke_all: { ko: '유예 기간이 끝나도록 결제가 안 되면, 보유한 재화 전체가 회수됩니다.', en: 'If grace expires unpaid, all held credits are revoked.' },
    keep: { ko: '유예 기간이 끝나도록 결제가 안 되어도 재화는 회수되지 않습니다.', en: 'Credits are not revoked even after grace expires unpaid.' },
  },
  'dunning.onRecovery': {
    regrant_current_period: { ko: '결제가 복구되면 현재 주기분 재화만 다시 지급됩니다.', en: 'On payment recovery, only the current period’s credits are re-granted.' },
    regrant_all_missed: { ko: '결제가 복구되면 놓쳤던 모든 주기의 재화가 소급 지급됩니다.', en: 'On payment recovery, credits for every missed period are granted retroactively.' },
    no_regrant: { ko: '결제가 복구되어도 재화는 다시 지급되지 않습니다.', en: 'No credits are re-granted even after payment recovers.' },
  },
  'refund.method': {
    unused_credits: { ko: '무조건 환불 창 밖의 환불액은 미사용 크레딧 × 지급 당시 단가로 계산됩니다.', en: 'Outside the no-questions window, refunds are calculated as unused credits × the price at the time of grant.' },
    time_prorated: { ko: '무조건 환불 창 밖의 환불액은 결제 주기 중 남은 일수 비율로 계산됩니다.', en: 'Outside the no-questions window, refunds are prorated by the remaining days in the period.' },
    min_of_both: { ko: '무조건 환불 창 밖의 환불액은 미사용 크레딧 기준과 일할 기준 중 더 작은 금액으로 계산됩니다.', en: 'Outside the no-questions window, refunds use whichever is smaller: unused-credit value or time-prorated value.' },
    deny: { ko: '무조건 환불 창 밖에서는 환불이 제공되지 않습니다.', en: 'No refunds are offered outside the no-questions-asked window.' },
  },
  'refund.overuseBehavior': {
    deny: { ko: '일할 환불 대상인데 사용량이 일할 비율을 초과했다면 환불이 거절됩니다.', en: 'If usage exceeds the prorated share on a time-prorated refund, the refund is denied.' },
    refund_time_prorated_anyway: { ko: '사용량이 일할 비율을 초과했더라도 일할 계산대로 환불이 진행됩니다.', en: 'Even if usage exceeds the prorated share, the time-prorated refund is still issued.' },
  },
  'refund.revokeShortfall': {
    clamp_and_reduce_refund: { ko: '환불 대상 크레딧을 이미 다 써버렸다면, 부족한 만큼 환불액이 줄어듭니다.', en: 'If the credits to revoke were already spent, the refund amount is reduced by the shortfall.' },
    clamp_to_zero: { ko: '환불 대상 크레딧을 이미 다 써버렸어도 잔액은 0까지만 회수하고, 환불액은 그대로 지급됩니다.', en: 'Even if credits were already spent, only the balance down to zero is revoked; the refund amount is unaffected.' },
    allow_negative: { ko: '환불 대상 크레딧을 이미 다 써버렸다면 잔액이 음수가 될 수 있습니다.', en: 'If credits were already spent, the balance may go negative to cover the revocation.' },
  },
  'refund.reasons.technicalFailure': {
    rules: { ko: '기술 실패 사유여도 위 환불 금액 규칙을 그대로 적용합니다.', en: 'A technical-failure refund follows the amount rules above.' },
    full: { ko: '기술 실패 사유면 환불 창, 방식, 연간 제한과 무관하게 남은 결제 금액 전부를 환불합니다. 크레딧은 남은 만큼만 회수합니다. 앱은 support.requestRefund 에 reason 을 넘겨야 합니다.', en: 'A technical-failure refund returns the whole remaining payment regardless of window, method or annual limit; only the credits left are revoked. The app passes reason to support.requestRefund.' },
  },
  'refund.reasons.dissatisfied': {
    rules: { ko: '결과 불만족 사유여도 위 환불 금액 규칙을 그대로 적용합니다.', en: 'A dissatisfied refund follows the amount rules above.' },
    evidence_required: { ko: '결과 불만족 사유는 증빙(evidenceRef, 예: 작업 id)이 있으면 금액 규칙대로 처리하고, 없으면 담당자 확인으로 넘깁니다.', en: 'A dissatisfied refund with an evidenceRef (e.g. a job id) follows the amount rules; without one it goes to a person.' },
    needs_human: { ko: '결과 불만족 사유는 항상 담당자 확인으로 넘깁니다.', en: 'A dissatisfied refund always goes to a person.' },
  },
  'refund.reasons.userError': {
    rules: { ko: '사용자 과실 사유여도 위 환불 금액 규칙을 그대로 적용합니다.', en: 'A user-error refund follows the amount rules above.' },
    deny: { ko: '사용자 과실 사유의 환불 요청은 거절합니다.', en: 'Refund requests for user error are refused.' },
  },
  'refund.feeBearer': {
    merchant: { ko: 'PG 환불 수수료는 우리(가맹점)가 부담하며, 고객은 결제액 전액을 환불받습니다.', en: 'The merchant absorbs the payment-processor refund fee; the customer receives a full refund.' },
    customer: { ko: 'PG 환불 수수료는 고객이 부담하며, 환불액에서 수수료가 차감됩니다.', en: 'The payment-processor refund fee is deducted from the customer’s refund amount.' },
  },
  'usage.overage': {
    hard_block: { ko: '포함된 이용량을 초과하면 사용이 차단됩니다.', en: 'Usage is blocked once the included quota is exceeded.' },
    soft_cap_notify: { ko: '포함된 이용량을 초과해도 사용은 계속 허용되고 알림만 발송됩니다(추가 과금 없음).', en: 'Usage continues past the included quota with only a notification — no extra charge.' },
    bill_overage: { ko: '포함된 이용량을 초과하면 초과분에 대해 정해진 단가로 추가 과금됩니다.', en: 'Usage beyond the included quota is billed at a fixed per-unit overage price.' },
  },
  'dispute.onOpen': {
    freeze_customer: { ko: '차지백/분쟁이 열리면 해당 고객 계정은 재화 소비가 즉시 차단됩니다.', en: 'When a dispute opens, the customer’s account is immediately frozen from spending credits.' },
    revoke_disputed_grant: { ko: '차지백/분쟁이 열리면 분쟁 대상 결제로 지급된 재화만 회수되고, 계정은 정상 이용됩니다.', en: 'When a dispute opens, only the credits from the disputed payment are revoked; the account stays active.' },
    none: { ko: '차지백/분쟁이 열려도 자동 조치는 없으며 수동으로 대응합니다.', en: 'No automatic action is taken when a dispute opens; it is handled manually.' },
  },
  'dispute.onLost': {
    revoke_and_ban: { ko: '분쟁에서 패소하면 지급된 재화를 회수하고 계정을 정지합니다.', en: 'A lost dispute results in credit revocation and the account being banned.' },
    revoke_only: { ko: '분쟁에서 패소하면 지급된 재화만 회수하고 계정은 유지됩니다.', en: 'A lost dispute revokes the credits but the account remains active.' },
  },
  'cs.regrant.mode': {
    auto: { ko: '저장된 구매 근거와 실제 결제를 확인해 미지급 재화를 자동 복구합니다. 근거가 부족한 건은 담당자 확인으로 남깁니다.', en: 'Missing grants are restored after verifying recorded purchase evidence and live payment. Incomplete evidence requires human review.' },
    manual_approve: { ko: '결제는 성공했는데 재화가 지급되지 않은 사례가 발견되면, 사람이 승인해야 재지급됩니다.', en: 'Paid-but-ungranted cases require human approval before credits are re-granted.' },
    off: { ko: '결제는 성공했는데 재화가 지급되지 않은 사례가 발견되면, CS 케이스만 생성되고 자동 재지급은 하지 않습니다.', en: 'Paid-but-ungranted cases only open a CS case; no automatic re-grant is performed.' },
  },
  // EC:K2 K3 — KR 현금영수증.
  'cashReceipt.mode': {
    off: { ko: '현금영수증을 발행하지 않습니다. 한국 B2C 결제라면 법정 의무를 별도로 챙겨야 합니다.', en: 'Cash receipts are not issued. If this sells to Korean consumers, the legal obligation must be handled separately.' },
    manual: { ko: '현금영수증은 CS·앱에서 요청할 때만 발행됩니다.', en: 'Cash receipts are issued only when requested via CS or the app.' },
    auto: { ko: '결제가 성공하면 현금성 결제수단(계좌이체·가상계좌·휴대폰)에 한해 현금영수증이 자동 발행됩니다. 카드 결제는 대상이 아닙니다.', en: 'On a successful payment, a cash receipt is auto-issued for cash-based methods (bank transfer, virtual account, mobile) only — card payments are not eligible.' },
  },
  'cashReceipt.defaultType': {
    personal: { ko: '현금영수증 기본 종류는 소득공제(개인)이며, 식별번호로 휴대폰번호 등을 사용합니다.', en: 'Cash receipts default to the personal income-deduction type, identified by a phone number or similar.' },
    business: { ko: '현금영수증 기본 종류는 지출증빙(사업자)이며, 식별번호로 사업자등록번호를 사용합니다.', en: 'Cash receipts default to the business expense-proof type, identified by a business registration number.' },
  },
};

const BOOL: Record<string, (v: boolean) => Consequence> = {
  // EC:K5 — KR 현금영수증 취소.
  'cashReceipt.cancelOnRefund': (v) => v
    ? { ko: '환불이 성공하면 발행된 현금영수증도 함께 취소됩니다(부분 환불은 부분 취소).', en: 'When a refund succeeds, the issued cash receipt is also cancelled (a partial refund cancels a partial amount).' }
    : { ko: '환불이 발생해도 발행된 현금영수증은 그대로 유지됩니다.', en: 'Issued cash receipts are left untouched even when a refund happens.' },
};

const NUMBER: Record<string, NumberFn> = {
  'credits.bankCap': (v) => ({ ko: `이월(Banked) 크레딧은 최대 ${v.toLocaleString()} 까지 누적됩니다.`, en: `Banked credits accumulate up to a cap of ${v.toLocaleString()}.` }),
  'credits.negativeFloor': (v) => ({ ko: `잔액은 최소 ${v.toLocaleString()} 까지 음수가 될 수 있습니다.`, en: `The balance may go as low as ${v.toLocaleString()} (negative).` }),
  'credits.topupExpiryDays': (v) => v === 0
    ? { ko: '충전(top-up) 크레딧은 만료되지 않습니다.', en: 'Top-up credits never expire.' }
    : { ko: `충전(top-up) 크레딧은 지급일로부터 ${v}일 후 만료됩니다.`, en: `Top-up credits expire ${v} days after they are granted.` },
  'dunning.graceDays': (v) => v === 0
    ? { ko: '갱신 결제가 실패하면 유예 없이 즉시 서비스가 정지됩니다.', en: 'A failed renewal payment immediately suspends service with no grace period.' }
    : { ko: `갱신 결제가 실패하면 ${v}일의 유예 기간이 주어집니다.`, en: `A failed renewal payment gets a ${v}-day grace period before suspension.` },
  'refund.noQuestionsDays': (v) => v === 0
    ? { ko: '무조건 환불 창이 없습니다 — 모든 환불은 정책 기준 심사를 거칩니다.', en: 'There is no no-questions-asked refund window; every refund is evaluated against policy.' }
    : { ko: `결제 후 ${v}일 이내에는 사용량과 무관하게 전액 환불됩니다.`, en: `Within ${v} days of payment, refunds are issued in full regardless of usage.` },
  'refund.maxPerCustomerPerYear': (v) => ({ ko: `고객 1인당 연간 환불은 최대 ${v}회까지 허용됩니다.`, en: `A customer may receive at most ${v} refund(s) per year.` }),
  'usage.overageUnitPriceMinor': (v) => ({ ko: `초과 사용분은 단위당 ${v.toLocaleString()} (minor unit) 로 과금됩니다.`, en: `Overage usage is billed at ${v.toLocaleString()} (minor unit) per unit.` }),
  'usage.lateReportWindowHours': (v) => ({ ko: `사용량 보고가 주기 마감 후 ${v}시간 이내에 도착하면 직전 주기로 귀속됩니다.`, en: `Usage reported within ${v} hours after period close is attributed to the prior period.` }),
  'usage.includedQuantity': (v) => v === 0
    ? { ko: '무료로 포함된 이용량은 없습니다.', en: 'No usage is included for free.' }
    : { ko: `매 주기 ${v.toLocaleString()} 단위까지 무료로 포함됩니다.`, en: `${v.toLocaleString()} units are included free every period.` },
  'cs.autoApprove.maxAmountMinor': (v) => ({ ko: `${v.toLocaleString()} (minor unit) 이하 CS 케이스는 사람 검토 없이 자동 승인됩니다.`, en: `CS cases up to ${v.toLocaleString()} (minor unit) are auto-approved without human review.` }),
  'cs.autoApprove.maxCredits': (v) => ({ ko: `${v.toLocaleString()} 크레딧 이하 CS 케이스는 자동 승인됩니다.`, en: `CS cases up to ${v.toLocaleString()} credits are auto-approved.` }),
  'cs.fraud.refundVelocity': (v) => ({ ko: `설정된 기간 내 환불 요청이 ${v}건을 초과하면 자동으로 거절되고 사람에게 넘어갑니다.`, en: `More than ${v} refund requests in the configured window are auto-rejected and escalated to a human.` }),
};

const TEXT: Record<string, (v: string) => Consequence> = {
  'period.timezone': (v) => ({ ko: `모든 결제 주기·일할 계산은 ${v} 타임존을 기준으로 합니다.`, en: `All billing period and proration math is computed in the ${v} timezone.` }),
};

export function consequenceFor(policyPath: string, value: unknown): Consequence | null {
  if (typeof value === 'string') {
    const table = ENUM[policyPath];
    if (table && table[value]) return table[value];
    if (TEXT[policyPath]) return TEXT[policyPath](value);
  }
  if (typeof value === 'number' && NUMBER[policyPath]) return NUMBER[policyPath](value);
  if (typeof value === 'boolean' && BOOL[policyPath]) return BOOL[policyPath](value);
  return null;
}
