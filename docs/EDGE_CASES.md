# Edge Cases — 결제 · 재화(크레딧/이용량) · 환불 · CS

작성일: 2026-09-09
이 문서가 Kit 의 핵심이다. **모든 케이스는 (정책 키, 기본값, 담당 모듈, 우선순위) 를 가진다.**
정책 키는 그대로 위저드 질문이 되고 `paykit.config.json` 의 필드가 된다.

우선순위: **P0** = v0 위저드·모듈에 반드시 반영 / **P1** = v0 스텁, v1 구현 / **P2** = 문서화만

정책 키 표기: `policy.<영역>.<키>`. 값은 enum 또는 숫자.

---

## A. 구독 라이프사이클

| ID | 케이스 | 정책 키 | 선택지 (기본값 **굵게**) | 모듈 | P |
|---|---|---|---|---|---|
| A1 | 업그레이드(중간 주기) — 차액 결제·재화 차액 지급·기준일 | `policy.upgrade.mode` | **`immediate_prorate_reset_anchor`** (차액 즉시 결제 + 재화 차액 즉시 지급 + 기준일 = 업그레이드일) / `immediate_prorate_keep_anchor` (차액 즉시, 기준일 유지, 다음 갱신은 새 요금) / `next_period` (다음 주기부터, 지금은 변화 없음) | lifecycle | P0 |
| A2 | 업그레이드 시 재화 차액 계산 — 이미 일부 소모한 경우 | `policy.upgrade.credit_delta` | **`full_delta`** (신플랜 − 구플랜 전량) / `prorated_delta` (남은 기간 비율만큼) | lifecycle · credits | P0 |
| A3 | 다운그레이드 — 기지급 재화 처리 | `policy.downgrade.mode` | **`end_of_period`** (다음 주기부터, 기지급 유지) / `immediate_keep` (즉시 요금 변경, 기지급 유지) / `immediate_clawback` (즉시 + 초과분 회수) | lifecycle · credits | P0 |
| A4 | 다운그레이드 회수 시 잔액 < 회수량 (이미 써버림) | `policy.downgrade.clawback_shortfall` | **`clamp_to_zero`** (0까지만 회수) / `allow_negative` (음수 잔액, 다음 지급에서 상계) / `deny_downgrade` (다운그레이드 거절) | credits | P0 |
| A5 | 취소 — 주기 말까지 이용 vs 즉시 종료 | `policy.cancel.mode` | **`end_of_period`** / `immediate` | lifecycle | P0 |
| A6 | 취소 후 남은 재화 처리 | `policy.cancel.credits` | **`keep_until_period_end`** / `keep_forever` / `revoke_immediately` | credits | P0 |
| A7 | 취소 → 같은 주기 안에 재활성화 | (파생) | 같은 주기 재지급 금지. 멱등키 = `(subscription_id, period_start)` | lifecycle | P0 |
| A8 | 주기 변경 (월→연, 연→월) | `policy.interval_change.mode` | **`treat_as_upgrade`** (연 전환 = 업그레이드 규칙) / `next_period` | lifecycle | P1 |
| A9 | 트라이얼 → 유료 전환 — 트라이얼 재화와 유료 재화 | `policy.trial.credits_on_convert` | **`grant_full`** (전환 시 유료분 전량 지급, 트라이얼 잔여 폐기) / `grant_full_keep_trial` / `no_grant_until_next_period` | lifecycle · credits | P0 |
| A10 | 트라이얼 취소 — 트라이얼 재화 회수 | `policy.trial.credits_on_cancel` | **`revoke`** / `keep` | credits | P1 |
| A11 | 트라이얼 반복 가입 어뷰징 | `policy.trial.abuse_guard` | **`one_per_customer`** (이메일·결제수단 지문) / `none` | lifecycle · cs | P1 |
| A12 | 일시정지 / 재개 | `policy.pause.mode` | **`unsupported`** / `freeze_credits` (잔액 동결, 만료 정지) / `keep_running` | lifecycle | P2 |
| A13 | 갱신 결제 실패 — 유예 기간 | `policy.dunning.grace_days` | **7** (0 = 즉시 정지) | lifecycle · dunning | P0 |
| A14 | 유예 중 재화 사용 허용 | `policy.dunning.usage_during_grace` | **`allow`** / `block` / `allow_existing_only` (신규 지급 없이 잔액만) | credits · usage | P0 |
| A15 | 유예 중 신규 주기 재화 지급 여부 | `policy.dunning.grant_during_grace` | **`defer_until_paid`** / `grant_anyway` | credits | P0 |
| A16 | 최종 실패 (유예 만료) — 재화 처리 | `policy.dunning.on_final_failure` | **`revoke_unpaid_period`** (미결제 주기분만 회수) / `revoke_all` / `keep` | credits | P0 |
| A17 | 최종 실패 후 결제 복구 — 재지급 | `policy.dunning.on_recovery` | **`regrant_current_period`** / `regrant_all_missed` / `no_regrant` | credits · cs | P0 |
| A18 | 갱신 결제는 성공했는데 지급 작업이 실패 (앱 장애·DB 다운) | (CS 핵심) | 원장 대조로 `expected_grants − actual_grants` 산출 → `cs.regrant`. 정책 `policy.cs.regrant.mode`: **`auto`** / `manual_approve` / `off` | cs | P0 |
| A19 | 고객 1명이 구독 여러 개 | `policy.subscription.multiple_per_customer` | **`deny`** / `allow_separate_pools` / `allow_merged_pool` | lifecycle · credits | P1 |
| A20 | 좌석(seat) 수량 변경 | — | v0 비범위. 좌석 = 재화 종류 `seat` 로 열어둠 | — | P2 |
| A21 | 가격 인상 — 기존 구독자 적용 | `policy.pricing.grandfather` | **`grandfather_forever`** / `apply_next_period_with_notice` | lifecycle | P2 |
| A22 | 구독 생성 직후 즉시 취소 (오결제) | (D1 로 처리) | N일 무조건 환불 창 | refund | P0 |
| K1 | 동일 구독에 대한 동시 쓰기 경합 (업그레이드 vs 갱신 webhook vs 유예만료 vs self-scheduling 스케줄러 tick) | (구현 규칙) | `Subscription.version: int` optimistic lock. `Repo.subscriptions.put` 은 caller 가 읽은 버전과 저장된 버전이 다르면 거절(`PaymentKitError('subscription_version_conflict')`, `details.expected`/`details.got`)하고, 성공하면 버전을 올려 caller 의 객체에도 반영한다 — InMemory `VersionedMemTable` 과 Postgres `SubscriptionsTable`(`update ... where id=$1 and version=$2`, 0행이면 재조회로 "행 없음"과 "버전 불일치"를 구분해 insert-or-conflict) 모두 동일 계약. 같은 객체를 한 번 읽고 두 번 쓰는 경우(멱등 재시도 등)는 계속 동작한다 — 충돌하는 것은 서로 다른 두 개의 독립적인 읽기뿐이다. 호출자는 write 직전 재조회하거나 `lifecycle.retryOnVersionConflict(fn, attempts=3)` 로 감싼다(호출부 감사: `packages/lifecycle` `scheduler.tick`, `packages/webhook` `onPaymentSucceeded`/`onSubscriptionPaymentFailed`/`onSubscriptionCanceled`에 적용) | lifecycle · schema · webhook | P0 |
| A23 | 취소 철회(재활성화) — `cancelAtPeriodEnd` 예약 취소, 또는 아직 안 끝난 주기 내 즉시 취소를 되돌림 | (정책 키 없음 — 앱이 명시적으로 호출하는 연산이지 자동 정책 분기가 아니다) | `lifecycle.reactivate({sub, policy, provider, ledger, repo, clock, idempotencyKey?, correlationId?})`. `cancelAtPeriodEnd=true` → 해제하고 `active` 유지 / `status='canceled'` 이고 `now < currentPeriod.end` → `active` 복귀 / `status='expired'` 이거나 주기가 이미 끝났거나 애초에 되돌릴 취소가 없으면 → `PaymentKitError('not_reactivatable')`(새 구독 필요). **2026-09-09 갱신 — `PaymentProvider.uncancelSubscription(providerRef)` 신설로 이전 계약 갭 해소**: self-scheduling provider(`capabilities().nativeSubscriptions=false`, Toss/PortOne)는 여전히 호출 안 함(`providerNotified:false`) / 네이티브 provider(Stripe: `subscriptions.update(ref,{cancel_at_period_end:false})`, 이미 `canceled` 면 `PaymentKitError('not_reactivatable')`; Polar: 동일 REST PATCH 패턴, `polar.sh/docs/features/subscriptions/manage` 확인)는 실제로 호출해 provider 쪽도 정정하고 `providerNotified:true`. 어댑터가 `'unsupported'` 를 던지면 Repo 만 정정하고 `providerNotified:false`로 계속 진행, `'not_reactivatable'`(그 외 에러 포함)은 그대로 전파해 Repo 를 건드리지 않는다. `policy.cancel.credits='revoke_immediately'` 로 취소 시 회수됐던 크레딧은 `cs.dispute` 의 승소 복원과 같은 패턴으로 버킷별(원래 만료일 유지) 복원, 멱등키 `restore:reactivate:{sub.id}:{periodStart}:{grantId}` | lifecycle · providers.* | P0 |
| A24 | 갱신 결제 실패 — 유예 기간 안에서의 스마트 재시도(dunning retry) 횟수·간격 | `policy.dunning.retryAttempts` / `policy.dunning.retryIntervalHours` | **`retryAttempts=3`** (0 = provider 자체 dunning 에만 맡김) · **`retryIntervalHours=[24,72,120]`** (시간 단위, 목록이 retryAttempts 보다 짧으면 마지막 값을 반복). `dunning.onPaymentFailed` 가 첫 재시도를 `repo.outbox`(kind=`dunning.retry`)에 예약하고, `dunning.retryDue`/`dunning.runRetry` 가 예정 시각마다 재청구한다: self-scheduling provider(`capabilities().scheduling==='self'`)이고 `billingKey` 가 있으면 `provider.chargeBillingKey` 로 실제 재청구, 성공하면 A17 `dunning.onRecovered` 로 합류, 실패하면 다음 간격으로 재예약; provider 자체 스케줄(Stripe/Polar/PortOne) 구독은 청구하지 않고 카운터만 진행시켜 재시도 소진 시점에 `grace.ending` 알림이 제때 나가게만 한다(실제 회복 여부는 provider 의 webhook 이 결정). 재시도 소진 후에는 기존 `graceUntil` 기반 `dunning.onGraceExpired` 경로가 그대로 마무리한다. 멱등키 `dunning-retry:{sub.id}:{attempt}` | lifecycle | P0 |
| A25 | 갱신 결제가 아직 확정 전(pending·draft 인보이스, requires_action)이거나 실패인데 갱신 지급 경로로 들어옴 | (정책 키 없음 — 돈이 들어오지 않은 주기는 지급하지 않는다) | `lifecycle.onRenewalPaid` 가 `payment.status !== 'succeeded'` 면 쓰기 전에 `PaymentKitError('renewal_payment_not_succeeded')`. webhook 레코드는 failed 로 남고 재시도가 결제를 다시 조회해 succeeded 가 되면 한 번 지급(A7 멱등키 그대로). 이미 지급된 주기의 재전송은 A7 no-op. scheduler 는 succeeded 일 때만 호출하므로 변화 없음 | lifecycle · webhook | P0 |

## B. 크레딧 원장

| ID | 케이스 | 정책 키 | 선택지 | 모듈 | P |
|---|---|---|---|---|---|
| B1 | 이월(Rollover) | `policy.credits.rollover` | **`none`** (주기 말 소멸) / `banked` (상한 `policy.credits.bank_cap` 까지 누적) / `full` (전액 이월) | credits | P0 |
| B2 | Banked reset 시점 | `policy.credits.bank_reset` | **`on_renewal`** / `never` / `on_cancel` | credits | P0 |
| B3 | 만료 — 소비 순서 | `policy.credits.consume_order` | **`expiring_first`** (FIFO by expiry) / `promo_first_then_expiring` / `paid_first` | credits | P0 |
| B4 | 음수 잔액 | `policy.credits.negative_balance` | **`block`** (소비 거절) / `allow_to_floor` (하한 `policy.credits.negative_floor` 까지 허용. 하한을 넘는 요청은 **부분 이행 없이 전부 거절** — 원자성 우선) / `allow_unbounded` | credits | P0 |
| B5 | 동시 소비 경합 (race) | (구현 규칙) | 원장 append + `SELECT ... FOR UPDATE` on customer pool 또는 `balance_version` optimistic lock. 단일 SQL 로 잔액 검증+삽입 | credits · schema | P0 |
| B6 | 지급 지연 중 소비 시도 (결제 완료 → 지급까지 수초) | `policy.credits.grant_lag_behavior` | **`reject`** (잔액 부족) / `optimistic_hold` (결제 성공 이벤트 기준 임시 허용) | credits | P1 |
| B7 | 유료 크레딧 vs 프로모 크레딧 풀 분리 | `policy.credits.pools` | **`separate`** (환불·회수는 paid 풀만) / `merged` | credits · refund | P0 |
| B8 | 크레딧 단가가 주기마다 다름 (환불액 산정) | (구현 규칙) | 각 grant 행에 `unit_price_minor` · `currency` 저장. 환불액 = 미사용 × 해당 grant 단가 | credits · refund | P0 |
| B9 | 관리자 수동 지급·회수 | (구현 규칙) | `reason` · `actor` 필수, `source = manual` | credits | P0 |
| B10 | 일회성 충전(top-up) vs 구독 크레딧 | `policy.credits.topup_expiry_days` | **`null`** (무만료) / N | credits | P0 |
| B11 | 지급 후 차지백/분쟁 | `policy.dispute.on_open` | **`freeze_customer`** (소비 차단) / `revoke_disputed_grant` (회수는 **grant 버킷별로 귀속**: `reference.grantId`, 키 `revoke:dispute:{caseId}:{grantId}` — 그래야 승소 시 복원과 만료(B14) 계산이 맞는다. 이미 써버린 분은 귀속 없이 회수되어 잔액이 음수가 될 수 있다) / `none` | cs · credits | P0 |
| B12 | webhook 재전송 → 이중 지급 | (구현 규칙) | `idempotency_key = provider_event_id` UNIQUE. 재전송은 no-op | credits · webhook | P0 |
| B13 | 지급 취소 (환불) 시 잔액 < 회수량 | `policy.refund.revoke_shortfall` | **`clamp_and_reduce_refund`** (부족분만큼 환불액 감액) / `clamp_to_zero` / `allow_negative` | refund · credits | P0 |
| B14 | 만료 배치가 늦게 돌아 만료된 크레딧이 소비됨 | (구현 규칙) | 소비 시점에 `expires_at > now` 를 조건으로 필터. 배치는 정리용일 뿐 | credits | P0 |
| B15 | 잔액 조회 성능 (원장 합계) | (구현 규칙) | `credit_balances` 스냅샷 테이블 + 원장 트리거/앱 갱신. 정합성 검사 잡 | schema | P1 |
| B16 | 크레딧 만료 예정 알림 | `policy.credits.expiry_notice_days` | **`null`** (알림 없음) / N (만료 N일 전부터 알림). `credits.notifyExpiring({customerId?, ledger, repo, notifier, policy, clock})` 가 paid pool 의 grant 잔여 버킷 중 `expiresAt` 이 `[now, now+N일]` 안에 드는 것을 찾아 `pending` 목록으로 반환한다. `(customer, expiresAt, day)` 단위로 멱등(같은 날 재실행은 스팸 방지, 다음날은 다시 알림) — `repo.outbox` 를 dedup 마커로 사용, 키 `credits-expiry-notice:{customerId}:{expiresAt}:{day}`. ⚠ 계약 변경 제안: 실제 발송에는 core `NotifyType` 에 크레딧 만료 전용 케이스가 필요(`card.expiring` 은 결제 카드 전용 문구라 재사용 불가) — core 수정 권한 밖이라 이 함수는 `pending` 만 반환하고 notifier 는 아직 호출하지 않는다 | credits | P0 |
| B17 | 음수 잔액 상태에서 새 지급이 들어올 때 처리 | `policy.credits.negative_offset` | **`offset_next_grant`** (새 지급이 기존 음수를 먼저 상계하고 나머지만 사용 가능 — 예: 기존 -30, 신규 지급 100 → 70 만 즉시 소비 가능) / `never` (음수 잔액을 그대로 방치). `credits.grantForPeriod` / `credits.topup` 두 지급 경로 안에서 처리하며, 원장 산술 자체는 건드리지 않고 **별도의 `adjust` 원장 행**(`source` 는 grant 와 동일, 키 `offset:{grantIdempotencyKey}`)으로 상계를 남겨 타임라인에서 "100 지급, 30 은 기존 음수 잔액에 적용, 70 사용 가능" 처럼 보이게 한다 | credits | P0 |
| B18 | 차지백 증빙(evidence) 수집·제출 마감 (D9 보강) | `policy.dispute.evidence_due_days` | **`7`** (분쟁 오픈 후 N일 안에 체크리스트 수집·제출. 체크리스트는 결제 기록·원장 grant/consume 이력·이용량·환불 이력·CS 케이스 기록에서 도출, 없는 항목은 `available:false`+사유(약관 동의 이력은 kit 이 아예 안 갖고 있어 항상 이 상태). provider 가 프로그램적 제출을 지원하면(duck-typed `submitDisputeEvidence`, Stripe 有 / Toss·PortOne 無) 자동 제출, 아니면 `submitted:false, reason:'provider_unsupported'` + 체크리스트 첨부해 사람에게 에스컬레이션. 마감 24시간 전이고 체크리스트 미완이면 크론이 재에스컬레이션 | cs | P1 |

## C. 이용량(Usage)

| ID | 케이스 | 정책 키 | 선택지 | 모듈 | P |
|---|---|---|---|---|---|
| C1 | 초과 사용 | `policy.usage.overage` | **`hard_block`** / `soft_cap_notify` / `bill_overage` (단가 `policy.usage.overage_unit_price_minor`) | usage | P0 |
| C2 | 사용량 집계 지연 — 주기 마감 후 도착 | `policy.usage.late_report_window_hours` | **48** (창 안이면 직전 주기에 귀속, 밖이면 현재 주기) | usage | P0 |
| C3 | 주기 경계 타임존 | `policy.period.timezone` | **`UTC`** / IANA tz | core | P0 |
| C4 | provider 미터 보고 실패 (Stripe meter events / Polar meters) | (구현 규칙) | 로컬 `usage_events` 가 원본. provider 보고는 outbox 재시도 | usage · providers | P0 |
| C5 | 무료 티어 포함량 | `policy.usage.included_quantity` | **0** | usage | P0 |
| C6 | 유예(past_due) 중 사용 | (A14 공유) | | usage | P0 |
| C7 | 사용량 분쟁 ("난 안 썼다") | (CS) | `usage_events` 에 `request_id` · `ip` · `user_agent` 메타 저장 → 증빙 | cs · usage | P1 |
| C8 | 사용량 → 크레딧 환산 (하이브리드) | `policy.usage.credit_conversion` | **`null`** / `{unit, credits_per_unit}` | usage · credits | P1 |
| C10 | 오래 걸리는 작업의 예산 예약 (영상 처리, 대량 변환 등) | `policy.usage.reservation_ttl_minutes` | **60** 분. `usage.reserve` 가 작업 id 로 크레딧을 hold 하고(남은 예산 = 잔액 − 살아 있는 예약, 모자라면 `{need, available}` 로 거절), 성공하면 `usage.commit` 이 실제 사용량(≤ 예약)만 청구하고 나머지를 풀며, 실패·취소는 `usage.release` 로 청구 없이 푼다. 만료된 예약은 `cron.sweepReservations` 가 푼다. 같은 고객의 예약 경쟁은 고객 단위 원장 트랜잭션으로 직렬화되어 마지막 예산은 하나만 가져간다 | usage | P0 |
| C9 | 주기 마감 후 도착한 사용량 재정산 | (구현 규칙) | 마감(`closePeriod`) 뒤에도 C2 창 안이면 `record()` 가 그 주기로 귀속시키므로, **`usage.resettlePeriod` 로 다시 정산**해 증분만 청구한다(`newlyReported` · `additionalOverage`). 정산 완료 총량은 `usage_periods` 에 갱신되어 재실행이 멱등이다. 이게 없으면 늦게 온 사용량은 **영원히 청구되지 않는다** | usage | P0 |

## D. 환불

| ID | 케이스 | 정책 키 | 선택지 | 모듈 | P |
|---|---|---|---|---|---|
| D1 | 무조건 환불 창 | `policy.refund.no_questions_days` | **7** (0 = 없음). 창 안이면 사용량 무관 전액 | refund | P0 |
| D2 | 창 밖 환불 — 산정 방식 | `policy.refund.method` | **`unused_credits`** (미사용 크레딧 × 단가) / `time_prorated` (남은 일수 / 주기 일수) / `min_of_both` / `deny` | refund | P0 |
| D3 | 사용량이 일할 비율을 초과 (`time_prorated` 인데 90% 씀) | `policy.refund.overuse_behavior` | **`deny`** / `refund_time_prorated_anyway` | refund | P0 |
| D4 | 부분 환불 → 부분 회수 | (구현 규칙) | 회수량 = round(환불액 / 단가). 반올림 방향 `policy.refund.rounding`: **`floor_credits`** | refund | P0 |
| D5 | 연간 플랜 환불 | `policy.refund.annual_method` | **`same_as_monthly`** / `deny_after_days:N` | refund | P1 |
| D6 | 통화 · 환율 (KRW 결제, USD 표기) | (구현 규칙) | 환불은 **결제 통화·결제 금액 기준**. 원장 단가는 결제 통화 minor unit | refund · providers | P0 |
| D7 | PG 수수료 (provider 가 환불 시 수수료 미반환) | `policy.refund.fee_bearer` | **`merchant`** / `customer` (수수료 차감 환불) | refund | P1 |
| D8 | provider 대시보드에서 직접 환불 (SDK 밖) | (구현 규칙) | `refund.*` webhook 수신 → 원장 대조 → 회수. 미매칭이면 CS 케이스 생성 | webhook · cs | P0 |
| D9 | 차지백 / 분쟁 종결 | (B11 공유) `policy.dispute.on_lost` | **패소**: `on_lost` = **`revoke_and_ban`** / `revoke_only` — **둘 다 회수한다**(카드사가 돈을 가져갔으므로). `on_open` 에서 이미 회수했으면 멱등키로 no-op. **승소**: 이 분쟁으로 회수한 크레딧을 **전부 복원**(`restore:dispute:{caseId}:{grantId}`, 원래 만료일 유지) 하고 동결 해제 — **정책 선택이 아니다**(돈도 갖고 재화도 뺏으면 이중 청구) | cs | P0 |
| D10 | 환불 → 재구매 반복 어뷰징 | `policy.refund.max_per_customer_per_year` | **2** | refund · cs | P1 |
| D11 | 세금 (KR 부가세 · EU VAT) | (구현 규칙) | 환불액은 세포함 결제액 기준. 세금 처리는 provider 위임 (Stripe Tax · Toss 는 PG 정산) | refund | P1 |
| D12 | 환불 실패 (카드 만료·계좌 폐쇄) | (구현 규칙) | 원장 회수 롤백 없음 → `refund_attempts` 재시도 → 실패 시 CS 케이스 (`manual_payout`) | refund · cs | P0 |
| D13 | Toss 가상계좌 환불 — 환불 계좌 필요 | (provider) | `refundReceiveAccount` 필수 입력 → Widget 이 수집 | providers.toss · cs | P0 |
| D14 | 할부 결제 환불 (KR) | (provider) | 전액 취소만 지원하는 PG 존재 → 부분 환불 불가 시 `deny_partial` | providers | P1 |
| D15 | 환불 중 소비 시도 (회수 전) | (구현 규칙) | 환불 시작 시 `hold` 행으로 잔액 선차감. 실패 시 hold 해제 | refund · credits | P0 |

## E. 결제 실패 · 복구 (CS 수익의 본체)

| ID | 케이스 | 정책 키 | 처리 | 모듈 | P |
|---|---|---|---|---|---|
| E1 | 결제 성공 · 재화 미지급 (webhook 유실) | `policy.cs.regrant.mode` | **`auto`** / `manual_approve` / `off`. 원장 대조: provider 결제 목록 vs `grants` — 매칭 안 되는 결제 = 케이스 | cs | P0 |
| E2 | 이중 지급 (webhook 재전송·수동 재지급 중복) | (B12) | 멱등키 UNIQUE. CS regrant 도 같은 키 사용 | cs · credits | P0 |
| E3 | webhook 순서 뒤바뀜 (`invoice.paid` 가 `subscription.created` 보다 먼저) | (구현 규칙) | 이벤트를 `webhook_events` 에 먼저 저장 → 핸들러는 provider 에서 현재 상태 re-fetch 해 처리 (이벤트 페이로드 신뢰 X) | webhook | P0 |
| E4 | webhook 서명 실패 | (구현 규칙) | 400 반환·저장 안 함·알림. 재전송 유도 | webhook | P0 |
| E5 | webhook 핸들러 타임아웃 → provider 재전송 폭주 | (구현 규칙) | 수신 즉시 저장 + 200 반환, 처리는 비동기 (outbox/worker). 처리 실패는 `webhook_events.status = failed` | webhook | P0 |
| E6 | 이중 결제 (버튼 두 번 클릭) | (구현 규칙) | checkout 생성 시 `idempotency_key = (customer, plan, minute)`; 중복 결제 감지 시 자동 환불 케이스 | providers · cs | P0 |
| E7 | 3DS / SCA 인증 보류 → 나중에 확정 | (provider) | `requires_action` 상태 저장. 확정 webhook 까지 지급 보류 | providers · lifecycle | P0 |
| E8 | Toss 가상계좌 — 입금 대기 / 기한 만료 | (provider) | `WAITING_FOR_DEPOSIT` 는 미지급. `DONE` webhook 에 지급. 만료 시 주문 취소 | providers.toss | P0 |
| E9 | Portone — 뒤에 여러 PG, PG 별 실패 코드 | (provider) | 실패 코드를 `PaymentFailure{code, retryable, user_message}` 로 정규화 | providers.portone | P0 |
| E10 | 통화 불일치 (플랜 USD, 고객 KRW 결제) | (구현 규칙) | 플랜은 통화별 가격 테이블. 불일치 시 checkout 거절 | core | P0 |
| E11 | 카드 만료 예정 → 갱신 전 알림 | `policy.dunning.pre_expiry_notice_days` | **7** / 0 | dunning · notify | P1 |
| E12 | provider 장애 중 결제 시도 | (구현 규칙) | `PaymentFailure{retryable: true}` → 사용자에게 재시도 안내. 원장 변화 없음 | providers | P0 |
| E13 | 결제 성공 webhook 도착 전 사용자가 페이지 이탈 (success URL 미도달) | (구현 규칙) | success URL 은 UX 용. 지급은 webhook 만. 프론트는 polling `GET /grants?checkout_id` | webhook | P0 |
| E14 | 재지급 후 원래 webhook 이 뒤늦게 도착 | (B12) | 같은 멱등키 → no-op | cs | P0 |
| E15 | 동일 고객 여러 provider 에서 결제 (Stripe + Toss) | (구현 규칙) | `customers.provider_refs[]`. 풀은 하나, grant 마다 `provider` 태그 | core | P1 |
| E16 | 네이티브 구독(Stripe/Polar) 갱신 인보이스가 webhook 으로 먼저 도착 (로컬 결제 행 없음) | (구현 규칙) | 로컬 구독이 있으면 provider 에서 결제를 재조회(E3) → 그 구독의 결제일 때만 결제 행 기록 → 갱신 지급. 다른 구독 결제·모르는 구독은 `unknown_provider_ref`. 같은 인보이스 재전송은 행 1개 (`payments (provider, provider_ref)` unique) | webhook | P0 |

## F. Provider 별 특이점

| Provider | 케이스 | 처리 | P |
|---|---|---|---|
| Stripe | `proration_behavior` 가 A1 을 대부분 처리하지만 재화 차액은 우리가 계산 | `create_prorations` + 우리 grant | P0 |
| Stripe | `billing_cycle_anchor` 리셋 = `now` | A1 `reset_anchor` 매핑 | P0 |
| Stripe | `invoice.paid` vs `payment_intent.succeeded` 중 지급 트리거 | **`invoice.paid`** (구독) / `checkout.session.completed` + `payment_intent.succeeded` (일회성) | P0 |
| Stripe | Meters (Billing Meter Events) 로 usage 보고 | C4 outbox | P0 |
| Stripe | Stripe Tax 사용 시 환불 세금 자동 | D11 위임 | P1 |
| Polar | 자체 Benefits(크레딧·라이선스키) 가 있음 — 우리 원장과 이중 관리 위험 | **우리 원장이 원본**, Polar benefits 는 사용 안 함 (문서화) | P0 |
| Polar | `order.paid` · `subscription.active/updated/canceled` webhook | 매핑 표 | P0 |
| Polar | Merchant of Record → 세금·환불 세금 Polar 처리 | D11 위임 | P1 |
| Toss | 네이티브 구독 없음 → 빌링키 + **우리 스케줄러** 가 매월 결제 요청 | `subscription-scheduler` 모듈 (Toss·Portone 전용) | P0 |
| Toss | 가상계좌 · 계좌이체 · 간편결제 — 상태 머신 다름 | E8 · `paymentKey` 기준 상태 정규화 | P0 |
| Toss | 취소 = `POST /payments/{key}/cancel` + `cancelAmount` (부분 취소 가능) | D4 | P0 |
| Toss | 결제 승인(`confirm`) 은 **서버가 호출**해야 완료 — 프론트 성공 콜백만으로 지급 금지 | E13 강화 | P0 |
| Toss | webhook 은 `PAYMENT_STATUS_CHANGED` 등 이벤트 유형 소수. 서명 없음 → **IP 화이트리스트 + 재조회** | E4 변형 | P0 |
| Portone | V2 API. 빌링키 + `schedule` API 로 예약 결제 (Toss 와 달리 provider 측 스케줄 가능) | 스케줄러 선택: **`provider`** / `self` | P0 |
| Portone | PG 별 부분취소·할부·현금영수증 차이 | E9 · D14 정규화 | P0 |
| Portone | webhook V2 서명 (`webhook-signature`) 검증 | E4 | P0 |

## G. 시간

| ID | 케이스 | 정책 키 | 처리 | P |
|---|---|---|---|
| G1 | 월말 기준일 (1/31 → 2/28 → 3/31?) | `policy.period.month_end_anchor` | **`clamp_keep_original_day`** (원래 일자 기억, 짧은 달은 말일) / `clamp_permanently` | P0 |
| G2 | 일할 계산 분모 | `policy.proration.denominator` | **`actual_days_in_period`** / `fixed_30` | P0 |
| G3 | DST · 타임존 경계 | (C3) UTC 저장, 표시만 로컬 | P0 |
| G4 | 시계 주입 | (구현 규칙) `Clock` 인터페이스 DI. 테스트·재현용 | P0 |
| G5 | 윤년 연간 플랜 | (G2) 실제 일수 | P1 |

## H. 데이터 · 감사

| ID | 케이스 | 처리 | P |
|---|---|---|---|
| H1 | 고객 병합 (같은 사람, 계정 둘) | 원장은 이동 불가. `customer_links` 로 소프트 병합, 풀 합산 조회 | P2 |
| H2 | 삭제 요청 (GDPR·개인정보법) vs 원장 보존 (세법 5년) | PII 는 `customers` 에서 익명화, 원장은 보존 | P1 |
| H3 | 원장 불변성 | UPDATE/DELETE 트리거로 거절. 정정은 역분개 행 | P0 |
| H4 | 정합성 검사 | 일 1회 `sum(ledger) == balances` · provider 결제 목록 vs grants 대조 → 불일치는 CS 케이스 | P0 |
| H5 | 데이터 내보내기 (GDPR·개인정보보호법 이동권, H2 보강) | `cs.exportCustomer` — 고객·구독·결제·원장 전체·이용량·환불·CS 케이스·타임라인(`cs.timeline` 재사용)을 `schemaVersion`·`generatedAt` 붙은 JSON 하나로. 순수 읽기(`Repo`/`LedgerStore` 인터페이스만 사용 — InMemory·Postgres 동일 동작), 삭제는 하지 않는다. 기본적으로 `redact()`(카드번호·주민번호·API 시크릿 마스킹) 적용, `redact:false` 는 본인확인된 정보이동권(SAR) 요청에 한해서만 사용. H2(삭제 vs 전자상거래법 5년 보존)와의 관계: 내보내기는 항상 안전하고, 삭제는 별개의 더 어려운 결정 — 원장 행은 이 함수로 지워지지 않는다 | P1 |

## I. CS 자동화

| ID | 케이스 | 정책 키 | 처리 | P |
|---|---|---|---|
| I1 | 자동 승인 한도 | `policy.cs.auto_approve.max_amount_minor` · `max_credits` | 한도 이하 자동, 초과 사람 | P0 |
| I2 | 환불 속도 이상 (fraud) | `policy.cs.fraud.refund_velocity` | 30일 내 N건 초과 시 자동 거절 → 사람 | P0 |
| I3 | 규칙 밖 → 에스컬레이션 | (구현 규칙) | `cs_cases.status = needs_human`, 알림(Slack/Email) | P0 |
| I4 | 이탈 사유 수집 | (구현 규칙) | 취소·환불 시 `churn_reason` enum + 자유 텍스트. **항상 수집** | P0 |
| I5 | 케이스 보고 단위 | (구현 규칙) | `cs_cases` 1행 = 1건. 상태 `resolved_auto` · `resolved_human` · `rejected` 전이 시 1회 보고 (선택, `docs/CS_SERVER.md`) | P0 |
| I6 | 위젯이 고객 신원 확인 | (구현 규칙) | 앱이 서명한 `customer_token`(JWT) 으로만 케이스 열기 | P0 |
| I7 | 동일 케이스 중복 오픈 | (구현 규칙) | `(customer_id, kind, reference_id)` UNIQUE while open | P0 |
| I8 | 케이스 처리 중 정책 변경 | (구현 규칙) | 케이스에 `policy_snapshot` 저장. 오픈 당시 정책으로 판정 | P0 |
| I9 | "이 결제/이 고객에 무슨 일이 있었나" 증거 트레일 | (구현 규칙) | `cs.timeline` — `payments`·`ledger_entries`·`webhook_events`·`refunds`·`cs_cases`·`operations`(+`notifications` duck-type) 를 하나의 시간순 이벤트로 재구성. 순수 읽기, 새 저장소 없음, 감사로그(L) 비의존. **(2026-09-09 갭 해소)** `WebhookEventRecord` 에 `customerId`/`paymentId`/`subscriptionId`(webhook.receive/process 가 provider+providerRef 로 로컬 조회해 채움, EC:E3 준수) · `Operation` 에 `attempts`(runIdempotent 매 replay/재시도마다 증가) 추가 — 스코프 질의 가능. `CsCase.escalatedAt` 도 추가(optional, packages/cs 가 채움) | P0 |

## J. 연산 멱등성

같은 공개 mutating 연산이 네트워크 순단·워커 재시작으로 재시도될 때, 매 호출마다 새 id·시각으로
키를 만들면(예: `clock.now()` 를 이용한 idempotency key) 재시도가 새 연산으로 인식되어 이중 지급·
이중 환불을 낸다. 원장 append 는 이미 `idempotency_key` UNIQUE 로 멱등이지만(B12), **연산 자체**가
멱등이려면 "이 연산을 이 키로 이미 실행했는지" 를 원장 append 이전에 판정해야 한다.
`packages/core` 의 `Repo.operations` 테이블 + `runIdempotent`/`run_idempotent` 헬퍼가 이 계층을
제공한다.

| ID | 케이스 | 정책 키 | 선택지 (기본값 **굵게**) | 모듈 | P |
|---|---|---|---|---|---|
| J1 | 같은 연산이 부분 실패 후 재시도됨 | (구현 규칙) | 재실행하지 않고 **첫 실행 결과를 그대로 반환** (`replayed: true`). `Operation.status='done'` + `payload_hash` 일치 시 저장된 `result` 를 역직렬화해 반환 | core | P0 |
| J2 | 같은 키, 다른 payload | (구현 규칙) | **거절** — `PaymentKitError('idempotency_key_reused')`. payload 는 sha256(stable-JSON) 로 비교 | core | P0 |
| J3 | 동일 연산의 동시 중복 호출 (in-flight) | (구현 규칙) | 먼저 들어온 호출이 `Operation.status='in_progress'` 를 기록한 상태에서 두 번째 호출이 오면 **`PaymentKitError('idempotency_in_progress')`** 를 던진다 (대기 없이 즉시 거절 — at-least-once 재시도 큐가 재시도하도록 유도) | core | P0 |
| J4 | 연산 레코드 보존 기간 | `policy.retention.operationDays` | **7 — 2026-09-09부터 실제 강제됨.** `schema-postgres.pruneRetention({pool\|dsn, policy, clock, dryRun?})` 이 `operations` 중 `status in ('done','failed')` 이고 `created_at < now - operationDays` 인 행만 1000행 단위 배치로 삭제(루프, 카운트 반환). **`status='in_progress'` 는 나이와 무관하게 절대 삭제하지 않는다.** `dryRun: true` 면 삭제 없이 카운트만. `ledger_entries` 는 대상이 아니다 — EC:H2/H3(전자상거래법 5년 보존)로 무기한 보존. `operations` 를 보존기간 밖으로 지우면 아주 오래된 재시도의 중복 replay 방지(J1-J3)가 그 시점부터 무력화되므로, 기본값을 1일이 아닌 7일로 잡아 여유를 둔다. 실행은 크론/배치 오너 책임(자동 스케줄 없음) | schema-postgres | P1 |
| J5 | 어느 연산이 키를 쓰는가 + 기본 키 유도 규칙 | (구현 규칙) | 호출자가 `idempotencyKey` 를 안 주면 **입력값에서 결정적으로 유도**(시각·랜덤 금지): `lifecycle.upgrade` → `upgrade:{sub.id}:{newPlan.id}:{sub.currentPeriod.start ISO}` / `lifecycle.downgrade` → `downgrade:{sub.id}:{newPlan.id}:{sub.currentPeriod.start ISO}` / `lifecycle.cancel` → `cancel:{sub.id}:{sub.currentPeriod.start ISO}` / `lifecycle.convertTrial` → `convert-trial:{sub.id}:{plan.id}` / `refund.execute` → `refund:{decision.paymentId}:{decision.amount.amountMinor}:{decision.ruleId}` / `credits.topup` → `topup:{payment.id}` (기존 원장 키와 동일) / `cs.regrant` → `plan.idempotencyKey ?? case.referenceId` (기존 동작 유지) / `cs.refundAssist` → `refund-assist:{case.id}:{payment.id}`. **`clock.now()`·`ids.newId()` 로 키를 유도하지 않는다** — 재시도마다 값이 달라져 J1 이 깨진다 | lifecycle · refund · credits · cs | P0 |

---

## K. 한국 세무 (현금영수증)

한국 B2C 결제의 법정 의무. K1(구독 행 낙관적 잠금)은 별도로 다뤄진다 — 이 섹션은 현금영수증
(cash receipt) 발행·취소만 다룬다. `policy.cashReceipt` 는 `packages/core` 에 이미 정의되어
있다(`mode`/`defaultType`/`cancelOnRefund`, `packages/core/ts/src/policy.ts` ·
`packages/core/schema/policy.schema.json`) — 이 섹션은 그 계약을 채우는 provider/refund 구현
케이스다.

| ID | 케이스 | 정책 키 | 선택지 (기본값 **굵게**) | 모듈 | P |
|---|---|---|---|---|---|
| K2 | 현금영수증 발행 시점 | `policy.cash_receipt.mode` | **`off`** (미발행) / `manual` (CS·앱이 나중에 발행 요청) / `auto` (결제 성공 시 자동 발행 — 트리거는 `webhook.default_handlers` 의 `payment.succeeded` 경로) | providers.toss · providers.portone · webhook | P0 |
| K3 | 현금영수증 종류 — 소득공제(개인) vs 지출증빙(사업자) | `policy.cash_receipt.default_type` | **`personal`**(소득공제, 식별번호=휴대폰번호 등 개인 식별값) / `business`(지출증빙, 사업자등록번호) — Toss `type` 필드는 `소득공제`/`지출증빙` 문자열, PortOne V2 는 `CashReceiptType` enum `PERSONAL`/`CORPORATE` 로 각각 매핑 | providers.toss · providers.portone | P0 |
| K4 | **카드 결제는 현금영수증 발행 대상이 아니다** — 현금성 결제수단(계좌이체·가상계좌·휴대폰 등)만 해당, 카드는 매출전표가 그 역할을 대신함 | (구현 규칙) | provider adapter 가 결제수단이 카드(Toss `method` 필드에 `카드` 포함)면 `issueCashReceipt` 가 실제 발행 호출 전에 `PaymentKitError('cash_receipt_unsupported_for_payment_method')` 로 즉시 거절한다. **실측(2026-09-09, Toss 실서비스 test API)**: Toss 의 `POST /v1/cash-receipts` 는 결제-현금영수증을 연결하는 "수동 발급" 엔드포인트라 카드 결제 여부 자체를 서버가 검증하지 않는다(임의 orderId 로도 200 발급됨을 실측 확인) — 이 규칙은 **provider·서버가 아니라 우리 어댑터가 직접** 강제해야 한다 | providers.toss · providers.portone | P0 |
| K5 | 환불 시 현금영수증 처리 — 전액 vs 부분 환불 | `policy.cash_receipt.cancel_on_refund` | **`true`** (환불 성공 후 현금영수증도 취소 — 부분 환불이면 부분 취소 금액만, Toss `POST /v1/cash-receipts/{receiptKey}/cancel`, PortOne `POST /payments/{paymentId}/cash-receipt/cancel`) / `false` (현금영수증은 그대로 둠, 소득공제 유지) | refund | P0 |
| K6 | 현금영수증 발행/취소 실패 — 결제·환불 자체는 이미 성공한 상태 | (구현 규칙) | **현금영수증 발행·취소 실패가 결제·환불의 성공을 롤백하지 않는다.** `refund.execute` 는 환불이 성공한 뒤 현금영수증 취소를 시도하고, 실패해도 `Refund.status`는 그대로 `succeeded` — `cs.openRefundFailedCase`(또는 주입된 `onCashReceiptError`)로 실패를 기록·에스컬레이션(`needs: 'cash_receipt_cancel_failed'`)만 한다. 발행 실패(결제 성공 시점)도 동일 원칙이나 그 트리거는 `webhook.default_handlers` 소관 | providers.toss · providers.portone · refund | P0 |
| K7 | 중복 발행/취소 가드 — webhook 재전송·재시도로 같은 결제에 두 번 요청 | (구현 규칙) | provider API 자체는 재요청을 막지 않는다(**실측 확인**: 같은 `orderId` 로 두 번 발행 요청하면 서로 다른 `receiptKey` 로 두 번 발행됨) — 호출자가 발행된 `receiptKey` 를 멱등하게 기록(예: `Payment.raw.cashReceipt`)하고 재요청 전에 존재 여부를 확인해야 한다. 환불 쪽 취소는 `refund.execute` 전체가 이미 `runIdempotent`(J1-J5) 로 감싸여 있어 재시도가 자연히 중복 취소를 만들지 않는다 | providers.toss · providers.portone · refund | P0 |

---

## L. 관측 · 감사 로그

배경(2026-09-09 결정): 실제 provider(Toss/Portone/Stripe/Polar) 왕복 검증은 이 문서
범위에서 잠정 보류하고, 대신 **고객 앱의 프로덕션에서 결제가 도는 동안 증거가 남게 하는 것**을
우선한다 — 무슨 일이 있었는지 재구성할 수 없으면 결제 실패에 대한 CS 자체가 성립하지 않는다. 이 섹션 전까지 kit 에는 로깅 표면이 전혀 없었고, 동시에
`customerIdentityNumber`(주민등록번호/사업자등록번호)·카드번호가 `packages/providers/{toss,portone}`·
`packages/webhook`·`apps/cli/src/commands/live.ts` 를 오간다 — 로그를 만들면서 그 값들을 같이
새는 걸 막는 게 이 섹션의 핵심.

| ID | 케이스 | 정책 키 | 선택지 (기본값 **굵게**) | 모듈 | P |
|---|---|---|---|---|---|
| L1 | Provider HTTP 왕복 기록 — 결제 실패 CS 는 "무엇을 보냈고 무엇을 받았는가" 가 출발점 | (구현 규칙) | `Logger` DI (`Deps.logger`, optional). 각 provider `request()`(toss/portone/polar)와 Stripe SDK 의 `on('response')` 훅이 호출마다 정확히 한 번 `provider.request` 이벤트를 남긴다: provider·method·path·status·durationMs·(있으면) correlationId·providerErrorCode. 바디는 redact 를 거친 뒤 기록(L2) | core · providers.* | P0 |
| L2 | PII 는 절대 로그에 남기지 않는다 | (구현 규칙) | `redact(value)` 가 `Logger` 구현체(`BaseLogger` 상속) 내부에서 강제 적용된다 — call site 가 깜빡할 수 없는 구조. 최소 민감 키 목록(정규화 비교, 대소문자·`_`/`-` 무관): `customerIdentityNumber`·`cardNumber`·`cardPassword`·`customerBirthday`·`secretKey`·`apiKey`·`apiSecret`·`accessToken`·`authorization`·`webhookSecret`·`refundReceiveAccount` → `'[redacted]'`. `billingKey` 는 **마스킹**(앞4/뒤4 유지) — CS 가 같은 빌링키로 발생한 요청들을 상관관계 지어야 하기 때문에 완전히 지우면 그 조사 자체가 안 된다. 카드 PAN(13-19자리 숫자)은 키 이름과 무관하게 모든 문자열 값에서 탐지해 앞6/뒤4만 남기고 마스킹. `NoopLogger`(기본값)는 애초에 아무것도 emit 하지 않는다 | core | P0 |
| L3 | webhook 원본 바디는 **의도적으로** 그대로 저장한다 — L2 와 정면으로 긴장 관계 | (구현 규칙) | `WebhookEventRecord.rawBody` (schema-postgres `webhook_events.raw_body`) 는 redact 하지 않는다. 서명 재검증(HMAC 등)은 provider 가 서명한 **정확한 바이트**가 있어야만 되고, redact 로 값을 치환한 순간 그 바이트 재현이 불가능해져 재검증·재처리(`webhook.process` 재시도)가 깨진다. 경계는 명확히 긋는다: **원본 바디는 여기(webhook 수신 저장)에서만** 그대로 두고, 그 바디에서 파생되어 로그로 나가는 모든 값(L1 의 `provider.request` 이벤트, 앞으로 추가될 `webhook.received` 이벤트 등)은 L2 를 그대로 적용한다. `rawBody` 자체를 CS 워크플로우 밖으로(예: Slack 알림) 복사해 내보내는 코드는 만들지 않는다 | schema-postgres · webhook | P0 |
| L4 | 감사 로그 보존 · 로테이션 | `policy.retention.auditLogDays` | **90 — 2026-09-09부터 실제 강제됨.** 같은 `pruneRetention()` 이 `audit_log` 중 `at < now - auditLogDays` 인 행을 1000행 단위 배치로 삭제(EC:J4 와 동일한 배치 루프). 파티셔닝은 여전히 v1 과제(인덱스만 있음) | schema-postgres | P1 |
| L5 | correlationId 전파 — webhook 수신부터 원장 append 까지 하나의 id 로 꿸 수 있어야 재구성이 된다 | (구현 규칙) | **2026-09-09부터 대부분 구현됨.** `webhook.receive` 가 `corr_{providerEventId}` 를 결정적으로 mint 해 `WebhookEventRecord.correlationId` 에 저장(재전송은 같은 id). `webhook.process` 가 이를 읽어 `HandlerCtx.correlationId` 로 넘기고, `defaultHandlers` 가 lifecycle/credits/refund/cs 에 넘기는 `ledger` 를 correlationId-주입 데코레이터로 감싸 — **`PaymentProvider` 인터페이스도 lifecycle/credits/refund/cs 호출부도 건드리지 않고** — 그 안에서 일어나는 모든 `ledger.append`/`consume` 이 자동으로 `LedgerReference.correlationId` 를 갖는다. provider 호출 쪽은 각 provider(`stripe`·`polar`·`toss`·`portone`)가 duck-typed `withCorrelationId(id)`(py: `with_correlation_id`)를 추가로 구현 — `provider.request()` 내부 로깅이 이 값을 idempotencyKey 대신 사용한다(포트원은 원래 idempotencyKey 자체가 없어 이 값이 유일한 소스). `webhook.receive`/`process`/`processPending` 에 선택적 `logger` 를 추가해 `webhook.received`/`processing`/`processed`/`failed` 이벤트도 같은 id 로 남긴다. **2026-09-09 갱신 — lifecycle 쪽 갭 해소:** `lifecycle` 이 자기 내부에서 직접 만드는 `PaymentProvider` 호출(`upgrade`/`downgrade` 의 `changeSubscription`·`chargeBillingKey`, `cancel` 의 `cancelSubscription`, `reactivate` 의 `uncancelSubscription`, `scheduler.tick` 의 `chargeBillingKey`)도 이제 각 input 에 선택적 `correlationId?`(scheduler.tick 은 입력이 아니라 구독마다 `corr_sched_{sub.id}_{period.end ISO}` 를 직접 mint, 재시도 시 같은 id 재사용)를 받아 `internal.ts`/`internal.py` 의 `scopeProvider`/`scope_provider`(webhook 의 것과 동일한 duck-typed 패턴)로 provider 를 감싼다 — `PaymentProvider` 인터페이스는 이 부분에서 변경 없음. **2026-09-09 추가 갱신 — refund/credits/cs 갭도 해소:** `refund.execute`/`refund.onExternalRefund`, `credits.grantForPeriod`/`topup`/`clawback`/`consume`, `cs.regrant`/`refundAssist`/`dispute` 모두 이제 각 input 에 선택적 `correlationId?`(TS)/`correlation_id?`(py)를 받는다. 있으면 `provider.withCorrelationId(id)`(duck-typed, 없으면 원래 provider 그대로 — `refund.execute` 의 `provider.refund()`/`cancelCashReceipt()` 양쪽 모두 이 스코프된 provider 를 씀)로 provider 호출에 흘리고, 그 호출이 쓰는 모든 원장 항목의 `reference.correlationId` 에도 병합한다(`cs.refundAssist` 는 자체 원장 쓰기가 없고 `refundExecute` 호출에 그대로 threading만 함). `cs.timeline` 도 `{correlationId}` 필터를 받아 `ledger_entries` 소스만 그 값으로 좁히고 `TimelineEvent.refs.correlationId` 로 노출 — "이 배달 하나에서 무슨 일이 있었는지" 조회. **구현 갭 발견(core, 수정 안 함):** `InMemoryLedger.consume()`(`packages/core/{ts,py}/src/memory.*`, 소유 밖)가 쓰는 `reference` 를 고정 필드 화이트리스트로 재구성하면서 `meta.correlationId` 를 빠뜨린다 — `credits.consume()` 자체는 `ConsumeInput.meta.correlationId` 까지는 정확히 넘기지만(spy 더블로 검증) `InMemoryLedger.consume()` 에서 저장 직전에 유실된다. `append()` 기반 경로(grant/topup/clawback/regrant/dispute/refund) 는 영향 없음 — `append()` 는 받은 `reference` 를 그대로 저장한다. 상세: `packages/credits/spec/credits.pseudo.md` [EC:L5]. `packages/webhook/spec/webhook.pseudo.md` [EC:L5] 에 설계·테스트 근거 | webhook · lifecycle · providers.* · refund · credits · cs | P1 |

`audit_log` 테이블(schema-postgres `sql/0001_core.sql`): `id`·`at`·`level`·`event`·`customer_id`·
`payment_id`·`subscription_id`·`case_id`·`correlation_id`·`fields jsonb`(이미 redact 된 값만 들어옴).
`PostgresLogger` 가 `Logger` 를 구현해 이 테이블에 쓴다 — `Repo` 인터페이스에는 넣지 않는다(CS
타임라인이 별도로 조회하는 store 로 남긴다).

---

## M. 기존 고객 들이기 (backfill)

kit 을 붙이기 전부터 결제 중인 고객이 있으면, 그 고객의 구독과 크레딧 잔액이 kit 테이블에 없어서
다음 갱신 webhook 이 `unknown_provider_ref` 로 실패하고 잔액이 0 으로 보인다. 위저드가 이 상황을
먼저 묻고(`situation.*`, config 키), 답이 "있다" 일 때만 `paykit/backfill.{ts,py}` 를 생성한다.

| ID | 케이스 | 정책 키 | 선택지 (기본값 **굵게**) | 모듈 | P |
|---|---|---|---|---|---|
| M1 | 이미 결제 중인 고객이 있다 | `situation.existingCustomers` · `situation.providers` · `situation.has` (config) | 있음 / **없음**. 있으면 지금 결제사(기본값이 뒤 provider 질문의 기본값), 옮겨 올 것 `subscriptions` · `credits`(뒤 결제 모델·재화 질문의 기본값). 없음이면 생성물은 이 기능 이전과 바이트 단위로 같다 | cli · lifecycle `backfill` | P0 |
| M2 | 파일의 행이 kit 설정과 맞지 않는다 | (구현 규칙) | 행 단위로 거절하고 그 행은 아무것도 쓰지 않는다: 설정에 없는 plan(`unknown_plan`) · 설정에 없는 결제사(`provider_not_configured`) · 네이티브 구독 없는 결제사에 구독 id(`provider_has_no_native_subscriptions`) · 네이티브 결제사에 빌링키(`billing_key_needs_self_scheduled_provider`) · 기간 누락(`invalid_period`) · 음수/비정수 크레딧(`invalid_credits`) · 다른 로컬 고객이 가진 구독(`subscription_owned_by_other_customer`) | lifecycle `backfill` | P0 |
| M3 | 파일의 구독 상태를 믿을 수 없다 | (구현 규칙) | 네이티브 결제사(Stripe·Polar)는 `getSubscription(ref)` 로 결제사에서 상태·기간·anchor 를 가져온다. 결제사 쪽 고객이 `customer_ref`(또는 `customer_id`)와 다르면 `provider_customer_mismatch`, 끝난 구독이면 `subscription_not_live` 로 거절. 자체 스케줄(Toss·PortOne)은 결제사에 구독이 없으므로 파일의 빌링키와 이미 결제된 기간을 쓴다 | lifecycle `backfill` | P0 |
| M4 | 다시 돌려도 두 번 들어가면 안 된다 | (구현 규칙) | 고객은 providerRef 가 이미 있으면 skip, 구독은 (provider, providerRef) 또는 (고객, provider, billingKey) 로 skip, 잔액은 원장 grant 한 건(`source='manual'`, `actor='backfill'`, 멱등 키 `backfill:{customerId}:paid`)이라 재실행은 `duplicated`. 결과 표는 행마다 created / updated / skipped / error | lifecycle `backfill` | P0 |

## 위저드 질문 순서 (정책 키 → 질문)

0. 지금 상황 (M1): 이미 결제 중인 고객 → 있으면 지금 결제사 · 옮겨 올 것
1. Provider (F)
2. 결제 모델: subscription / topup / usage
3. 재화: credits / usage_quota
4. 주기 · 타임존 (C3, G1, G2)
5. 크레딧: B1 B2 B3 B4 B7 B10
6. 업그레이드: A1 A2
7. 다운그레이드: A3 A4
8. 취소: A5 A6
9. 트라이얼: A9 (있을 때만)
10. 갱신 실패: A13 A14 A15 A16 A17
11. 환불: D1 D2 D3 B13 (D7 D10 은 고급)
12. 이용량: C1 C2 C5 (usage 선택 시), C10 (예산 예약을 켠 경우)
13. 분쟁: B11 D9
14. 현금영수증(KR): K2 K3 K5 — provider 에 toss/portone 선택 시만
15. CS: E1(regrant mode) I1 I2 — CS 애드온 활성화 시
16. 인프라: 스키마 · webhook · 알림 · 로깅(L1-L5, `infra.logging`) · 언어

## 커버리지 규칙

- P0 케이스마다 `spec/*.pseudo.md` 에 같은 ID 의 섹션이 있어야 한다.
- 구현(py/ts) 은 해당 섹션 ID 를 주석으로 인용한다 (`# EC:A3`).
- 커버리지 검사 스크립트는 **구현이 존재한 뒤** 붙인다.
