# lifecycle — pseudo spec (source of truth)

모듈 공개 API: docs/ARCHITECTURE.md §3.5 `lifecycle.*`.
담당 EC: A1 A2 A3 A4 A5 A6 A7 A8 A9 A10 A11 A13 A14 A15 A16 A17 A23 A24 G1 G2 K1, F(Toss/Portone self-scheduler).

`retryOnVersionConflict(fn, attempts=3)` (retry.ts / retry.py) — EC:K1 call-site helper. Retries
`fn` when it throws `PaymentKitError('subscription_version_conflict')`; `fn` must re-read whatever
row it needs before writing on each attempt. Used by `scheduler.tick()` where a real network await
(`provider.chargeBillingKey`) sits between reading a due `Subscription` and the eventual
`repo.subscriptions.put` inside `onRenewalPaid`/`onPaymentFailed` — see 최종 보고 "call-site audit"
for the full list of `subscriptions.put` call sites and which ones needed this vs. were already
safe (read-and-write in the same call, no intervening await another writer could win).

`period.ts` 는 core 가 이미 구현한 `nextPeriod`/`prorationRatio`/`periodContaining`/`elapsedRatio`
(packages/core/{ts,py}/.../period.{ts,py}, [EC:G1] [EC:G2])를 그대로 재수출한다 — 로컬 재구현 없음.
credit 이동(grant/rollover/clawback)은 이 패키지가 아니라 `boilpayment-credits`
(`boilpayment_credits`)를 워크스페이스 의존성으로 불러 위임한다.

---

## [EC:A1 A2 A8] upgrade — 중간 주기 업그레이드

```pseudo
input: { sub, newPlan, policy, provider, ledger, repo, clock, ids }
steps:
  1. oldPlan = repo.plans.get(sub.planId)  — 없으면 에러
  2. EC:A8 — intervalChanged = oldPlan.interval != newPlan.interval
     effectiveMode = intervalChanged and policy.intervalChange.mode == 'next_period'
                     ? 'next_period' : policy.upgrade.mode
  3. effectiveMode == 'next_period':
       sub.scheduledPlanId = newPlan.id  (다른 필드 불변)
       repo.subscriptions.put(sub)
       return { sub, grant: null, creditDelta: 0 }   # 지금은 변화 없음
  4. (immediate_prorate_reset_anchor | immediate_prorate_keep_anchor)
     now = clock.now()
     EC:F — provider.capabilities().nativeSubscriptions:
       true  -> priceRef = resolvePriceRef(newPlan, sub.provider)
                provider.changeSubscription(sub.providerRef, { newPriceRef: priceRef,
                  proration:'immediate', resetAnchor: effectiveMode == 'immediate_prorate_reset_anchor' })
       false -> Toss/PortOne(self-scheduling) 은 구독 상태를 모른다 — getSubscription/
                changeSubscription/cancelSubscription 은 PaymentKitError('unsupported') 를 던진다.
                대신 Repo.subscriptions 만 우리가 갱신하고, changeSubscription 이 원래 트리거했을
                "차액 즉시 청구" 를 우리가 직접 한다:
                  sub.billingKey 없으면 -> throw PaymentKitError('billing_key_required')
                  oldPrice = oldPlan.prices[0], newPrice = newPlan.prices[0]  (대표 price 1개, 계약 변경 제안 #4)
                  priceDeltaMinor = newPrice.amountMinor - oldPrice.amountMinor
                  moneyRatio = core.prorationRatio(sub.currentPeriod, now, policy.proration.denominator)
                  proratedMoneyDelta = floor(priceDeltaMinor * moneyRatio)
                  proratedMoneyDelta > 0 이면:
                    chargeKey = "charge:upgrade:{sub.id}:{now.toISOString()}"
                    payment = provider.chargeBillingKey({ billingKey: sub.billingKey,
                      amount: {amountMinor: proratedMoneyDelta, currency: newPrice.currency},
                      orderId: chargeKey, customerRef: sub.customerId, idempotencyKey: chargeKey })
                    payment.status != 'succeeded' 이면 -> throw PaymentKitError('upgrade_charge_failed')
     reset_anchor:
       anchorDay = now 의 UTC 일자 (EC:G3 — UTC 저장 원칙. 비-UTC tz civil day 는 core 내부 전용이라
                    미노출 상태; policy.period.timezone='UTC' 기본값에서는 정확, 비-UTC 커스텀 tz 는
                    근사치 — 계약 변경 제안에 기록)
       newPeriod = core.nextPeriod({start:now,end:now}, newPlan.interval, anchorDay,
                                    policy.period.timezone, policy.period.monthEndAnchor)
       currentPeriod = newPeriod   # {start: now, end: computed}
     keep_anchor:
       currentPeriod = sub.currentPeriod (불변), anchorDay 불변
  6. EC:A2 — creditDelta:
       fullDelta = newPlan.creditsPerPeriod - oldPlan.creditsPerPeriod
       policy.upgrade.creditDelta == 'full_delta'     -> delta = fullDelta
       policy.upgrade.creditDelta == 'prorated_delta' -> delta = floor(fullDelta *
         core.prorationRatio(sub.currentPeriod /* 업그레이드 전 원래 주기 */, now, policy.proration.denominator))
  7. delta > 0:
       idempotencyKey = "grant:upgrade:{sub.id}:{now.toISOString()}"
       expiresAt = policy.credits.rollover == 'full' ? null : currentPeriod.end
       ledger.append({ pool:'paid', kind:'grant', amount:delta, source:'subscription',
         reference:{subscriptionId, periodStart: currentPeriod.start}, idempotencyKey,
         actor:'system', reason:"upgrade:{oldPlan.id}->{newPlan.id}" })
  8. sub' = { ...sub, planId:newPlan.id, currentPeriod, anchorDay, scheduledPlanId:null }
     repo.subscriptions.put(sub')
output: { sub, grant: LedgerEntry|null, creditDelta: int }
idempotencyKey: grant:upgrade:{sub.id}:{now ISO}
```

## [EC:A3 A4] downgrade — 다운그레이드

```pseudo
input: { sub, newPlan, policy, provider, ledger, repo, clock, ids }
steps:
  1. oldPlan = repo.plans.get(sub.planId)
  2. policy.downgrade.mode == 'end_of_period':
       sub.scheduledPlanId = newPlan.id; put; return { sub, clawback: null }  # 기지급 유지, 변화 없음
  3. (immediate_keep | immediate_clawback):
       EC:F — provider.capabilities().nativeSubscriptions 일 때만 changeSubscription 호출:
         priceRef = resolvePriceRef(newPlan, sub.provider)
         provider.changeSubscription(sub.providerRef, { newPriceRef, proration:'immediate', resetAnchor:false })
       false 면 (Toss/PortOne self-scheduling, 'unsupported' 를 던짐) 호출하지 않고 Repo 만 갱신한다.
       다운그레이드는 가격이 내려가므로 upgrade 와 달리 즉시 청구할 것이 없다.
  4. immediate_clawback and (oldPlan.creditsPerPeriod - newPlan.creditsPerPeriod) > 0:
       delta = oldPlan.creditsPerPeriod - newPlan.creditsPerPeriod
       idempotencyKey = "revoke:downgrade:{sub.id}:{sub.currentPeriod.start.toISOString()}"   (§7 규약)
       credits.clawback({ customerId, amount:delta, policy, ledger, clock, reason:"downgrade:...",
         reference:{subscriptionId, periodStart: sub.currentPeriod.start}, actor:'system',
         idempotencyKey, shortfall: policy.downgrade.clawbackShortfall })   # EC:A4 그대로 전달
  5. sub' = { ...sub, planId:newPlan.id, scheduledPlanId:null }; repo.subscriptions.put(sub')
output: { sub, clawback: ClawbackResult|null }
idempotencyKey: revoke:downgrade:{sub.id}:{period.start ISO}
```

## [EC:A5 A6 A10 I4] cancel — 취소

```pseudo
input: { sub, policy, provider, ledger, repo, clock, churnReason?, churnText?, onChurn? }
steps:
  0. policy.cancel.credits == 'keep_forever': throw PaymentKitError('unsupported')
     # provider 호출, 원장 변경, operation 생성 전 거부한다. 지원하지 않는 규칙을 다른 규칙으로 대체하지 않는다.
  1. atPeriodEnd = policy.cancel.mode == 'end_of_period'
     EC:F — provider.capabilities().nativeSubscriptions 일 때만 cancelSubscription 호출:
       provider.cancelSubscription(sub.providerRef, { atPeriodEnd })
     false 면 (Toss/PortOne self-scheduling, 'unsupported' 를 던짐) 호출하지 않는다 — 아래 4번에서
     scheduler.dueSubscriptions 는 cancelAtPeriodEnd=true 와 active 이외 상태를 제외한다.
  2. EC:A6 credits:
       'revoke_immediately' -> balance=ledger.balance(customerId,'paid',now); balance.available>0 이면
         credits.clawback({..., amount: balance.available, shortfall:'clamp_to_zero',
           idempotencyKey:"revoke:cancel:{sub.id}:{sub.currentPeriod.start ISO}"})
       'keep_until_period_end' -> 아무것도 안 함 (기존 grant.expiresAt = period.end 가 이미 처리)
  3. EC:A10 — sub.status == 'trialing' and policy.trial.creditsOnCancel == 'revoke':
       trial pool 잔액 전액 revoke (idempotencyKey:"revoke:trial-cancel:{sub.id}")
  4. sub' = { ...sub, status: atPeriodEnd ? sub.status : 'canceled', cancelAtPeriodEnd: atPeriodEnd }
     repo.subscriptions.put(sub')
  5. EC:I4 — churn = {reason: churnReason ?? null, text: churnText ?? null}; onChurn?.(...) 호출
     (실제 cs_cases 영속화는 cs 모듈의 책임 — 여기서는 콜백으로만 노출)
output: { sub, churn: {reason, text}, revoked: ClawbackResult|null }
idempotencyKey: revoke:cancel:{sub.id}:{period.start ISO} / revoke:trial-cancel:{sub.id}
```

## [EC:A23] reactivate — 취소 철회 (재활성화)

`policy.*` 키 없음 — 앱이 명시적으로 호출하는 연산("취소 취소해줘")이지, 자동으로 갈라지는
정책 분기가 아니다. `cancel` 의 거울상: `cancelAtPeriodEnd`/`status='canceled'` 를 되돌리고,
`policy.cancel.credits == 'revoke_immediately'` 로 회수됐던 크레딧이 있으면 복원한다.

```pseudo
input: { sub, policy, provider, ledger, repo, clock, idempotencyKey?, correlationId? }
steps:
  1. now = clock.now()
     periodEnded = now >= sub.currentPeriod.end
     if sub.cancelAtPeriodEnd:
       nextStatus = 'active'                                    # 예약 취소, 아직 실제로는 안 끊김
     elif sub.status == 'canceled' and not periodEnded:
       nextStatus = 'active'                                    # 즉시 취소지만 이미 낸 주기가 안 끝남
     else:
       throw PaymentKitError('not_reactivatable', {id, status, cancelAtPeriodEnd})
       # status=='expired' 이거나 주기가 이미 끝났거나, 애초에 되돌릴 취소가 없던 경우
       # (여전히 active/trialing/past_due 이고 cancelAtPeriodEnd=false) — 새 구독을 시작해야 한다.
  2. providerNotified = false
     EC:F — self-scheduling 프로바이더(Toss/Portone, capabilities().nativeSubscriptions=false)는
     구독 상태 자체를 모르므로 아무 것도 호출하지 않는다(providerNotified 는 false 로 남는다).
     네이티브 프로바이더(Stripe/Polar)는 scopeProvider(provider, correlationId).uncancelSubscription
     (providerRef) 를 실제로 호출한다(2026-09-09 신설 — 예전엔 "계약에 메서드 없음" 이라 Repo 만
     정정했다, 아래 히스토리 참고):
       - 성공 -> providerNotified = true
       - PaymentKitError('unsupported') (아직 이 메서드를 구현 안 한 네이티브 프로바이더 어댑터) ->
         providerNotified = false 로 두고 계속 진행 — Repo-only 복구가 여전히 올바른 결과다.
       - 그 외 에러(특히 'not_reactivatable' — 프로바이더가 "이미 완전히 끝났다"고 답함) -> 그대로
         전파한다. Repo 를 잘못 정정한 채로 조용히 끝내지 않는다.
  3. sub' = { ...sub, status: nextStatus, cancelAtPeriodEnd: false }
     repo.subscriptions.put(sub')
  4. policy.cancel.credits == 'revoke_immediately' 이면 restoreCanceledCredits 호출:
     cancel 이 남긴 단일 집계 revoke 행("revoke:cancel:{sub.id}:{periodStart}", grantId 없음)의
     createdAt 시점을 기준으로, 그 시점까지 존재했던 모든 grant 버킷의 그 시점 기준 remaining 을
     역산(만료 임박 순, ledger.balance/consume 과 동일 순서)해 원래 버킷별로 되돌린다 — 각 버킷은
     자신의 원래 expiresAt/unitPriceMinor/currency 를 그대로 쓴다. 멱등키:
     "restore:reactivate:{sub.id}:{periodStart}:{grantId}" (버킷 배분 후 남는 값이 있으면
     "...:remainder" 로 미귀속 복원). D9(dispute 승소 복원)와 동일한 패턴 — 차이는 D9 는 애초에
     grantId 별로 회수했지만 A23 은 cancel 의 집계 회수를 사후에 버킷 단위로 재구성한다는 점뿐.
output: { sub, restored: {restored:int}|null, providerNotified: bool }
idempotencyKey: reactivate:{sub.id}:{sub.currentPeriod.start ISO} (기본값, J5 스타일)
                restore:reactivate:{sub.id}:{periodStart}:{grantId|"remainder"} (크레딧 복원 행)
```

**히스토리 (해소된 계약 변경 제안, 2026-09-09)**: 이 절은 원래 `PaymentProvider` 에
`uncancelSubscription(providerRef)` 가 없어 네이티브 프로바이더 쪽은 Repo 만 정정하고 프로바이더
대시보드 상태는 안 건드리는 문서화된 한계를 적어 두었었다. `uncancelSubscription` 이 계약에
추가되고 Stripe(`subscriptions.update(ref,{cancel_at_period_end:false})`, 이미 `canceled` 면
`not_reactivatable`)·Polar(동일 REST PATCH, `polar.sh/docs/features/subscriptions/manage` 확인)
가 실제로 구현하면서 이 갭은 닫혔다 — 자세한 것은 각 provider spec 의 "엔드포인트 매핑"/`uncancel_
subscription` 절 참고.

## [EC:A9] convertTrial — 트라이얼 → 유료 전환

```pseudo
input: { sub, plan, payment, policy, ledger, repo, clock }
steps:
  1. policy.trial.creditsOnConvert == 'no_grant_until_next_period':
       grant = null   # 다음 갱신(onRenewalPaid)이 자기 키로 알아서 지급
  2. else:
       idempotencyKey = "grant:convert-trial:{sub.id}:{now.toISOString()}"
       ledger.append({ pool:'paid', kind:'grant', amount:plan.creditsPerPeriod,
         expiresAt: policy.credits.rollover=='full'?null:sub.currentPeriod.end,
         source:'subscription', reference:{subscriptionId, periodStart:sub.currentPeriod.start, paymentId},
         idempotencyKey, reason:'trial_convert' })
       'grant_full' -> trial pool 잔액 전액 revoke (idempotencyKey:"revoke:trial-convert:{sub.id}")
       'grant_full_keep_trial' -> trial pool 그대로 둠
  3. sub' = { ...sub, status:'active', planId: plan.id }; repo.subscriptions.put(sub')
output: { sub, grant: LedgerEntry|null, trialRevoked: LedgerEntry|null }
idempotencyKey: grant:convert-trial:{sub.id}:{now ISO} / revoke:trial-convert:{sub.id}
```

## [EC:A11] isTrialEligible — 트라이얼 어뷰징 가드

```pseudo
input: { customerId, email, repo, policy }
steps:
  1. policy.trial.abuseGuard == 'none': return true
  2. ownSubs = repo.subscriptions.list({customerId}); ownSubs.length>0 이면 false (이미 구독 이력 있음)
  3. email 있으면: 같은 email 을 쓰는 다른 customer 들 조회 (repo.customers.list({email})) →
     그 customer 들 중 하나라도 구독 이력이 있으면 false
  4. else true
output: bool
```

## [EC:A7 A15 A17 A25 B12] onRenewalPaid — 갱신 결제 성공 처리

```pseudo
input: { sub, payment, policy, ledger, repo, clock }
# 이 결제가 "어느 주기"에 대한 것인지는 payment.period 를 신뢰한다(제공되어 있으면). 없으면
# sub.currentPeriod 를 그대로 쓴다 — 이렇게 하면 EC:A7(같은 주기 안 재활성화)이 별도 분기 없이
# "advance 안 함" 으로 자연히 처리되고, 방금 이 호출에서 만든 grant 를 rollover 가 스스로
# 되감아 먹어버리는 버그(같은 period 를 grant 대상이자 rollover 목적지로 동시에 쓰면 발생)도
# 피한다. period 를 언제 "다음 주기"로 미리 계산해 payment.period 에 채워 넣을지는 **호출자**
# 책임 — provider-scheduled 는 webhook 재조회(E3)가, self-scheduled 는
# scheduler.tick 이 core.nextPeriod 로 계산해 채운다 (아래 scheduler 섹션 참고).
steps:
  1. period = payment.period ?? sub.currentPeriod
  2. EC:A7 — 멱등: 이 주기(grant:{sub.id}:{period.start ISO})에 대한 grant 가 이미 있으면
     재활성화 없이 { sub, grant:{entry, duplicated:true, deferred:false}, rollover:no-op,
     duplicated:true, recovered:false } 를 반환한다 (같은 주기 안 재활성화 시 재지급 금지).
  2b. EC:A25 — payment.status != 'succeeded' 이면 어떤 쓰기도 하기 전에
     PaymentKitError('renewal_payment_not_succeeded', {subscriptionId, paymentId, status}) 를 던진다.
     pending/draft 인보이스, requires_action, failed 는 돈이 들어온 것이 아니다. webhook 경로에서는
     레코드가 failed 로 남고, 재시도(processPending/재전송)가 결제를 다시 조회(E3)해 succeeded 가
     되는 순간 지급한다. 2번(이미 지급된 주기)이 먼저라 지급 뒤의 재전송은 계속 no-op 이다.
     scheduler.tick 은 succeeded 일 때만 부르므로 영향이 없다.
  3. wasRecovering = sub.status == 'past_due'   (EC:A17 판단용)
  4. plan = repo.plans.get(sub.scheduledPlanId ?? sub.planId)   # 예약된 다운/업그레이드 반영
  5. EC:B2 — rollover = credits.rolloverOnRenewal({ sub, policy, ledger, clock, newPeriod: period })
     # sub 는 아직 advance 되지 않은 "이전" 상태 그대로 넘긴다 — rollover 는 sub.id 로 이전 grant
     # 들을 조회하고 newPeriod.start 를 만료 기준선으로 쓸 뿐, sub.currentPeriod 값 자체는
     # 안 본다. grant(6번)를 rollover(5번) 보다 먼저 하지 않는 것이 핵심 — 순서를 바꾸면
     # 방금 지급한 grant 를 즉시 되감아버린다.
  6. grant = credits.grantForPeriod({ sub: {...sub, planId:plan.id, status:'active'} /* 지급 보류
     판단(A15)을 피하려고 결제 확정 상태로 넘김 */, plan, period, payment, policy, ledger, clock })
  7. sub' = { ...sub, planId:plan.id, scheduledPlanId:null, currentPeriod:period,
              status:'active', graceUntil:null }
     repo.subscriptions.put(sub')
output: { sub, grant, rollover, duplicated:false, recovered: wasRecovering }
idempotencyKey: grant:{sub.id}:{period.start ISO} (credits 모듈이 생성)
```

## [EC:A13 A24] dunning.onPaymentFailed — 갱신 결제 실패, 유예 시작 + 스마트 재시도 예약

```pseudo
input: { sub, policy, repo, notifier, clock }
steps:
  1. graceDays = policy.dunning.graceDays
     graceUntil = graceDays>0 ? now + graceDays days : now
  2. sub' = { ...sub, status:'past_due', graceUntil }; repo.subscriptions.put(sub')
  3. notifier.send({type:'payment.failed', ...}); graceDays>0 이면 notifier.send({type:'grace.started', ...})
  4. EC:A24 — policy.dunning.retryAttempts > 0 이면 scheduleRetry(repo, sub.id, attempt=1, from:now,
     policy.dunning.retryIntervalHours) 로 첫 재시도를 repo.outbox 에 예약한다 (kind='dunning.retry',
     아래 [EC:A24] 섹션 참고). retryAttempts==0 (기본이 아님) 이면 아무 것도 예약하지 않는다 —
     provider 자체 dunning 에만 맡긴다는 뜻.
output: { sub }
```

## [EC:A16] dunning.onGraceExpired — 유예 만료, 최종 실패

```pseudo
input: { sub, policy, ledger, repo, notifier, clock }
steps:
  1. policy.dunning.onFinalFailure:
       'revoke_unpaid_period' -> 이번 주기 grant(key=grant:{sub.id}:{period.start ISO})의 잔여분만 revoke
       'revoke_all'            -> paid pool 잔액 전액 revoke
       'keep'                  -> 아무것도 안 함
  2. sub' = { ...sub, status:'expired', graceUntil:null }; repo.subscriptions.put(sub')
  3. notifier.send({type:'grace.ending', ...})
output: { sub, revoked: LedgerEntry[] }
idempotencyKey: revoke:dunning:{sub.id}:{period.start ISO} / revoke:dunning-all:{sub.id}:{period.start ISO}
```

## [EC:A14] usage_during_grace — (구현 규칙 참고용, 이 모듈에 함수 없음)

```pseudo
policy.dunning.usageDuringGrace 는 usage.check / credits.consume 호출부(webhook.default_handlers
또는 앱 코드)가 sub.status=='past_due' 를 보고 참조한다. lifecycle 은 sub.status 를 정확히
유지하는 것(onPaymentFailed/onGraceExpired/onRecovered) 까지만 책임진다.
```

## [EC:A17] dunning.onRecovered — 유예/최종실패 후 결제 복구

```pseudo
input: { sub, payment, policy, ledger, repo, clock }
steps:
  1. policy.dunning.onRecovery == 'no_regrant':
       sub' = {...sub, status:'active', graceUntil:null}; put; return { sub', grants: [] }
  2. plan = repo.plans.get(sub.planId)
  3. 'regrant_current_period' | 'regrant_all_missed'
     (regrant_all_missed 는 이 구현에서 과거 누락 주기 이력을 별도로 추적하지 않아
      현재 주기 1건으로 단순화됨 — 계약 변경 제안: 다중 누락 주기 백필이 필요하면
      Repo 에 주기 이력 테이블이 필요하다)
     grants += credits.grantForPeriod({ sub:{...sub, status:'active'}, plan, period: sub.currentPeriod,
       payment, policy, ledger, clock })
     # 같은 (sub.id, period.start) 키를 grantForPeriod 가 다시 만들므로 EC:E2/E14 "재지급은
     # 원래 지급과 같은 키" 요구사항이 자동으로 충족된다 (이미 지급됐으면 duplicated=true).
  4. sub' = {...sub, status:'active', graceUntil:null}; repo.subscriptions.put(sub')
output: { sub, grants: GrantResult[] }
```

## [EC:A24] dunning.retryDue / dunning.runRetry — 유예 기간 내 스마트 재시도

```pseudo
# 정책: policy.dunning.retryAttempts (기본 3, 0 = provider 자체 dunning 에만 맡김) ·
#       policy.dunning.retryIntervalHours (기본 [24,72,120], 목록이 retryAttempts 보다 짧으면
#       마지막 값을 반복한다)
#
# 상태 저장: Subscription 에 필드를 추가하지 않는다 (계약 밖) — 대신 repo.outbox 에
# kind='dunning.retry' 항목으로 시도 횟수/예정 시각을 기록한다. usage.flushOutbox 와 같은 패턴
# (packages/usage/{ts,py}/.../flush_outbox).
#
# 항목 id 는 결정적: "dunning-retry-item:{sub.id}:{attempt}" — 재전송된 실패 webhook 이
# onPaymentFailed 를 다시 호출해도 attempt=1 항목을 덮어쓸 뿐 중복 생성되지 않는다.

retryGapHours(attemptNumber, intervals):
  intervals 비어있으면 0
  idx = min(attemptNumber - 1, len(intervals) - 1)
  return intervals[idx]

scheduleRetry(repo, subId, attempt, from, intervals):
  dueAt = from + retryGapHours(attempt, intervals) hours
  repo.outbox.put(OutboxItem{ id: "dunning-retry-item:{subId}:{attempt}", kind: 'dunning.retry',
    payload: { subscriptionId: subId, attempt, dueAt: dueAt.toISOString() },
    status: 'pending', attempts: 0, nextAttemptAt: dueAt, createdAt: from })

retryDue({ repo, clock, limit? }):
  now = clock.now()
  pending = repo.outbox.list({ kind:'dunning.retry', status:'pending' })
  due = pending.filter(item -> item.nextAttemptAt <= now).sortBy(item -> item.nextAttemptAt)
  return limit ? due[:limit] : due
output: OutboxItem[]

runRetry({ item, provider, repo, ledger, policy, notifier, clock, ids? }):
  # 전체를 retryOnVersionConflict 로 감싼다 (EC:K1) — provider.chargeBillingKey 는 실제 네트워크
  # await 라 그 사이 다른 writer(webhook, 다른 tick, 수동 취소)가 이 행을 건드릴 수 있다.
  payload = item.payload   # { subscriptionId, attempt, dueAt }
  attempt(): 
    sub = repo.subscriptions.get(payload.subscriptionId)   # 매 시도마다 새로 읽는다 (EC:K1)
    sub == null or sub.status != 'past_due':
      # 이미 복구됐거나(provider 자체 dunning webhook 이 먼저 성공) 취소/만료됨 — 이 예약은 무효
      item.status='sent'; item.attempts+=1; repo.outbox.put(item)
      return { outcome:'skipped', sub, grants:[] }

    canCharge = provider.capabilities().scheduling == 'self' and sub.billingKey != null
    !canCharge:
      # provider 자체 스케줄(Stripe/Polar/PortOne)이 실제 결제를 주도하고 자기 webhook 으로 결과를
      # 알려준다 — 여기서는 결제를 시도하지 않고 우리 카운터만 진행시켜, provider 재시도가 끝내
      # 회복 못 해도 grace.ending 이 제때 발생하게만 한다.
      item.status='sent'; item.attempts+=1; repo.outbox.put(item)
      attempt < policy.dunning.retryAttempts:
        scheduleRetry(repo, sub.id, attempt+1, clock.now(), policy.dunning.retryIntervalHours)
      return { outcome:'deferred_to_provider', sub, grants:[] }

    plan = repo.plans.get(sub.planId)
    plan == null or plan.prices 비어있음:
      item.status='failed'; item.attempts+=1; repo.outbox.put(item)
      return { outcome:'failed', sub, grants:[] }
    price = plan.prices[0]
    idempotencyKey = "dunning-retry:{sub.id}:{attempt}"   # 버전충돌 재시도해도 같은 키 재사용 (안전)
    item.attempts += 1
    try:
      payment = provider.chargeBillingKey({billingKey:sub.billingKey, amount:price, orderId:idempotencyKey,
                                            customerRef:sub.customerId, idempotencyKey})
    except (버전충돌 아닌 provider 오류): payment = null

    payment != null and payment.status == 'succeeded':
      item.status='sent'; repo.outbox.put(item)
      result = dunning.onRecovered({sub, payment, policy, ledger, repo, clock})   # 기존 EC:A17 경로로 합류
      return { outcome:'recovered', sub: result.sub, grants: result.grants }

    # 실패
    item.status='sent'; repo.outbox.put(item)
    notifier.send({type:'payment.failed', customerId:sub.customerId, payload:{subscriptionId:sub.id, attempt}})
    attempt < policy.dunning.retryAttempts:
      scheduleRetry(repo, sub.id, attempt+1, clock.now(), policy.dunning.retryIntervalHours)
    else:
      # 재시도 소진 — 기존 graceUntil 기반 onGraceExpired 경로가 마무리한다 (여기서 직접 호출하지 않음)
      notifier.send({type:'grace.ending', customerId:sub.customerId, payload:{subscriptionId:sub.id}})
    return { outcome:'failed', sub, grants:[] }

  return retryOnVersionConflict(attempt)
output: { outcome: 'recovered'|'failed'|'skipped'|'deferred_to_provider', sub: Subscription|null, grants: GrantResult[] }
idempotencyKey: dunning-retry:{sub.id}:{attempt} (charge) / dunning-retry-item:{sub.id}:{attempt} (outbox 항목 id)
```

## [EC:F] scheduler.dueSubscriptions / scheduler.tick — Toss/Portone self-scheduling

```pseudo
dueSubscriptions({ repo, clock }):
  now = clock.now()
  return repo.subscriptions.list().filter(s -> s.status=='active' and !s.cancelAtPeriodEnd
                                            and s.billingKey != null and s.currentPeriod.end <= now)

tick({ provider, repo, policy, ledger, clock, ids, notifier? }):
  provider.capabilities().scheduling != 'self': return { charged: [], failed: [] }
  for pendingCancel in repo.subscriptions.list():
    # 해당 provider 의 active, cancelAtPeriodEnd=true, period.end <= now 인 구독만 종료.
    retryOnVersionConflict:
      sub = repo.subscriptions.get(pendingCancel.id)
      # 매 시도마다 같은 조건을 재확인. 취소 철회/새 주기/삭제가 반영되면 skip.
      repo.subscriptions.put({...sub, status:'canceled', cancelAtPeriodEnd:false})
      # billingKey 없이도 종료하며 provider 네트워크 호출은 없다. 재실행은 no-op.
  for dueSub in dueSubscriptions({repo, clock}):
    idempotencyKey = "charge:{dueSub.id}:{dueSub.currentPeriod.end ISO}"
    retryOnVersionConflict:
      sub = repo.subscriptions.get(dueSub.id)
      # 재조회 시 취소/삭제/다른 provider/주기 변경/더 이상 만기 아님이면 skip.
      # 원래 주기의 key 를 유지하여 충돌 재시도가 새 주기를 청구하지 않게 한다.
      plan = repo.plans.get(sub.planId); plan 또는 price 없으면 failed 로 분류하고 skip
      price = plan.prices[0]  # 대표 가격 선택 한계는 계약 변경 제안 #4
      payment = provider.chargeBillingKey({billingKey:sub.billingKey, amount:price,
                    orderId:idempotencyKey, customerRef:sub.customerId, idempotencyKey})
      payment.status == 'succeeded':
        chargedPeriod = core.nextPeriod(sub.currentPeriod, plan.interval, sub.anchorDay,
                                         policy.period.timezone, policy.period.monthEndAnchor)
        result = lifecycle.onRenewalPaid({sub, payment: {...payment, period: chargedPeriod},
                                           policy, ledger, repo, clock}); charged += result.sub
      payment.status == 'failed':
        result = lifecycle.dunning.onPaymentFailed({sub, policy, repo, notifier, clock}); failed += result.sub
      other status: throw PaymentKitError('scheduler_charge_unresolved')
    # provider 예외, 원장/저장소 오류, 충돌 재시도 소진은 호출자에게 전파한다.
    # 결과 불명확을 결제 실패로 바꾸거나 고객에게 연체 알림을 보내지 않는다.
output: { charged: Subscription[], failed: Subscription[] }
idempotencyKey: charge:{sub.id}:{period.end ISO}
```

## period — re-export

```pseudo
lifecycle.period.nextPeriod       = core.nextPeriod        # EC:G1
lifecycle.period.prorationRatio   = core.prorationRatio     # EC:G2
lifecycle.period.periodContaining = core.periodContaining
lifecycle.period.elapsedRatio     = core.elapsedRatio
```

---

## 계약 변경 제안 (구현 중 발견)

1. **anchor 재설정 시 civil day 추출**: upgrade(reset_anchor)/onRenewalPaid 가 "지금 몇 일인가"를
   구해야 하는데 core 는 tz-aware civil day 계산을 공개 API 로 노출하지 않는다 (내부 `_civilPartsInTz`
   만 있음). 지금은 `now.getUTCDate()` 로 대체 — `policy.period.timezone` 이 기본값 UTC 가 아니면
   부정확할 수 있다. core 에 `civilDay(date, tz): number` 공개 추가를 제안한다.
2. **cancel 의 `credits: 'keep_forever'`**: 원장이 append-only(H3) 라 기지급 grant 의 `expiresAt` 을
   사후에 늘릴 방법이 없다. `LedgerKind` 에 만료 연장을 표현할 새 종류(예: `'extend'`, 새 expiresAt
   포함)가 필요하거나, credits 쪽에서 "무만료 grant 재발급 + 구 grant 조기 revoke" 조합으로 흉내내는
   설계가 필요하다. 현재는 cancel 진입 시 `unsupported` 로 부작용 전에 거부한다.
3. **dunning.onRecovery == 'regrant_all_missed'**: 누락된 과거 여러 주기를 백필하려면 Repo 에
   "이 구독이 실제로 결제 완료한 주기 목록" 이력이 있어야 한다. 지금은 현재 주기 1건만 재지급.
4. **scheduler.tick 의 price 선택**: `plan.prices[0]` 고정. 통화/결제수단별 price 선택 규칙(EC:E10)이
   자리잡히면 교체 필요.
5. **dunning.onGraceExpired 의 `revoke_unpaid_period`**: A15 기본값(`grantDuringGrace='defer_until_paid'`)
   에서는 유예 기간 중 새 주기 grant 자체가 안 나가므로, "미결제 주기분 회수" 가 가리킬 grant 가
   없다 — 대신 마지막으로 성공 지급된 이전 주기(`sub.currentPeriod`, 아직 advance 되지 않은 값)의
   grant 를 찾아 잔여분을 회수한다. 그 grant 는 보통 이미 `expiresAt` 으로 자연 소멸했을 것이므로
   (rollover='none' 기본값 기준) 이 경로는 대개 사실상 no-op 이 된다. `grantDuringGrace='grant_anyway'`
   조합에서는 실제로 회수할 grant 가 존재하므로 의미가 생긴다.

### 갱신 부분 실패 복구

`onRenewalPaid` 에서 같은 주기 grant 가 이미 존재하더라도 구독 주기가 이전 주기이고
상태가 active/past_due 이면 구독 저장을 완료한다. 원장 grant 는 재발급하지 않고,
이미 진행한 주기를 되돌리거나 canceled 구독을 재활성화하지 않는다.


## Subscription provider reference boundary

`Subscription.providerRef` / `provider_ref` is nullable for self-scheduled subscriptions:
Toss/PortOne billing keys do not imply a remote subscription ID. Native subscription mutation
(cancel, immediate upgrade/downgrade, reactivate) rejects null with
`subscription_provider_ref_required` before any remote call or subscription mutation.
Self-scheduled paths continue using the local subscription and billing key without inventing
provider references. PostgreSQL forward migration 0007 matches this core contract.

## [EC:M1] [EC:M2] [EC:M3] [EC:M4] backfill — 기존 결제 고객 들이기

```pseudo
input: { rows: BackfillRow[], repo, ledger, providers, clock, ids }
output: { results: [{ row, customerId, status: ok|error, reason, customer, subscription, credits, subscriptionId }], ok, errors }

for row in rows:
   # EC:M2 EC:M3 — every refusal happens before any write; an error row writes nothing
   require customerId, customerRef; provider in providers else provider_not_configured
   credits is null or integer >= 0 else invalid_credits
   planId given -> repo.plans.get(planId) else unknown_plan
   subscriptionRef and billingKey both -> subscription_ref_and_billing_key
   if subscriptionRef or billingKey: planId required (missing_plan_id)
   if subscriptionRef:                                   # native (Stripe, Polar)
      provider.capabilities().nativeSubscriptions else provider_has_no_native_subscriptions
      local = repo.subscriptions.list({ provider, providerRef: subscriptionRef })
      if local: local.customerId == row.customerId else subscription_owned_by_other_customer -> skip
      remote = provider.getSubscription(subscriptionRef)  # status/period/anchor from the provider
      remote.customerId in (customerRef, customerId) else provider_customer_mismatch
      remote.status in (trialing, active, past_due) else subscription_not_live
      new sub: remote status/period/anchorDay/cancelAtPeriodEnd, providerRef, billingKey null
   if billingKey:                                        # self-scheduled (Toss, PortOne)
      not native else billing_key_needs_self_scheduled_provider
      periodStart < periodEnd else invalid_period
      same (customer, provider, billingKey) exists -> skip
      new sub: status active, period from file, anchorDay = periodStart UTC day, providerRef null
   customer: absent -> create (providerRefs [row ref]); ref missing -> add (updated); else skipped
   sub: put with ids.newId(), version 0 (created) unless skipped
   # EC:M4
   credits > 0 -> ledger.append(grant, pool paid, source manual, actor backfill,
                                idempotencyKey "backfill:{customerId}:paid", expiresAt creditsExpireAt)
                  duplicated -> skipped
```

`parseBackfillFile` / `parse_backfill_file`: CSV with a header row or JSON array, columns
`customer_id,email,provider,customer_ref,subscription_ref,plan_id,billing_key,period_start,period_end,credits,credits_expire_at`.
Dates are ISO 8601; a date without a zone is UTC.

## [EC:A26] Self-scheduled renewals store their payment row

```pseudo
tick(): payment = provider.chargeBillingKey(...)          # same idempotency key on retries
        if payment.status == 'succeeded':
            existing = repo.payments.list({ provider, providerRef: payment.providerRef })[0]
            row = { ...payment, id: existing?.id ?? ids.newId(), customerId: sub.customerId,
                    subscriptionId: sub.id, kind: 'subscription', period: chargedPeriod }
            repo.payments.put(row)
            onRenewalPaid({ sub, payment: row, ... })        # grants reference row.id
```

Toss sends no webhook for billing payments, so without this row the renewal could not be refunded
through support.requestRefund and was missing from settlementReport, timeline and
recoverMissingGrants.

## [EC:A27] dunning.onPaymentFailed skips incomplete subscriptions

A subscription that never paid (`incomplete`) has no access to keep: a failed first payment returns
the subscription unchanged, with no grace period, retries or notices.

## [EC:A28] Charge in the subscription's currency

```pseudo
priceForSubscription(plan, sub):
   if sub.currency: return plan.prices.find(p => p.currency == sub.currency) ?? null   # never another currency
   return plan.prices[0] ?? null                                                      # rows written before currency existed
scheduler.tick / dunning.runRetry: price = priceForSubscription(plan, sub); none -> failed, no charge
upgrade (self-scheduled): old/new price = priceForSubscription(...) (new: required, plan_price_missing)
resolvePriceRef(plan, provider, sub.currency): the provider price ref of the same currency first
```

Currency is recorded when the subscription is created: checkout (the captured sale price), backfill
(provider subscription currency, else the row's `currency`, else the plan's only price), in-app
purchases (the matched catalog price), and the Stripe/Polar subscription mappers.


## [EC:A29] [EC:A30] [EC:A31] 자체 스케줄 갱신 루프

```pseudo
tick():
   errors = []
   for due in dueSubscriptions():
      try: renewOne(due)                          # EC:A30 구독 하나의 실패가 루프를 멈추지 않는다
      except err: errors.push({ subscriptionId, code, message })
   return { charged, failed, errors }

renewOne(sub):
   plan = plans.get(sub.scheduledPlanId ?? sub.planId)     # EC:A29 갱신 후 플랜으로 청구 = 지급 플랜
   price = priceForSubscription(plan, sub)                  # EC:A28
   if plan is null or price is null:                        # EC:A31
      notify cs.needs_human { kind: 'plan_price_missing' }
      return onPaymentFailed(sub)                           # dunning: past_due, 유예
   chargedPeriod = nextPeriod(sub.currentPeriod)
   paid = payments(sub).find(succeeded and period.start == chargedPeriod.start)
   if paid: return onRenewalPaid(sub, paid)                 # EC:A30 이미 낸 돈은 다시 청구하지 않는다
   payment = chargeBillingKey(price, key = charge:{sub}:{period.end})
   succeeded -> record payment row, onRenewalPaid
   failed    -> onPaymentFailed
   pending | requires_action | ... -> raise scheduler_charge_unresolved (errors 로 보고, dunning 없음)
```

dunning 재시도(`runRetry`)와 회복(`onRecovered`)도 같은 갱신 후 플랜을 쓴다. 재시도에서 가격이 없으면
`cs.needs_human` 으로 알리고 다음 재시도를 예약한다.

## [EC:A32] 늦게 온 갱신 결제는 취소된 구독을 되살리지 않는다

```pseudo
onRenewalPaid(sub, payment):
   ... grant the paid period ...
   if sub.status in ('canceled', 'expired'): return { sub }   # 상태·기간 그대로
   put { ...sub, planId, scheduledPlanId: null, currentPeriod: period, status: 'active' }
```

## [EC:A33] 구독 통화의 가격만 쓴다

```pseudo
resolvePriceRef(plan, provider, currency):
   if currency:
      price = plan.prices.find(currency) or raise plan_price_missing   # 다른 통화 ref 로 넘어가지 않는다
      return price.ref[provider] ?? plan.id
   return first price with a ref for provider ?? plan.id               # 통화 없는 옛 행

upgrade (self-scheduled): oldPrice = requirePriceForSubscription(oldPlan, sub)   # 없으면 거절, 0 으로 보지 않는다
```

## [EC:A34] [EC:A35] [EC:A36] 자체 스케줄 갱신 청구: (구독, 기간)당 한 번

```pseudo
attempt key: renewal = "charge:<sub>:<period.start ISO>", dunning n = "dunning-retry:<sub>:<period.start ISO>:<n>"
orderId(key) = "ord_" + sha256(key)[0:40]; payment row id = "pay_rn_" + sha256(key)[0:32]

chargeAttempt(key):
   row = payments.get(id(key))
   if row.status == succeeded: return succeeded(row)
   if row.status == failed:    return declined(row, fresh=false)
   if no row: payments.put(pending row: period, amount, providerRef = orderId, raw.attemptKey = key)   # 호출 전에
   try answer = provider.chargeBillingKey(orderId, idempotencyKey = key)
   except ProviderError with 4xx (not 408/409/429): row.status = failed -> declined(fresh)
   except anything else: unresolved (row stays pending)
   row <- answer; succeeded / failed / unresolved

tick (active or past_due, period ended):
   attempts = rows of (sub, nextPeriod)
   succeeded attempt -> onRenewalPaid (no charge)
   pending attempt -> re-drive its key
   no open attempt and past_due -> nothing (dunning owns the next charge)
   else new renewal attempt
   declined (active) -> onPaymentFailed; unresolved -> markUnresolved (past_due + grace once, cs.needs_human once), report error

runRetry (past_due): same attempts; succeeded -> onRenewalPaid (grants nextPeriod, advances); pending -> re-drive;
   else dunning attempt n; unresolved -> item stays pending, later, same key, no failure notice
```


## [EC:A37] [EC:A38] [EC:A39] [EC:A40] [EC:A41] [EC:A42] 시도 리스, 끝난 구독의 늦은 결과, 이전 릴리스 dunning, 연체 중 취소

```pseudo
withAttemptLease(repo, clock, attemptKey, fn):           # EC:A37 — charge-attempt.ts / charge_attempt.py
   op = operations.claim({ key: 'charge-lease:' + attemptKey, payloadHash: 'charge-attempt-lease' })
   if op is null:
      cur = operations.get(key)
      if cur.status == 'in_progress' and stale(cur): operations.put(cur as failed); op = operations.claim(...)
      elif cur has no leaseUntil/unleasedSince: operations.put(cur with result.unleasedSince = now)
   if op is null: return not held                        # caller: chargeAttempt -> { kind: 'in_flight' }
   operations.put(op with result.leaseUntil = now + 10 min)
   try fn() finally operations.put(op as failed)          # 'failed' = released, re-claimable
stale(cur) = leaseUntil <= now, or unleasedSince + 10 min <= now

chargeAttempt = withAttemptLease(key, read row -> create pending -> provider -> write result)

settleAttemptByLookup(provider, row):                     # EC:A38 — never charges
   under the attempt's lease: fresh = payments.get(row.id); if final: return it
   found = provider.getPaymentByOrderId(orderIdOf(fresh))  # Toss GET /v1/payments/orders/{orderId}; PortOne GET /payments/{id}
   found is null -> fresh as failed('order_not_found'); found pending -> null; else fresh with found.status
settleOrphanAttempts (end of every tick): pending attempt rows of ended subs -> settle; succeeded -> onRenewalPaid
   (grants the paid period, sub stays ended, EC:A32) + cs.needs_human 'renewal_settled_after_end' once;
   no answer -> tick error 'renewal_charge_unresolved'

checkLegacyDunning(sub, period) before a NEW charge:      # EC:A39
   for sent retry items 'dunning-retry-item:<sub>:<n>' created at/after sub.currentPeriod.end:
      key = 'dunning-retry:<sub>:<n>' (the orderId a pre-A34 release used); ensure a pending row for it
      settle by lookup: succeeded -> pay `period` with it (no new charge); no answer -> refuse to charge
      ('legacy_dunning_unverified' each tick)

runRetry: sub past_due and cancelAtPeriodEnd -> sub canceled, item sent, no charge   # EC:A40
tick: past_due + cancelAtPeriodEnd + period over -> canceled                         # EC:A40
tick: scheduler's own attempt (renewal key) declines on a past_due sub (fresh) -> onPaymentFailed once  # EC:A41
dunning outbox payload = { subscriptionId, attempt, dueAt } in both kits; Python reads subscription_id too  # EC:A42
```
