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
| A26 | 자체 스케줄 갱신 결제(Toss, PortOne scheduler=self)가 로컬 결제 행으로 남지 않음 (Toss 는 빌링 결제에 webhook 을 보내지 않음) | (구현 규칙) | `scheduler.tick` 이 성공한 청구를 결제 행(kind `subscription`, 구독 id, 청구 기간)으로 저장한 뒤 `onRenewalPaid` 로 지급하고 지급은 그 행을 가리킨다. 같은 청구의 재시도는 `(provider, providerRef)` 행을 다시 쓴다. 실패한 청구는 행 없이 dunning 으로 | lifecycle | P0 |
| A27 | 결제사 구독이 `paused`(결제수단 없이 트라이얼 종료, 인보이스 없음) 또는 `incomplete`(첫 결제 전) | (구현 규칙) | 로컬 상태도 `paused` / `incomplete` 로 두고 권한이 없는 상태로 본다: `usage.check` 는 `subscription_inactive` 로 거절, 첫 결제 실패에 dunning·유예를 시작하지 않는다. `subscription.updated` webhook 이 결제사 상태를 다시 조회해 이 두 상태로 들어가고 나오는 전이만 반영(재개, 첫 결제 완료). 나머지 전이는 dunning·갱신·취소 처리기 몫. Postgres 는 0011 이 상태 제약을 넓힌다 | core + lifecycle + usage + webhook + providers | P0 |
| A28 | 여러 통화로 가격을 둔 플랜의 갱신·dunning 재시도·업그레이드 청구 | (구현 규칙) | 구독이 산 통화(`subscription.currency`)를 저장하고(checkout, backfill, 인앱결제, Stripe/Polar 조회값), 청구는 그 통화의 플랜 가격으로 한다. 플랜에 그 통화 가격이 없으면 다른 통화로 청구하지 않고 실패(`plan_price_missing`). 통화가 없는 옛 행은 첫 가격을 쓴다(이전 동작). 네이티브 가격 ref 도 같은 통화의 것을 고른다. Postgres 는 0012 가 열을 더한다 | core + lifecycle + cs + providers + schema-postgres | P0 |
| A29 | 예약된 플랜 변경(다운그레이드 등)이 걸린 구독의 갱신 청구 | (구현 규칙) | 갱신 청구 가격은 갱신 **후** 플랜(`scheduledPlanId ?? planId`)의 가격이다. 지급도 같은 플랜으로 한다. 자체 스케줄 갱신, dunning 재시도, 회복(onRecovered) 모두 같은 규칙. 이전 구현은 옛 플랜 가격으로 청구하고 새 플랜 크레딧을 지급했다(5만 원 청구, Basic 100 크레딧) | lifecycle | P0 |
| A30 | 자체 스케줄 tick 에서 구독 하나의 청구가 미확정(pending)이거나, 청구 성공 뒤 로컬 단계가 실패 | (구현 규칙) | 구독마다 따로 처리하고 오류는 `result.errors` 에 모은다: 한 행이 뒤의 모든 갱신을 멈추지 않는다. 청구가 성공하면 로컬 단계 전에 결제 행을 기록하고, 다음 tick 은 그 기간의 성공 결제가 있으면 다시 청구하지 않고 로컬 단계만 이어서 한다. 미확정 결제는 dunning 을 시작하지 않는다(reconcile 대상) | lifecycle | P0 |
| A31 | 갱신하려는 플랜이 삭제됐거나 구독 통화 가격이 없음 (설정 오류) | (구현 규칙) | 청구하지 않고, 구독을 dunning(past_due, 유예)에 넣고 `cs.needs_human`(`kind: plan_price_missing`)으로 사람에게 알린다. 활성 상태로 무기한 남지 않는다. dunning 재시도도 같은 상황이면 알리고 재시도 일정을 유지해, 가격을 고치면 다음 시도에서 청구된다 | lifecycle | P0 |
| A32 | 결제사에서 이미 취소·만료된 구독의 갱신 결제가 늦게 처리됨 | (구현 규칙) | 낸 기간의 크레딧은 지급하되 구독을 `active` 로 되살리지 않는다(`canceled`·`expired` 유지) | lifecycle | P0 |
| A33 | 구독 통화에 가격이 없는 플랜으로 결제사 가격 변경(업·다운그레이드) 또는 업그레이드 차액 계산 | (구현 규칙) | 통화가 있는 구독은 그 통화 가격의 ref 만 쓴다. 플랜에 그 통화 가격이 없으면 `plan_price_missing` 으로 거절하고 다른 통화 ref 로 넘어가지 않는다. 업그레이드는 옛 플랜 가격도 구독 통화로 있어야 한다(없으면 0 으로 보아 새 가격 전액을 차액으로 청구하지 않고 거절) | lifecycle | P0 |
| A34 | 자체 스케줄(Toss·PortOne) 갱신 청구: 거절 뒤 dunning 재시도가 성공하면 이미 끝난 기간의 크레딧을 주고 기간을 넘기지 않아 다음 tick 이 같은 기간을 다시 청구, 청구 뒤 결제 행 저장이 실패하면 다시 청구, 결과를 모르는 청구를 거절로 셈 | (구현 규칙) | (구독, 기간)마다 청구 시도 기록을 결제사 호출 **전에** 결제 행(`pending`)으로 남기고, 시도 키로 결제사 멱등 키와 orderId 를 정한다. 성공한 시도가 있으면 새로 청구하지 않고 그 결제로 갱신을 마친다(`onRenewalPaid`: 그 기간을 지급하고 기간을 넘김). 답이 없는 시도는 같은 키로 다시 확인한다(Toss 는 같은 Idempotency-Key 에 같은 응답, PortOne 은 `ALREADY_PAID` 면 그 결제를 돌려준다). 결제사가 4xx 로 답한 것만 거절이고(408·409·429 제외), 5xx·시간 초과·무응답은 결과 미확정이다(`ProviderError.httpStatus`). dunning 재시도도 같은 기록을 쓴다. 이전에는 거절 뒤 복구된 고객이 5,000원을 내고 쓸 수 있는 크레딧 0 을 받았고 다음 tick 에 같은 기간이 다시 청구됐다 | lifecycle + providers(toss, portone) + core | P0 |
| A35 | scheduler·dunning 이 Toss 에 `charge:<sub>:<ISO>`(72자, `:`·`.` 포함) orderId 를 보냄, 다음 달 dunning 재시도 1 이 이번 달과 같은 키 | (구현 규칙) | orderId 는 `ord_` + sha256(시도 키) 앞 40자(Toss 규칙 영문·숫자·`-`·`_` 6~64자, PortOne paymentId 에도 맞음). dunning 시도 키에 기간 시작을 넣는다(`dunning-retry:<sub>:<기간 시작>:<n>`). 시도 키 날짜 형식은 TS 와 Python 이 같다(`.000Z`) | lifecycle | P0 |
| A36 | 결과를 모르는 갱신 청구(pending, requires_action, 전송 오류)가 기간이 끝난 뒤에도 영원히 active 로 남고, 생성 앱의 `schedulerTick` 이 `errors` 를 버림 | `policy.dunning.grace_days` | 기간 끝에 답이 없으면 구독을 유예(past_due, `graceUntil`)로 한 번 옮기고 담당자 알림(`cs.needs_human`, `renewal_charge_unresolved`)을 한 번 보낸다. tick 마다 같은 시도를 다시 확인하고, 답이 오면 갱신을 마치거나 dunning 을 이어 간다. 유예가 끝나면 기존 `dunningSweep` 이 만료시킨다. 생성 코드의 `schedulerTick` 은 `errors` 를 돌려주고 로거에 남기며, 기한이 된 dunning 재시도도 돌린다(이전에는 생성 앱에서 재시도가 실행되지 않았다) | lifecycle + cli | P0 |
| A37 | 워커 둘(스케줄러 tick 둘, tick 과 dunning 재시도, 웹훅)이 같은 청구 시도를 동시에 처리해 결제사를 두 번 부르고, 늦게 쓴 쪽이 succeeded 행을 pending 으로 덮음 | — | 시도마다 `operations` 행으로 리스(lease)를 원자적으로 잡는다. 리스를 가진 쪽만 시도 행을 읽고, 만들고, 결제사를 부르고, 결과를 쓴다. 못 잡은 쪽은 아무것도 하지 않고(`in_flight`) 다음 tick 에 다시 본다. 리스는 10분 뒤 만료되어 도중에 죽은 워커의 시도도 이어 간다 | lifecycle | P0 |
| A38 | 결과를 모르던 갱신 청구가 유예 만료(expired)·취소 뒤에 성공하면 돈만 빠지고 지급·행 갱신·재확인이 없음 | — | 끝난 구독의 pending 시도는 tick 마다 결제사에 주문번호로 조회한다(`getPaymentByOrderId`, 청구하지 않음). 성공이면 행을 기록하고 그 기간 크레딧을 지급하며(구독은 끝난 상태 그대로, A32) 담당자에게 한 번 알린다(`renewal_settled_after_end`). 결제사가 모르는 주문이면 실패로 닫아 나중에 누구도 청구하지 않는다. 답이 없으면 tick `errors` 에 `renewal_charge_unresolved` 로 남긴다 갱신 중인 구독이라도 이미 들어섰거나 지난 기간의 pending 시도(이전 빌드가 남긴 것)는 스케줄러가 다시 보지 않으므로 같은 조회로 정산한다(round-5 A5-8) | lifecycle + toss/portone | P0 |
| A39 | 이전 릴리스(A34 이전)의 dunning 청구는 결제 행이 없어, 업그레이드 후 같은 기간을 한 번 더 청구함 | — | 새 청구를 시작하기 전에, 현재 기간이 끝난 뒤 보낸 dunning 재시도 항목(`dunning-retry-item:<sub>:<n>`, sent)마다 옛 주문번호(`dunning-retry:<sub>:<n>`)를 결제사에 조회한다. 성공이 있으면 그 결제를 이번 기간의 시도 행으로 기록하고 갱신을 마친다(재청구 없음). 조회가 안 되면 청구하지 않고 `legacy_dunning_unverified` 오류를 tick 마다 남긴다. 옛 청구의 키는 다시 보내지 않는다(결제사는 같은 키를 정해진 기간만 재생하므로, 나중에 다시 보내면 새로 청구될 수 있다). 결제사가 모르는 주문이면 닫고 정상 청구로 넘어간다 이 조회는 스케줄러(active)뿐 아니라 dunning 재시도(past_due, 새 키로 청구하기 전)와 끝난 구독(expired·canceled: tick 이 조회해 결제됐으면 행을 기록하고 그 기간을 지급, 구독은 끝난 상태 그대로, 담당자에게 한 번 알림)에도 적용한다(round-5 A5-3). 이번 릴리스가 그 재시도로 직접 청구한 행이 있으면 레거시로 보지 않는다. 끝난 구독의 레거시 정산 알림은 그 기간을 처음 지급할 때 한 번만 보낸다(이미 지급된 기간을 다시 찾아도 알리지 않음, round-6 A6-5) | lifecycle | P0 |
| A40 | 연체(past_due) 중 기간 끝 취소를 해도 dunning 이 다음 기간을 청구함 | — | 연체 중 `cancelAtPeriodEnd` 가 켜지면 dunning 재시도는 청구하지 않고 구독을 canceled 로 끝낸다. 스케줄러도 연체 구독의 기간 끝 취소를 마무리한다(오너 결정 2026-09-27: 취소한 고객에게 더 청구하지 않는다) | lifecycle | P0 |
| A41 | 결과를 모르던 스케줄러 청구가 나중에 거절로 확정돼도 스마트 재시도가 예약되지 않음 | `policy.dunning.retry_attempts` | 스케줄러 자신의 시도가 거절로 처음 확정되는 tick 에서 dunning 을 한 번 시작한다(유예 재시작, 재시도 1 예약) | lifecycle | P1 |
| A42 | TS 와 Python 이 dunning outbox payload 키를 다르게 써서(subscriptionId / subscription_id) 공유 DB 에서 다른 쪽 kit 의 항목을 읽다 멈춤 | — | 두 kit 모두 `{subscriptionId, attempt, dueAt}` 를 쓴다. Python 은 이전 릴리스의 snake_case 항목도 읽는다 | lifecycle | P1 |
| A43 | PortOne 구독이 생성 앱에서 한 번도 갱신되지 않음(마법사 기본 `provider` 모드는 아무도 `schedulePayment` 를 부르지 않고, `self` 모드는 생성 코드가 scheduling 을 넘기지 않음) | — | PortOne 도 Toss 처럼 항상 이 kit 의 스케줄러로 갱신한다. 어댑터 기본값이 `scheduling='self'` 이고, 마법사의 스케줄러 질문은 없앴으며, 생성 코드가 `scheduling: 'self'` 를 넘긴다. `provider` 는 앱이 `schedulePayment` 와 그 웹훅을 직접 처리할 때만 명시적으로 쓴다. 로컬 목·샌드박스 호스트는 `PORTONE_API_BASE` 로 지정한다 | portone + cli | P0 |
| A44 | 생성 앱의 consume·reserve 가 `usageDuringGrace='block'` 을 무시하고, reserve 가 넘겨받은 구독의 주인을 확인하지 않음 | `policy.dunning.usage_during_grace` | 연체 중이고 정책이 block 이면 `grace_usage_blocked` 로 거절한다. reserve 는 다른 고객의 구독 id 를 `subscription_not_owned` 로 거절한다 | cli | P1 |
| A45 | PortOne 자체 스케줄 갱신 결제의 `Transaction.Paid` 웹훅이 충전 분기로 가서 매번 실패함 | — | 이벤트가 구독을 모르더라도, 로컬 결제 행이 구독 결제(kind subscription)면 그 구독의 갱신으로 처리한다(행을 succeeded 로 기록하고 `onRenewalPaid`, 멱등). 성공하지 않은 결제는 기록을 실패로 남긴다 | webhook | P1 |
| A46 | `cron.reconcile` 이 거절된 갱신 시도마다 사람 케이스를 열고 실행할 때마다 알림을 다시 보냄 | — | 거절된 결제와 스케줄러가 가진 pending 시도는 미지급 복구 대상이 아니다. 이미 담당자에게 넘긴 케이스는 다시 알리지 않고 그대로 돌려준다 | cs | P1 |
| A47 | 자체 스케줄 구독(Toss·PortOne)이 두 기간 이상 밀림 (cron 이 여러 달 멈춤, A43 이전 생성 PortOne 앱 업그레이드) — tick 마다 한 기간씩 소급 청구하면 쓸 수 없는(이미 만료된) 크레딧을 판다 | `policy.subscription.missed_periods` | **`skip_and_notify`** (지금 시각을 포함한 기간만 1회 청구, 밀린 기간은 청구·지급 없이 건너뛰고 `cs.needs_human`(`missed_periods_skipped`) 한 번에 목록을 남김) / `needs_human_only` (청구하지 않고 past_due·유예 시계 없음으로 두고 `missed_periods_parked` 한 번). 스케줄러와 dunning 재시도 모두 적용. 첫 밀린 기간에 열린 시도(쓰였지만 보냈는지 모름)가 있으면 먼저 조회한다: 결제사에 주문이 없으면 그 행을 `order_not_found` 로 닫고 건너뛰기를 적용한다(보낸 적 없는 끝난 기간을 새로 청구하지 않음, round-6 A6-4). dunning 은 시도가 모두 거절됐을 때도 적용한다. 업그레이드 전 점검: `boilpayment check` 가 밀린 구독을 읽기 전용으로 나열 | lifecycle + cli | P0 |
| A48 | 청구 시도 리스를 풀거나 넘겨받을 때 조건 없이 써서 두 워커가 같은 시도의 리스를 동시에 가짐 (같은 키라 이중 청구는 없지만 두 번째가 409 로 past_due 오탐) | (구현 규칙) | 리스 행에 소유 토큰을 두고, 만료 리스 해제·재선점·반납을 모두 compare-and-set(`operations.compareAndSet`: 읽은 status·result 그대로일 때만 씀)으로 한다. 넘겨받은 뒤 늦게 끝난 이전 보유자는 새 보유자의 리스를 풀지 못한다. 리스와 토큰은 선점(`operations.claim`)과 같은 문장에서 쓴다: 선점된 행이 `{in_progress, null}` 로 보이는 순간이 없어, 늦게 온 워커의 `unleasedSince` 기록이 새 선점 위에 얹혀 10분 멈추는 일이 없다(round-6 I-1). 롤링 배포는 이전 워커를 모두 내린 뒤 새 워커를 띄운다(이전 워커는 이 규칙을 모름). compareAndSet 이 없는 Repo 는 이전처럼 put(반납은 토큰이 같을 때만) | lifecycle + schema-postgres | P1 |
| A49 | 돈이 빠졌지만 답을 못 받은 시도를 결제사 멱등 창(Toss 15일)이 지난 뒤 다시 보내면 `DUPLICATED_ORDER_ID`(400)가 거절로 분류돼 dunning 이 같은 기간을 다시 청구 | (구현 규칙) | pending 시도를 다시 구동할 때는 항상 먼저 주문번호로 결제사에 조회한다: 결제됨이면 그걸로 정산, 거절이면 거절, 결제사가 모르면(보낸 적 없음) 같은 키로 보냄, 조회 실패면 보내지 않고 unresolved. 중복 주문 응답(`DUPLICATED_ORDER_ID`, `ALREADY_PROCESSED_PAYMENT`, `ALREADY_PAID`)은 거절이 아니라 조회로 정산한다. 조회를 못 하는 결제사는 14일이 지난 pending 시도를 다시 보내지 않는다 | lifecycle | P0 |
| A50 | 조회로 찾은 결제가 요청한 청구와 다름(금액·통화·고객이 다르거나, 부분·전액 환불·분쟁 상태) — 그대로 지급하거나, 환불된 걸 미결제로 보고 다시 청구함 | (구현 규칙) | 조회 결과가 시도 행과 금액(그 키로 보낸 금액 = 행의 금액, 지금의 플랜 가격이 아님: 가격 변경·예약 다운그레이드 뒤에도 정산된다, round-6 A6-3)·통화·고객이 모두 같고 환불·분쟁 상태가 아닐 때만 정산한다. 다시 보낼 때도 행의 금액을 보낸다. 레거시 행(이전 릴리스의 청구, 보낸 금액을 모름)은 통화·고객이 같으면 결제사 금액으로 정산하고, 그 금액이 지금 가격과 다르면 `legacy_settled_at_provider_amount` 를 알린다. 다르면 행을 검토 대기(`raw.boilpaymentReview`)로 두고 `attempt_lookup_mismatch` 를 한 번 알린다. 검토 대기 행은 kit 이 청구·재구동·지급하지 않으며(PortOne `Transaction.Paid` 웹훅(A45)도 같은 규칙: 검토 대기면 지급하지 않고, 금액이 다르면 보류로 둔다, A6-6), 그 기간은 사람이 정리(A53)할 때까지 청구되지 않는다 | lifecycle · webhook | P0 |
| A51 | PortOne 갱신 청구 답이 유실된 뒤 `Transaction.Paid` 웹훅이 tick 보다 먼저 오면, 결제사 사본의 period 가 없어(PortOne) 이미 끝난 현재 기간이 다시 지급됨 (체험 전환 구독은 결제 1건에 두 기간) | (구현 규칙) | A45 경로는 저장된 시도 행의 period 로 `onRenewalPaid` 를 부른다(결제사 사본의 period 는 쓰지 않음). 행에 period 가 없으면 행만 succeeded 로 기록하고 갱신은 스케줄러의 시도 경로가 마친다 | webhook | P0 |
| A52 | 주문 조회에서 본문과 상관없이 모든 HTTP 404 를 "주문 없음"으로 봄 — 프록시·잘못된 base URL 의 404 가 돈이 빠진 시도를 failed 로 닫고 재청구로 이어짐 | (구현 규칙) | Toss 는 `NOT_FOUND_PAYMENT`, PortOne 은 `PAYMENT_NOT_FOUND` 일 때만 "주문 없음"(null)이다. 그 밖의 404 는 오류로 던져 시도가 미확인으로 남는다 | toss · portone | P0 |
| A53 | 검토 대기(A50)로 멈춘 시도를 풀 kit 경로가 없음 — 행이 pending 이라 환불도 못 하고 DB 를 직접 고쳐야 함 | (구현 규칙) | `resolveHeldAttempt({ paymentId, decision, actor })`. `settle`: 결제사 주문이 이 갱신이 맞음(결제된 주문만) → 행을 결제사 금액·참조로 succeeded 로 바꾸고 그 기간을 지급(끝난 구독은 끝난 채로, A32). `void`: 돈이 움직이지 않았거나 결제사에서 전액 환불됨 → 행을 `review_voided` 로 닫고 거절과 같이 dunning 이 이어받음(돈이 남아 있으면 거절, `close` 는 A58). 결정·결정자·시각은 행의 `raw.boilpaymentReviewResolved` 에 남는다 | lifecycle | P0 |
| A54 | `missedPeriods: 'needs_human_only'` 로 멈춘 구독을 풀 kit 경로가 없음 — `reactivate` 는 거절되고, active 로 바꾸면 다음 tick 이 다시 멈춤 | (구현 규칙) | `resumeParked({ subscriptionId, actor })`: 밀린 기간은 청구·지급하지 않은 채 두고, 지금 기간 바로 앞 기간으로 옮겨 active 로 되돌린다. 다음 tick 이 지금 기간을 한 번 청구한다(보통 갱신). 끝내려면 취소한다 | lifecycle | P0 |
| A55 | 이전 릴리스(A34 이전)의 dunning 재시도가 한 구독에 둘 이상 돈을 뺀 경우 — 첫 키가 정산되면 나머지 키는 끝내 조회되지 않음(행·지급·알림 없음, round-7 A7-2) | (구현 규칙) | 레거시 키는 첫 성공에서 멈추지 않고 모두 조회한다. 첫 성공이 그 기간을 사고, 뒤에 성공으로 정산되는 키는 같은 기간의 두 번째 결제이므로 지급하지 않고 `renewal_double_charge`(cs.needs_human)를 그 키가 정산될 때 한 번 보낸다. 이미 다른 결제가 산 기간을 뒤늦게 정산한 시도 행(A38)도 같은 알림을 보낸다 | lifecycle | P0 |
| A56 | 답을 못 받은 청구로 past_due 가 된 구독(유예 진행, dunning 재시도 없음)을 한 기간 넘게 cron 이 못 돌린 뒤, 조회로 "주문 없음"을 확인해도 A47 건너뛰기가 적용되지 않음 — 청구·재시도 없이 유예 끝에 만료(round-7 A7-5) | (구현 규칙) | past_due 이고 유예가 걸려 있고(멈춤 A54 아님) 한 기간 넘게 밀렸으며 그 기간 시도가 `order_not_found` 로 닫혔으면 active 구독과 같이 A47 규칙으로 넘어가 지금 기간을 한 번 청구한다. 거절되면 dunning 이 이어받는다 | lifecycle | P0 |
| A57 | 즉시 업그레이드(Toss/PortOne)의 추가금 청구가 원시 키(`charge:upgrade:…`, `:`·`.` 포함, 46~93자)를 orderId 로 보냄 — Toss orderId 규칙(`[A-Za-z0-9_-]` 6~64자) 밖, 답을 잃은 뒤 재시도는 새로 청구될 수 있음(round-7 A7-6) | (구현 규칙) | orderId·멱등키는 갱신과 같은 `ord_` + 40 hex(A35). 업그레이드 작업이 다시 돌 때(이전 실행이 청구하고 답을 잃었을 수 있음)는 먼저 결제사에 이 orderId 와 이전 릴리스가 보낸 원시 키를 조회한다: 결제된 주문이 있으면 청구하지 않고, 대기·무응답이면 `upgrade_charge_unresolved` 로 멈추며, 모두 없거나 실패일 때만 청구한다 | lifecycle | P0 |
| A58 | 검토 대기 주문에 돈이 남아 있는데(부분 환불·결제됨·분쟁) `void` 말고 풀 길이 없고, `void` 는 다음 날 전액을 다시 청구함. 두 결정이 동시에 오면 행·구독·알림이 서로 다른 결정을 따름(round-7 A7-4 A7-7) | (구현 규칙) | `resolveHeldAttempt` 에 `close` 추가: 행을 `review_closed` 로 닫고 지급·재청구 없이 구독을 그 기간으로 넘긴다(active), 환불은 담당자가 한다. `void` 는 결정 때 결제사에 주문을 다시 물어 결제됨·부분 환불·분쟁·대기면 `held_order_moved_money` 로 거절한다. 결정은 시도 리스(A37) 안에서 행을 다시 읽고 하며, 리스를 다른 워커가 잡고 있으면 `attempt_in_flight`. 사람이 void·close 한 행은 늦게 온 결제 웹훅도 지급하지 않는다 | lifecycle · webhook | P0 |
| A59 | 자체 청구(Toss/PortOne) + `reset_anchor` 업그레이드가 옛 기간 남은 몫의 차액만 청구 — 새 기간 `[지금, 한 달 뒤)` 중 옛 기간 끝 이후(5/1–5/11)는 아무도 내지 않음(round-8 A8-3) | `policy.upgrade.mode` | 새 기간을 통째로 사므로 `새 가격 − 옛 가격 × 남은 비율`(남은 몫은 올림, 청구는 고객에게 유리하게)을 청구한다. Stripe 의 `billing_cycle_anchor=now` 가 청구하는 것과 같다. 크레딧도 같은 식으로 `새 플랜 크레딧 − 옛 플랜 크레딧 × 남은 비율`(내림)을 지급하고, 이때는 `creditDelta` 설정과 무관하다. `keep_anchor` 는 그대로 가격 차 × 남은 비율 | lifecycle | P0 |
| A60 | 갱신·업그레이드 청구가 빌링키를 발급받은 Toss customerKey 대신 로컬 고객 ID 를 보냄 — Toss 는 다른 customerKey 로 빌링키 청구를 거절(`NOT_MATCHES_CUSTOMER_KEY`, round-8 A8-8) | (구현 규칙) | 구독에 발급 customerKey 를 저장한다(`subscriptions.billing_customer_ref`, 0014). 청구는 그 값, 없으면 고객의 그 결제사 참조(`providerRefs`), 그것도 없으면 로컬 ID(이전 행, 전과 같음)를 보낸다. 백필은 CSV `customer_ref` 를, `startSubscription` 은 받은 `customerRef` 를 저장한다. 목도 발급 customerKey 와 다른 청구를 거절한다 | lifecycle · providers.toss | P0 |
| A61 | 업그레이드가 호출자가 넘긴 구독 스냅숏으로 청구·지급을 먼저 하고 버전 검사는 마지막 저장에서야 걸림 — pro·max 가 동시에 오면 둘 다 청구되고, 늦은 쪽은 돈이 빠진 뒤 실패, 재시도하면 또 청구. 취소·만료된 구독에도 청구하고 플랜을 바꿈(round-8 A8-2 A8-4) | (구현 규칙) | 업그레이드는 구독 단위 리스(`upgrade:<sub>`) 안에서 저장된 행을 다시 읽고, 청구 전에 판단한다: 버전이 다르면 `subscription_changed`(다시 읽고 재시도), 다른 업그레이드가 진행 중이면 `subscription_change_in_flight`, `active`·`trialing` 이 아니면 `subscription_inactive`(C11 과 같은 판단, past_due 포함). 이미 그 플랜이면 청구 없이 현재 행을 돌려준다. 청구 뒤 저장이 다른 쓰기와 부딪히면 최신 행에 다시 적용해 돈만 빠진 상태를 남기지 않는다. 다운그레이드도 같은 상태 검사를 한다 | lifecycle | P0 |
| A62 | 업그레이드 추가금에 로컬 결제 행이 없음 — 결제사 콘솔 환불 웹훅이 결제를 못 찾아 실패하고 크레딧·플랜이 남으며, 킷 환불(`requestRefund`)도 거절(round-8 A8-5) | (구현 규칙) | 청구 전에 행(`pay_up_<hash>`, kind `subscription`, period 없음, `raw.boilpaymentUpgrade`)을 남기고 결과로 갱신한다. 업그레이드 지급은 `reference.paymentId` 로 이 행을 가리켜, 외부 환불(D20)과 킷 환불이 그 크레딧을 몫만큼 회수한다. period 가 없으므로 어느 갱신도 사지 않는다(웹훅 A45 는 행만 succeeded 로 기록). 환불돼도 플랜은 바꾸지 않는다 | lifecycle · refund | P0 |
| A63 | 이전 릴리스에서 호출자 키로 시작한 Python 업그레이드 재시도가 `idempotency_key_reused` 로 막히고, 새 키로 다시 부르면 추가금을 한 번 더 청구(round-8 A8-6) | (구현 규칙) | 호출자 키의 저장된 작업이 있으면 그 payload 해시가 맞는 시간 표기(iso_z, 모든 UTC 오프셋의 isoformat)를 찾아 같은 작업으로 이어 간다. 추가금 청구 전에는 항상(첫 시도 포함) 이 orderId 와 이전 릴리스의 원시 키(그 표기, `+00:00`)를 결제사에 조회해, 이미 결제된 주문이 있으면 새로 청구하지 않는다 | lifecycle | P1 |
| A64 | 백필이 다른 고객의 빌링키를 그대로 받음 — 이 고객의 갱신이 그 카드로 청구(round-8 A8-13) | (구현 규칙) | 빌링키 행은 같은 결제사에서 그 빌링키를 가진 다른 고객의 구독이 있으면 `billing_key_owned_by_other_customer` 로 거절한다(같은 파일 안의 앞 행 포함) | lifecycle | P1 |
| A65 | 문서대로는 Toss·PortOne 구독을 시작할 수 없음 — `registerCompletedCheckout` 은 결제사 구독(`getSubscription`)을 요구하는데 자체 청구 결제사에는 없고, 빌링키를 구독에 저장하는 공개 API 가 없음(round-8 A8-7) | (구현 규칙) | `startSubscription({ customerId, planId, currency, billingKey, customerRef, requestId })`: 구독 행을 `incomplete` 로 먼저 쓰고(`sub_<hash(customer, requestId)>`), 첫 기간을 갱신과 같은 시도 경로(A34, 조회 먼저)로 청구한 뒤 성공하면 active 로 바꾸고 그 기간 크레딧을 지급한다. 같은 `requestId` 는 두 번 청구하지 않는다. 거절은 `subscription_start_declined`(구독은 incomplete, 스케줄러가 청구하지 않음), 모름은 `subscription_start_unresolved`(같은 requestId 로 다시 호출). 자체 청구 결제사의 구독 플랜을 체크아웃 결제로 등록하면 `use_start_subscription` | lifecycle · cs | P0 |
| A66 | 분쟁으로 동결된 고객도 크레딧을 쓰고, 밴된 고객은 구독이 살아 있어 다음 갱신에 지급받아 계속 씀(round-8 A8-9) | `policy.dispute.onLost` | 생성 코드의 `consume`·`reservations.reserve` 는 고객이 `active` 가 아니면 `customer_frozen`·`customer_banned` 로 거절한다. `revoke_and_ban` 밴은 그 고객의 살아 있는 구독을 모두 `canceled` 로 끝내고, 이벤트가 온 결제사의 네이티브 구독은 결제사에서도 취소한다(실패하거나 다른 결제사면 담당자 알림 `banned_customer_subscription`). 밴된 고객의 갱신 결제는 지급하지 않고 `customer_banned` 로 실패시켜 사람이 환불하게 한다. `startSubscription` 도 동결·밴 고객을 거절한다 | cs · lifecycle · 생성 코드 | P0 |
| A67 | 방금 승인한 Toss 결제의 등록이 `checkout_evidence_mismatch` — 등록 검증이 고객 결제 목록을 묻는데 Toss `listPayments` 가 endDate 를 초 단위로 잘라 같은 초의 결제가 빠지고, 거래 조회는 새 결제를 늦게 보여 줌(round-8 A8-7) | (구현 규칙) | Toss·PortOne 은 결제의 주문번호(orderId·paymentId)가 이 체크아웃과 같은지로 묶으므로 목록을 묻지 않는다. Toss `listPayments` 의 endDate 는 다음 초로 올린다 | cs · providers.toss | P0 |
| A68 | 생성된 프레임워크 예제(FastAPI·Django·Express·Next.js)가 틀린 호출을 담아 웹훅이 500·400 이 됨(round-8 A8-10 A8-11, round-9 A9-13 A9-15) | (구현 규칙) | 킷은 SDK 이고 프레임워크 예제를 생성하지 않는다. INTEGRATION.md §3 은 프레임워크와 무관하게 `handleWebhook(rawBody, headers, { provider?, remoteAddress? })` / `handle_webhook(raw_body, headers, provider=?, remote_address=?)` 에 넘길 값(원본 바디, 헤더, Toss 면 소켓 주소)과 `result.status` 로 응답하라는 것만 적는다 | 생성 코드 · 문서 | P0 |
| A69 | 0.1.0 Python 워커와 새 워커가 겹치면 기한이 된 구독마다 두 번 청구 — 두 릴리스의 멱등키가 다름(`+09:00` vs `.000Z`)(round-8 A8-1) | (구현 규칙) | 0.1.0 은 원시 키를 Toss orderId 로 보내는데 Toss 규칙(`[A-Za-z0-9_-]` 6~64자) 밖이라 Toss 가 청구 전에 거절한다(목도 이제 거절). 문서는 "옛 워커를 모두 내린 뒤 새 워커"를 요구하고 겹치면 이중 청구가 될 수 있다고 적는다. `boilpayment check` 는 마지막 마이그레이션 뒤에 옛 시간 형식 키로 지급된 갱신이 있으면 옛 워커가 돈다고 알린다 | lifecycle · CLI | P1 |
| A70 | Python 크레딧 만료 알림의 중복 방지 id 시간 형식이 바뀌어(isoformat → iso_z) 업그레이드 당일 같은 알림이 한 번 더 감(round-8 A8-12) | (구현 규칙) | 오늘 id 를 iso_z 와 이전 두 형식(세션 시간대 isoformat, UTC isoformat)으로 모두 조회해 하나라도 있으면 보내지 않는다 | credits | P2 |
| A71 | 정책 시간대가 Asia/Seoul 이면 `startSubscription` 과 reset_anchor 업그레이드의 첫 기간이 약 두 달 — 기준일을 UTC 날짜로 잡아 KST 1일 시작이 전달 말일 기준일이 됨(round-9 A9-4) | `policy.period.timezone` | 기준일은 시작 시각의 정책 시간대 날짜(`civilDayOf`/`civil_day_of`)다. KST 5/1 05:00 시작은 KST 6/1 05:00 에 끝나고, KST 1/31 시작은 2/28 로 clamp 된다 | lifecycle · core | P0 |
| A72 | `startSubscription` 이 `multiplePerCustomer=deny` 를 무시해 requestId 가 다르면 활성 구독이 둘, 매달 두 번 청구. 두 번째 가입의 청구가 거절되면 `incomplete` 행이 현재 구독이 되어 결제한 구독의 크레딧을 못 씀(round-9 A9-8 A9-9) | (구현 규칙) | 정책 `subscription.multiplePerCustomer` 가 `deny` 이면 고객 단위 리스 안에서 살아 있는 구독(`active`·`trialing`·`past_due`·`incomplete`)을 확인하고 있으면 `subscription_exists` 로 청구 전에 거절한다. 첫 청구가 거절된 가입은 `expired` 로 닫고, 같은 requestId 는 계속 `subscription_start_declined` 다. 생성 코드의 현재 구독은 살아 있는 구독을 먼저 고른다 | lifecycle · cli | P0 |
| A73 | 밴된 고객이 계속 청구됨 — 취소된 구독을 `reactivate` 하면 tick 이 청구하고, 충전 결제는 받아서 쓸 수 없는 크레딧을 줌(round-9 A9-10) | (구현 규칙) | 새 청구(`chargeAttempt`: 갱신·dunning 재시도·가입)는 고객이 `banned` 면 쓰기·전송 전에 `customer_banned` 로 거절한다. `reactivate` 도 `customer_banned` 로 거절하고, `startCheckout` 은 `frozen`·`banned` 고객을 `customer_<status>` 로 거절한다 | lifecycle · cs | P0 |
| A74 | Toss·PortOne 구독 플랜에도 `startCheckout` 이 결제창 주문을 만들어, 승인하면 돈만 받고 등록은 `use_start_subscription` 으로 거절됨(round-9 A9-18) | (구현 규칙) | 자체 청구 결제사의 구독 플랜은 `startCheckout` 에서 주문을 만들기 전에 `use_start_subscription` 으로 거절한다 | cs | P0 |
| A75 | 초과 사용량 청구가 빌링키를 발급받은 customerKey 대신 고객의 결제사 참조를 보내 Toss 가 거절하고, 그러면 `closePeriods` 전체가 멈춰 다른 고객의 초과 청구도 빠짐(round-9 A9-11) | (구현 규칙) | 초과 청구는 구독의 `billingCustomerRef` 를 먼저 보낸다(A60 과 같은 규칙). `settleDuePeriods` 는 구독 하나의 오류를 모아 두고 나머지 구독을 모두 처리한 뒤 `usage_settlement_errors`(각 구독의 코드·메시지)로 알린다. 첫 청구가 성공한 적 없는 닫힌 가입은 사용량 주인 후보에서 뺀다 | usage | P0 |
| A76 | 업그레이드 추가금을 환불하면 크레딧만 회수되고 새 플랜·재설정된 기간이 남아, 다음 갱신이 새 플랜 요금으로 청구됨(round-9 A9-5) | (구현 규칙) | 업그레이드 결제 행이 업그레이드 전 플랜·기간·기준일을 기록한다. 그 결제가 전액 환불되면(킷 환불·결제사 콘솔 환불 모두) 업그레이드한 플랜이 아직 현재 플랜일 때 구독을 이전 플랜·기간·기준일로 되돌린다. 부분 환불은 구독을 바꾸지 않는다 | refund · lifecycle | P0 |
| A77 | 결제사 네이티브 업그레이드의 크레딧이 결제와 어긋남 — Stripe reset_anchor 는 킷의 차액과 새 기간 인보이스의 지급이 둘 다 들어가고, Polar 는 결제 없이 차액을 먼저 주며 `prorate` 가 다음 청구서로 미뤄져 기간 말 취소면 추가금이 청구되지 않음(round-9 A9-6 A9-7) | (구현 규칙) | 네이티브 변경 뒤 기간·기준일은 결제사 응답을 따른다. Stripe reset_anchor 는 킷이 차액을 주지 않는다(새 기간 인보이스가 지급). Polar 는 `proration_behavior:'invoice'` 로 차액을 별도 주문으로 바로 청구하고(`capabilities().upgradeGrant='on_payment'`), 킷은 차액을 대기 작업으로 남겼다가 그 기간의 다른 결제(변경 주문)가 paid 로 오면 한 번 지급한다. 기간 결제의 재전송은 지급하지 않는다 | lifecycle · providers.polar | P0 |

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
| B19 | 출처별 기본 만료 — 프로모션 | `policy.credits.expiry_days.promo` | **`null`** (무만료) / 일수. `grantPromo` 에 `policy` 를 넘기고 `expiresAt` 을 주지 않을 때 적용, 소진 순서는 그대로 만료 임박 순 | credits | P0 |
| B19 | 출처별 기본 만료 — 트라이얼 직접 지급 | `policy.credits.expiry_days.trial` | **`null`** / 일수. `grantTrial` 직접 지급에만 적용(구독 트라이얼 크레딧은 기간 끝에 만료되는 기존 규칙 그대로) | credits | P0 |
| B19 | 출처별 기본 만료 — 운영자 수동 지급 | `policy.credits.expiry_days.manual` | **`null`** / 일수. `manualGrant` 에 `policy` 를 넘길 때 적용 | credits | P0 |
| B19 | 출처별 기본 만료 — CS 재지급 | `policy.credits.expiry_days.regrant` | **`null`** / 일수. 재지급 계획에 `expiresAt` 이 없으면 케이스의 정책 스냅샷 값으로 만료일을 정한다. 충전분은 기존 `topup_expiry_days`(B10), 구독 지급분은 주기 끝(롤오버 규칙) | cs · credits | P0 |
| B20 | 다른 고객이 같은 멱등 키를 재사용 (호출자가 정한 요청 ID 충돌) | (구현 규칙) | 원장·usage_events 의 멱등 키 유일성은 `(customer_id, idempotency_key)`. 다른 고객의 같은 키는 새 작업으로 처리해 그 고객에게 청구하고, 처음 고객의 원장 행을 돌려주지 않는다. 같은 고객의 같은 키는 B12 대로 중복. Postgres 는 0009(원장)·0010(usage) 마이그레이션이 전역 unique 를 고객 단위로 바꾼다 | core + credits + usage + schema-postgres | P0 |
| B21 | 호출자가 정한 consume 멱등 키가 다른 키의 접두어이거나(`topup` 대 `topup:pay_1`) LIKE 와일드카드(`%`, `_`)를 담음 | (구현 규칙) | consume 의 중복 판정은 호출자 키와의 **정확한 일치**만 본다. Postgres 는 consume 이 쓴 모든 행에 `consume_key` 를 남기고 그 열을 등호로 찾는다(0013). 여러 행으로 나뉜 consume 의 뒤쪽 행은 무작위 키를 받아, 호출자가 고를 수 있는 키와 겹치지 않는다. 메모리 구현은 행 키가 이미 다른 작업의 것이면 `idempotency_key_conflict` 로 거절하고 아무것도 쓰지 않는다. 0013 이전에 쓰인 consume 은 첫 행의 키로만 다시 찾는다 | core + schema-postgres | P0 |
| B22 | 0013 이전에 쓴 분할 consume 행(`job`, `job:1`, consume_key 없음)이 남은 DB 에서, 새 consume 키가 옛 뒤쪽 행 키와 같음 | (구현 규칙) | 옛 행은 한 트랜잭션(같은 `created_at`)에서 첫 행이 키 그대로, 뒤쪽 행이 `<키>:<n>` 으로 쓰였다. 같은 트랜잭션에 `job` 행이 있는 `job:1` 행은 `job` 의 뒤쪽 행이라 새 consume `job:1` 과 맞추지 않고 새로 차감한다. `job` 재시도는 뒤쪽 행까지 모두 돌려준다. 이전에는 새 `job:1` 이 차감 없이 중복으로 통과했고(과소 청구), `job` 재시도는 첫 행(-50)만 돌려줬다(실제 -80) | schema-postgres | P0 |
| B23 | consume 키가 다른 원장 행 키와 겹칠 때 Postgres 는 raw 23505, in-memory 는 `idempotency_key_conflict` 를 던지고 겹치는 조건도 다름 | (구현 규칙) | 두 저장소 모두 consume 의 i 번째 행 키를 `<키>#<i>` 로 쓰고, 그 키를 다른 행이 이미 가졌을 때만 쓰기 전에 `idempotency_key_conflict` 로 거부한다. grant 키와 consume 키가 같은 것은 서로 다른 작업이다(이전 Postgres 는 23505) | core + schema-postgres | P0 |
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
| C11 | 끝난 구독(`canceled`: 기간이 끝남, `expired`: 최종 결제 실패)이나 권한 없는 구독(`paused`, `incomplete`)으로 이용·예약 | (구현 규칙) | `usage.check` 는 네 상태 모두 `subscription_inactive` 로 거절한다(기간 말 해지 예약은 기간 끝까지 `active`). `usage.reserve` 는 `sub` 를 넘기면 같은 규칙으로 hold 전에 거절한다. `usage.record`(이미 일어난 사용량 기록)와 `credits.consume`(구독과 무관한 충전 크레딧)은 막지 않는다 생성 코드의 `reservations.reserve` 는 고객의 현재 구독을 찾아 넘기고(`subscriptionId` 로 지정 가능), `consume` 은 미결제 상태(paused, incomplete) 구독이면 `subscription_inactive` 로 거부한다. 취소·만료 구독은 산 크레딧을 계속 쓸 수 있다. 이전 생성 코드는 reserve 에 구독을 넘기지 않아 이 검사가 돌지 않았다 | usage | P0 |
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
| D16 | 환불 사유별 처리 — 기술 실패 | `policy.refund.reasons.technical_failure` | **`rules`** (위 금액 규칙) / `full` (환불 창·방식·연간 제한과 무관하게 남은 결제 전액, 크레딧은 남은 만큼만 회수하고 금액은 줄이지 않음) | refund | P0 |
| D16 | 환불 사유별 처리 — 결과 불만족 | `policy.refund.reasons.dissatisfied` | **`rules`** / `evidence_required` (요청에 `evidenceRef` 가 없으면 담당자 확인) / `needs_human` | refund · cs | P0 |
| D16 | 환불 사유별 처리 — 사용자 과실 | `policy.refund.reasons.user_error` | **`rules`** / `deny`. 사유는 `support.requestRefund({ ..., reason: { category, evidenceRef } })` 로 넘기고, 카테고리는 `technical_failure` · `dissatisfied` · `user_error` · `other`(항상 금액 규칙) | refund · cs | P0 |
| D17 | 같은 결제에 키가 다른 환불 요청 두 개가 동시에 도착 (합이 결제액 초과) | (구현 규칙) | 남은 환불 가능액 검사부터 보류·pending 환불 기록까지를 고객 단위 임계구역(`ledger.transaction`: 메모리 잠금, Postgres advisory lock)에서 실행해 하나만 통과한다. 결제사 호출은 잠금 밖 | refund | P0 |
| D18 | 외부(결제사 대시보드) 환불의 크레딧 회수가 같은 고객의 consume 과 겹침, 또는 회수 뒤 consume | (구현 규칙) | 잔액 조회·회수량 clamp·회수 기록·환불 행 쓰기를 고객 원장 잠금(`ledger.transaction`, consume 과 같은 잠금) 안에서 한다. 회수는 grant 버킷에 묶어(`reference.grantId`, 그 결제의 grant 먼저, 이어서 만료가 이른 순) 기록해, 회수된 크레딧을 뒤이은 consume 이 다시 쓰지 못한다. 승인된 `allow_negative` pending 환불이 버킷보다 많이 회수할 때만 넘는 부분을 grant 없는 회수로 남긴다. clamp 되면 reconcile 케이스를 연다. 이전 구현은 경합 시 8/8 라운드에서 `block` 인데 잔액 -100 이었다 | refund | P0 |
| D19 | 같은 결제사 환불이 동시에 두 번 도착(Stripe 는 한 환불에 `refund.created`, `refund.updated`, `charge.refund.updated` 를 보낸다) | (구현 규칙) | 환불 참조(`refundRef`)로 이미 정산된 환불이 있는지를 고객 원장 잠금 안에서 다시 확인하고, 있으면 그 환불을 돌려준다. 이전에는 확인이 잠금 밖에 있어 환불 행이 2 개, 크레딧 회수가 두 번, 결제가 전액 환불로 표시되어 남은 금액을 kit 으로 환불할 수 없었다(Postgres 6/6 재현) | refund | P0 |
| D20 | 외부 환불의 회수 크레딧을 grant 단가(내림)로 계산 — 나누어떨어지지 않는 가격(1999 minor 에 1000 크레딧 → 단가 1)의 전액 환불이 1999 크레딧으로 계산돼 매번 거짓 정산 불일치 케이스가 열림 | (구현 규칙) | 이 결제가 지급한 크레딧이 있고 통화가 같으면 회수량 = 환불액 ÷ 결제액 × 지급 크레딧(반올림, J9 규칙). 전액 환불은 지급분 전부. 지급이 없거나 통화가 다를 때만 단가로 계산 | refund | P0 |
| D21 | 분쟁 종결 결과가 `NormalizedEvent` 에 없어 kit 이 `raw.outcome` 을 읽음 — Stripe 는 결과를 `data.object.status` 에 두므로 항상 `unknown`, 패소해도 동결 해제·회수 없음(round-7 A7-1) | (구현 규칙) | 어댑터가 `dispute.closed` 에 `disputeOutcome`(`won`/`lost`, 그 밖은 null)을 채운다(Stripe: `status`). 결과가 없으면(PortOne, Stripe `warning_closed`) 복원도 회수도 하지 않고 고객은 열릴 때 상태 그대로 두며 케이스를 `needs_human` 으로 올린다 | providers · cs | P0 |
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
| E17 | 받은 뒤 5분 넘게 지나 재처리하는 webhook (processPending 재시도) | (구현 규칙) | `receive()` 가 서명과 타임스탬프 허용 범위(Stripe 300초, Standard Webhooks 5분)를 벽시계로 검사한다. `process()` 는 저장된 원문의 서명만 다시 검증하고 나이는 보지 않는다(`receivedAt` 전달). Google push 토큰 exp·Apple 인증서 유효기간은 `receivedAt` 기준. 저장 뒤 원문이 바뀐 행은 서명 불일치로 실패 | webhook + providers | P0 |
| E18 | 서명 없는 Toss webhook 의 출처 위조 (요청 헤더로 IP 허용목록 통과, 가상계좌 입금 콜백 위조) | (구현 규칙) | IP 허용목록은 앱이 소켓에서 읽어 넘기는 연결 주소(`remoteAddress`)만 쓰고 요청 헤더(`x-paykit-remote-ip`, `x-forwarded-for`)는 쓰지 않는다. `DEPOSIT_CALLBACK` 은 `orderId` 로 결제를 다시 조회해 그 결제의 `secret` 과 상수 시간 비교가 맞을 때만 받는다(Toss 문서 webhook-events). 두 검사는 수신 시점에 하고, `process()` 의 재검증은 이미 통과한 저장 행이라 다시 하지 않는다. Toss 를 고른 생성 프로젝트의 `handleWebhook` 은 `remoteAddress` 를 받는다 | providers(toss) + webhook | P0 |
| E19 | 서명 없는 Toss 웹훅 위조로 충전 크레딧 지급 (허용목록 미설정, secret 뺀 입금 콜백, 입금 전 가상계좌), 재시도 사이에 환불된 결제 | (구현 규칙) | 일회성 충전은 결제사에서 다시 조회한 결제 상태가 `succeeded` 일 때만 지급한다(A25 와 같은 규칙, 아니면 `topup_payment_not_succeeded` 로 기록 실패, 다음 전달·재시도가 다시 확인). Toss 는 허용목록이 비어 있으면 수신 시점에 모든 웹훅을 거부하고(fail closed), `DEPOSIT_CALLBACK` 은 `secret` 이 없으면 거부한다. 생성 코드는 `TOSS_WEBHOOK_ALLOWED_IPS` 를 읽는다. 이전에는 허용목록 없이 생성되어, 서명 없는 요청 한 통으로 입금 전 가상계좌에 5000 크레딧이 지급됐다 | webhook + providers(toss) + cli | P0 |
| E20 | 수신(200 응답)과 처리 사이에 웹훅 서명 비밀값을 교체 | `*_WEBHOOK_PREVIOUS_SECRETS` | 결제사 어댑터(Stripe, Polar, PortOne)는 현재 비밀값 다음에 교체 중인 이전 비밀값들로도 서명을 확인한다(`previousWebhookSecrets`). 이전 비밀값은 저장된 웹훅의 재처리(`receivedAt` 있음)에만 쓴다(E21). 이전 구현은 현재 값 하나로만 재검증해, 이미 200 을 준 이벤트가 8회 시도 뒤 영구 실패했다. 생성 코드는 쉼표 목록 env 를 읽는다(비우면 현재 값만) | providers(stripe, polar, portone) + cli | P0 |
| E21 | 유출 때문에 교체해 뺀 이전 비밀값으로 서명한 새 웹훅 | `*_WEBHOOK_PREVIOUS_SECRETS` | 수신 시점(`receivedAt` 없음)에는 현재 비밀값 하나만 인정한다. 이전 비밀값은 이미 받아 둔 행의 재검증에만 쓴다. 이전 구현은 수신에도 이전 값을 받아, 목록에 남은 동안 옛 키로 새 이벤트를 위조할 수 있었다 | providers(stripe, polar, portone) | P0 |
| E22 | Toss 허용목록이 IPv4-mapped IPv6 주소(`::ffff:a.b.c.d`)나 CIDR 블록을 거부 | `TOSS_WEBHOOK_ALLOWED_IPS` | 목록 항목은 주소 또는 CIDR(IPv4/IPv6)이다. dual-stack 소켓이 주는 `::ffff:` 주소는 IPv4 로 보고 대조한다. 주소도 CIDR 도 아닌 항목은 생성 시점에 오류로 거부한다(조용히 안 맞는 항목을 두지 않는다) | providers(toss) | P0 |
| E23 | Stripe PaymentIntent 는 환불·분쟁 뒤에도 `succeeded` 로 남는다 | (구현 규칙) | `getPayment` 는 `latest_charge` 를 펼쳐 가져오고, 환불액이 있으면 `refunded`/`partially_refunded`, 분쟁이면 `disputed` 로 정규화한다. 재시도 사이에 환불된 충전 결제가 `succeeded` 로 재조회되어 크레딧이 지급되던 경로(E19 두 번째 경로)를 막는다 | providers(stripe) | P0 |
| E24 | 한 결제를 결제사가 여러 id 로 부름 — Stripe 갱신 결제는 인보이스(`in_…`)로 기록되는데 환불·분쟁 이벤트는 PaymentIntent(`pi_…`)·충전(`ch_…`)을 가리킨다. 로컬 결제를 못 찾아 대시보드 환불의 크레딧 회수·분쟁 동결이 빠지고, 고객 `'unknown'` 케이스가 `cs_cases` FK 로 실패해 웹훅이 영구 failed | (구현 규칙) | 결제사 어댑터가 가져온 결제에 다른 id 들(`providerRefAliases`)을 싣고, 웹훅이 결제를 기록·재조회할 때 operations 에 별칭으로 남긴다(스키마 변경 없음). 환불·분쟁 이벤트는 정확한 `providerRef` → 별칭 → 결제사 재조회(그 결제의 다른 id, 별칭 이전에 기록된 행은 같은 고객의 최근 결제를 한 번씩 재조회) 순서로 로컬 결제를 찾는다. 끝내 없으면 `cs.needs_human`(`unmatched_refund`/`unmatched_dispute`)을 한 번만 보내고 레코드는 failed(재시도 상한 안에서 다시 처리)로 둔다. 로컬 고객이 없는 케이스는 만들지 않는다 | webhook · refund · cs · providers(stripe) | P0 |

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
| I10 | 월 정산·세금계산서용 집계 ("이번 달 얼마 받고 얼마 돌려줬나") | (구현 규칙) | `cs.settlementReport({ from, to })` — 창 [from, to) 안의 결제(`occurredAt`)를 통화·종류·상태별로, 성공 환불을 통화별로, 통화별 순액(성공·부분환불 결제 − 성공 환불), 원장 행을 종류·출처별로 센다. 통화끼리는 절대 합치지 않는다. 읽기만 한다. Postgres 저장소는 환불·원장 행의 시각을 기록 시점(DB 시계)으로 남기므로 그 기준으로 창에 들어간다 | cs | P0 |
| I11 | 알림 본문에 채워지지 않은 자리표시자(`{graceDays}`, `{amount}`, `{caseId}`)가 그대로 나감 — 보내는 쪽 payload 에 없는 키를 템플릿이 씀(round-7 A7-8) | (구현 규칙) | 템플릿은 kit 이 보내는 payload 에 늘 있는 키만 쓴다(`grace.started` 에 `graceDays`, `grace.ending` 에 `graceUntil` 추가). `{customerId}` 는 알림의 고객, `{detail}` 은 payload 전체(`key=value`)로 채운다. 실제 흐름(거절·재시도·유예 만료·무응답·크레딧 만료·에스컬레이션)이 보낸 알림을 두 언어로 렌더해 자리표시자 0 을 확인한다 | notify · lifecycle | P1 |

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
| J6 | 통화별 소수 자릿수 (KRW·JPY 외의 0 자리 통화, KWD·BHD 같은 3 자리 통화) | (구현 규칙) | ISO 4217 지수 표(`currencyExponent`: 0/2/3)를 표시·변환 전부에서 쓴다(타임라인, 인앱결제 금액 환산) | core + cs | P1 |
| J7 | 금액 계산이 부동소수점으로 한 단위 모자라거나(8.7/30 일 남은 100 차액 → 28), TS 와 Python 이 .5 를 다르게 반올림(Math.round vs round), 2^53 을 넘는 정수가 조용히 깨짐 | (구현 규칙) | 금액은 안전 정수(절댓값 2^53-1 이하)만 받는다. 비례 금액은 `prorationFraction`(ms 정수 분수) × `scaleMinor`(정수 유리수, 반올림 방식 명시)로 계산한다. 반올림 `round` 는 두 언어 모두 0 에서 먼 쪽 | core + lifecycle + refund | P0 |
| J8 | 결제사 응답·웹훅의 금액이 정수가 아니거나 2^53 을 넘음, Python 반올림이 TS 와 다른 경계값(0.49999999999999994, 2^52 근처), Python 비례 분모의 banker's rounding·마이크로초 | (구현 규칙) | 결제사 어댑터(Stripe, Polar, Toss, PortOne)의 금액은 core `money()` 를 거쳐 안전 정수가 아니면 거절한다(Py 가 1.5 를 1 로 자르던 것도 거절). Python `round_half_away_from_zero` 는 소수부를 정확히 비교하고, `proration_fraction` 은 TS 처럼 0 에서 먼 반올림과 epoch 밀리초 정수를 쓴다 | core + providers | P0 |
| J9 | 환불 크레딧 환산의 .5 경계가 TS(`Math.round`, 3)와 Python(`round`, 2)에서 다름 | `policy.refund.rounding` | `round_credits` 와 외부 환불의 크레딧 환산은 두 언어 모두 0 에서 먼 쪽으로 반올림한다(core `roundHalfAwayFromZero`). 이전에는 감사 값 6003 개 중 1480 개가 1 크레딧씩 달랐다 | refund | P0 |
| J10 | Python `money()` 가 JSON `50000.0` 같은 정수값 실수를 거부하고 TS 는 받음 | (구현 규칙) | 두 언어 모두 정수값인 숫자는 받고(Python 은 `int` 로 바꿈), 소수·NaN·무한대·bool·안전 정수 밖은 거부한다 | core | P0 |
| J11 | 날짜로 만든 키(지급·시도·회수·기간)가 Python 에서 `isoformat()` 이라 PG 세션 시간대(`Asia/Seoul`)나 입력 tzinfo 에 따라 `+09:00`/`+00:00` 로 달라짐 → 같은 기간에 지급 2건, TS(`…000Z`)와 섞으면 UTC 에서도 2건 | (구현 규칙) | 모든 날짜 키는 UTC 밀리초 `…Z`(core `isoZ` / `iso_z`)로 두 언어가 같은 문자열을 만든다. Python PG 세션은 `TimeZone=UTC`, 멱등 payload 의 시각도 UTC 로 해시한다. 이전 형식으로 이미 쓰인 지급·시도 키는 같은 순간이면 같은 것으로 본다(`keyMatchesInstant`) — 업그레이드 뒤 두 번째 지급 없음 | core + credits + lifecycle + cs | P0 |
| J12 | DST 겹침·공백 시각에서 TS 와 Python 의 기간 계산이 다름(감사 6,000건 중 63건) | `policy.period.timezone` | 두 언어가 같은 규칙을 쓴다: 두 번 있는 벽시계 시각은 앞선 순간, 없는 시각은 전환 전 오프셋으로 읽는다(Python `fold=0` 과 같음). 대조 테스트 6,000건 불일치 0 | core | P0 |
| J13 | J11 호환이 지급·시도 키에만 있어 Python 업그레이드 뒤 다른 날짜 키(`revoke:cancel`, `restore:reactivate`, `revoke:downgrade`, `grant:upgrade`, `revoke:dunning`, `rollover`, run-idempotent 작업 키 `cancel:`/`upgrade:`/`downgrade:`/`reactivate:`, 업그레이드 청구 키)를 못 찾음 — 취소 뒤 재활성화 복원 0, 답을 잃은 업그레이드 재시도 시 추가금 이중 청구(round-7 A7-3) | (구현 규칙) | Python 은 날짜가 든 모든 원장 키를 먼저 어느 형식으로든 찾고(`ledger_instant_key`) 있으면 그 키를 쓴다. run-idempotent 작업 키는 이전 형식 작업이 있으면 그 키와 그 안의 시각 문자열로 payload 를 만들어(`operation_instant_key`) 앞선 작업을 이어받고, 업그레이드는 그 시각으로 이전 청구 키를 조회한다 | core + lifecycle + credits (py) | P0 |

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
5. 크레딧: B1 B2 B3 B4 B7 B10 (B19 은 고급)
6. 업그레이드: A1 A2
7. 다운그레이드: A3 A4
8. 취소: A5 A6
9. 트라이얼: A9 (있을 때만)
10. 갱신 실패: A13 A14 A15 A16 A17 (A47 은 구독 + toss/portone 일 때)
11. 환불: D1 D2 D3 B13 (D7 D10 D16 은 고급)
12. 이용량: C1 C2 C5 (usage 선택 시), C10 (예산 예약을 켠 경우)
13. 분쟁: B11 D9
14. 현금영수증(KR): K2 K3 K5 — provider 에 toss/portone 선택 시만
15. CS: E1(regrant mode) I1 I2 — CS 애드온 활성화 시
16. 인프라: 스키마 · webhook · 알림 · 로깅(L1-L5, `infra.logging`) · 언어

## 커버리지 규칙

- P0 케이스마다 `spec/*.pseudo.md` 에 같은 ID 의 섹션이 있어야 한다.
- 구현(py/ts) 은 해당 섹션 ID 를 주석으로 인용한다 (`# EC:A3`).
- 커버리지 검사 스크립트는 **구현이 존재한 뒤** 붙인다.
