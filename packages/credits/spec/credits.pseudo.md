# credits — pseudo spec (source of truth)

모듈 공개 API: docs/ARCHITECTURE.md §3.5 `credits.*`.
담당 EC: B1 B2 B3 B7 B9 B10 B12 B13 B14 B16 B17 A4 A15 A24 (docs/EDGE_CASES.md).

공통: 모든 함수는 `ledger.append` / `ledger.consume` 에 `idempotencyKey` 를 넘긴다.
멱등키 중복 재전송(EC:B12, webhook 재전송 → 이중 지급)은 `LedgerStore.append`/`consume` 이
`idempotency_key UNIQUE` 로 흡수하고 `duplicated=true` 를 돌려주는 것으로 처리한다 —
이 모듈은 항상 결정적 키를 만들어 넘기기만 하면 된다. 별도 섹션을 두지 않고 각 함수에서
키 생성 규칙으로 명시한다.

---

## [EC:B1 B2 B7 A15 B17] grantForPeriod — 주기 구독 크레딧 지급

```pseudo
input: { sub, plan, period, payment, policy, ledger, clock }
steps:
  1. EC:A15 — sub.status == 'past_due' and policy.dunning.grantDuringGrace == 'defer_until_paid':
       return { entry: null, duplicated: false, deferred: true, offset: 0, offsetEntries: [] }   # 지급 보류, 원장 쓰기 없음
     (grantDuringGrace == 'grant_anyway' 는 아래로 진행)
  2. idempotencyKey = "grant:{sub.id}:{period.start.toISOString()}"
  3. amount = plan.creditsPerPeriod   (paid pool, 'grant')
  4. EC:B7/B8 — unitPriceMinor = floor(payment.amount.amountMinor / amount)  (정수 minor 단가, grant 행에 저장)
     remainderMinor = payment.amount.amountMinor - unitPriceMinor*amount
     remainderMinor > 0 이면 소실시키지 않고 entry.reason = "remainder_minor:{n}" 로 남긴다 (분배하지 않음, 감사용 메모).
  5. EC:B1 — expiresAt:
       rollover == 'none'   -> period.end   (주기 말 소멸)
       rollover == 'full'   -> null          (무만료)
       rollover == 'banked' -> period.end   (이 grant 자체는 주기 말 소멸; 이월분은
                                              rolloverOnRenewal 이 다음 주기 grant 로 별도 기록)
  6. EC:B17 — policy.credits.negativeOffset == 'offset_next_grant' 이면, **entry 를 append 하기 전에**
     preGrantAvailable = ledger.balance(sub.customerId, 'paid', clock.now()).available 를 읽어둔다
     (append 후에 읽으면 방금 지급한 grant 금액이 섞여 음수가 가려진다).
  7. pool='paid', source='subscription', reference={subscriptionId, periodStart: period.start, paymentId}
  8. ledger.append(entry) -> {entry, duplicated}
  9. entry가 null이 아니고 duplicated==false 인 경우에만: applyNegativeOffset(preGrantAvailable, entry) 호출
     (아래 [EC:B17] 섹션) -> { offset, offsetEntries }
  10. return { entry, duplicated, deferred: false, offset, offsetEntries }
output: { entry: LedgerEntry|null, duplicated: bool, deferred: bool, offset: int, offsetEntries: LedgerEntry[] }
idempotencyKey: grant:{sub.id}:{period.start ISO}  (offset 행은 offset:{grant idempotencyKey}[:settled])
```

## [EC:B10 B17] topup — 일회성 충전

```pseudo
input: { customerId, payment, credits, policy, ledger, clock }
steps:
  1. idempotencyKey = "topup:{payment.id}"
  2. days = policy.credits.topupExpiryDays
     expiresAt = days is null ? null : clock.now() + days days
  3. unitPriceMinor = floor(payment.amount.amountMinor / credits); remainder 는 grantForPeriod 와 동일 규칙
  4. EC:B17 — grantForPeriod 의 6번과 동일: append 전에 preGrantAvailable 을 읽어둔다.
  5. pool='paid', kind='grant', amount=credits, source='topup', reference={paymentId: payment.id}
  6. ledger.append(entry) -> {entry, duplicated}
  7. entry가 null이 아니고 duplicated==false 인 경우에만: applyNegativeOffset(preGrantAvailable, entry)
output: { entry, duplicated, deferred: false, offset: int, offsetEntries: LedgerEntry[] }
idempotencyKey: topup:{payment.id}
```

## [EC:B17] applyNegativeOffset — 음수 잔액을 다음 지급에서 상계 (grantForPeriod/topup 내부 헬퍼, 공개 API 아님)

```pseudo
# policy.credits.negativeOffset: 'offset_next_grant' (기본) | 'never'
# 'never' 는 그대로 부채를 남긴다 (아무 것도 하지 않고 { offset: 0, offsetEntries: [] } 반환) — B17 케이스는
# "80 지급, 30 은 기존 음수 잔액 상계, 50 사용 가능" 을 타임라인에서 보여주는 것이 목적이다.
#
# 왜 항목이 두 개 필요한가 (하나가 아니라): 음수 잔액은 항상 UNBUCKETED 원장 행(예: A4 clawback
# allow_negative, B4 consume allow_to_floor/allow_unbounded — reference.grantId 없음)으로만 존재한다.
# 방금 만든 grant 는 이미 전액(예: 80)이 자기 버킷에 기록된 상태다 — 아무 것도 안 해도 총합(available)은
# 이미 (기존 음수 + 신규 grant)로 정확하다. 문제는 "버킷 단위" 계산이다: consume() 은 버킷 잔액만 보고
# 끌어 쓰므로, 상계하지 않으면 고객이 이미 진 빚(30)까지 포함해 신규 grant 버킷 전액(80)을 그대로 소비할
# 수 있다 — 총합이 음수로 넘어가도 막히지 않는 구멍. 그래서:
#   - entry A: kind='adjust', amount=-offset, reference={..., grantId: 신규grant.id} → 신규 grant 의
#     버킷을 offset 만큼 깎아 "진짜 쓸 수 있는 만큼"(remainder)만 남긴다.
#   - entry B: kind='adjust', amount=+offset, reference=grantForPeriod/topup 과 동일(grantId 없음,
#     unbucketed) → 기존 부채를 그만큼 되갚아, 다음 지급이 같은 부채를 또 상계하지 않게 한다.
# 두 항목의 합은 0 — 총합(available) 은 변하지 않는다. 오직 "이 grant 버킷에서 실제로 얼마나 쓸 수
# 있는가"만 정정된다.
input: { ledger, policy, preGrantAvailable, customerId, pool, grant: LedgerEntry, source, reference, grantIdempotencyKey }
steps:
  1. policy.credits.negativeOffset != 'offset_next_grant': return { offset: 0, offsetEntries: [] }
  2. preGrantAvailable >= 0 (부채 없음): return { offset: 0, offsetEntries: [] }
  3. debt = -preGrantAvailable
  4. offset = min(debt, grant.amount)
  5. offset <= 0: return { offset: 0, offsetEntries: [] }
  6. ledger.append({ pool, kind:'adjust', amount:-offset, source, reference:{...reference, grantId:grant.id},
       idempotencyKey:"offset:{grantIdempotencyKey}", actor:'system', reason:'negative_balance_offset' })
  7. ledger.append({ pool, kind:'adjust', amount:+offset, source, reference,
       idempotencyKey:"offset:{grantIdempotencyKey}:settled", actor:'system', reason:'negative_balance_offset' })
  8. return { offset, offsetEntries: [entryFrom6, entryFrom7] }
output: { offset: int, offsetEntries: LedgerEntry[] }
idempotencyKey: offset:{grantIdempotencyKey} / offset:{grantIdempotencyKey}:settled
```

## [EC:B16] notifyExpiring — 만료 예정 크레딧 알림

```pseudo
# ⚠ 계약 변경 제안: core NotifyType 에 "크레딧이 곧 만료된다" 는 케이스가 없다.
# 'card.expiring' 는 문구가 "등록된 카드가 만료된다" 로 결제수단 전용이라 재사용하면 고객에게 잘못된
# 안내가 나간다. 새 NotifyType('credits.expiring') 추가는 core/ts/py types 수정이 필요해 이 패키지
# 권한 밖이다 — 그래서 notifier 는 시그니처 호환을 위해 받되 아직 호출하지 않고, pending 목록만
# 반환한다. 호출자가 앱 자체 알림 경로로 pending 을 소비한다.
input: { customerId?, ledger, repo, notifier, policy, clock }
steps:
  1. noticeDays = policy.credits.expiryNoticeDays; null 이면 즉시 { pending: [] } 반환
  2. now = clock.now(); windowEnd = now + noticeDays days; today = now 를 'YYYY-MM-DD' 로 자른 값
  3. customerIds = customerId 지정 시 [customerId], 아니면 repo.customers.list() 전체
  4. for cid in customerIds:
       balance = ledger.balance(cid, 'paid', now)
       for bucket in balance.expiring:   # EC:B14 — 이미 만료된(expiresAt<=now) 버킷은 여기 안 나온다
         bucket.amount <= 0: skip
         bucket.expiresAt < now or bucket.expiresAt > windowEnd: skip
         dedupId = "credits-expiry-notice:{cid}:{bucket.expiresAt.toISOString()}:{today}"
         repo.outbox.get(dedupId) 가 이미 있으면: skip   # EC:B16 — 같은 날 재실행은 스팸 방지, 다음날은 다시 알림
         repo.outbox.put(OutboxItem{ id: dedupId, kind: 'credits.expiry_notice', status: 'sent',
           payload: {customerId: cid, expiresAt, amount: bucket.amount}, attempts: 1,
           nextAttemptAt: now, createdAt: now })
         pending.push({ customerId: cid, expiresAt: bucket.expiresAt, amount: bucket.amount })
output: { pending: { customerId: str, expiresAt: datetime, amount: int }[] }
idempotencyKey (dedup, repo.outbox row id): credits-expiry-notice:{customerId}:{expiresAt ISO}:{day}
```

## [EC:B9] manualGrant / manualRevoke — 관리자 수동 지급·회수

```pseudo
input: { customerId, pool, amount, reason, actor, ledger, clock, idempotencyKey, expiresAt?, reference? }
steps:
  1. reason 과 actor 는 필수 — 없으면 throw (PaymentKitError 'manual_adjust_invalid')
  2. source = 'manual' (고정)
  3. manualGrant  -> kind='grant',  amount=+amount
     manualRevoke -> kind='revoke', amount=-abs(amount)
  4. ledger.append(entry) -> {entry, duplicated}
output: { entry, duplicated, deferred: false }
idempotencyKey: 호출자 제공 (관리 콘솔/CS 티켓 id 등)
```

## grantPromo / grantTrial — 프로모·트라이얼 재화 지급 (B9 과 별도: source 는 promo/trial, 자동 발급 경로)

```pseudo
input: { customerId, amount, ledger, clock, idempotencyKey, expiresAt?, reason?, actor?, reference? }
steps:
  1. grantPromo -> pool='promo', source='promo'
     grantTrial -> pool='trial', source='trial'
  2. ledger.append(entry) -> {entry, duplicated}
output: { entry, duplicated, deferred: false }
idempotencyKey: 호출자 제공
```

## [EC:B3] consume — 소비 순서 매핑 + 소비

```pseudo
input: { customerId, amount, policy, ledger, clock, idempotencyKey, reference?, reason?, actor? }
steps:
  1. poolOrder = map(policy.credits.consumeOrder):
       'expiring_first'          -> ['paid','promo','trial']   # 풀 간 순서. 풀 안에서는 만료 임박 순 (ledger 책임, EC:B3 FIFO)
       'promo_first_then_expiring' -> ['promo','trial','paid']
       'paid_first'               -> ['paid','trial','promo']
  2. ledger.consume({
       customerId, poolOrder, amount, idempotencyKey,
       meta: {...reference, reason, actor}, now: clock.now(),
       negativeBalance: policy.credits.negativeBalance,   # EC:B4 — ledger 가 실제 시행
       negativeFloor: policy.credits.negativeFloor,
     }) -> result
  3. EC:B14 — ledger.consume 은 expiresAt > now 인 grant 만 대상으로 한다 (배치 expireDue 는 부기용).
  4. !result.ok and policy.credits.negativeBalance == 'block':
       throw InsufficientBalanceError(result.shortfall)
  5. return result
output: ConsumeResult { ok, entries, shortfall, duplicated }
idempotencyKey: 호출자 제공 (요청 ID)
```

## [EC:B1 B2] rolloverOnRenewal — 이월 처리

```pseudo
input: { sub, policy, ledger, clock, newPeriod }
steps:
  1. rollover == 'none':
       return { entries: [], banked: 0, expired: 0 }   # 구 grant 는 expiresAt=period.end 로 이미 소멸 예정
  2. rollover == 'full':
       return { entries: [], banked: 0, expired: 0 }   # 구 grant 는 expiresAt=null, 옮길 것 없음
  3. rollover == 'banked':
     a. all = ledger.entries(sub.customerId)  (전체)
     b. previousGrants = all.filter(kind='grant' and pool='paid' and source='subscription'
                                     and reference.subscriptionId==sub.id
                                     and expiresAt != null and expiresAt <= newPeriod.start)
     c. remaining = sum over previousGrants g of:
          max(0, g.amount + sum(e.amount for e in all
                                  if e.kind in ('consume','revoke') and e.reference.grantId == g.id))
     d. remaining <= 0: return { entries: [], banked: 0, expired: 0 }
     e. EC:B2 bankCap — alreadyBanked = sum(e.amount for e in all
                          if e.kind='grant' and pool='paid' and source='rollover'
                          and (e.expiresAt is null or e.expiresAt > now))
        # bankReset='on_renewal' (기본) 은 매 갱신마다 "현재 유효한 이월분" 을 다시 계산하는 이 로직 자체로 충족된다.
        # bankReset='never'/'on_cancel' 은 이월분을 강제로 0 으로 되돌리는 별도 트리거(예: lifecycle.cancel 이
        # credits 를 처리하는 경로)의 문제이며 이 함수 범위 밖 — 계약 변경 제안에 기록.
        capRemaining = bankCap is null ? remaining : max(0, bankCap - alreadyBanked)
        banked = min(remaining, capRemaining)
        expired = remaining - banked
     f. expired > 0:
          append 'expire' entry: pool='paid', amount=-expired, source='rollover',
            reference={subscriptionId, periodStart:newPeriod.start},
            idempotencyKey="rollover-cap:{sub.id}:{newPeriod.start ISO}", reason='bank_cap_exceeded'
     g. banked > 0:
          append 'grant' entry: pool='paid', amount=banked, source='rollover',
            expiresAt=newPeriod.end,
            reference={subscriptionId, periodStart:newPeriod.start},
            idempotencyKey="rollover:{sub.id}:{newPeriod.start ISO}"
output: { entries: LedgerEntry[], banked: int, expired: int }
idempotencyKey: rollover:{sub.id}:{newPeriod.start ISO} (grant) / rollover-cap:{sub.id}:{newPeriod.start ISO} (cap 초과분 expire)
```

## [EC:A4 B13] clawback — 회수

```pseudo
input: { customerId, amount, policy, ledger, clock, reason, reference, actor, idempotencyKey, shortfall }
  # shortfall: ClawbackShortfall = 'clamp_to_zero' | 'allow_negative' | 'deny_downgrade'  (EC:A4 의 정책 값 그대로)
  # EC:B13 (환불 회수 shortfall, RevokeShortfall: clamp_and_reduce_refund/clamp_to_zero/allow_negative) 는
  #   refund 모듈이 'clamp_and_reduce_refund' 를 "환불액을 줄이는" 자기 책임으로 먼저 처리한 뒤,
  #   실제로 회수할 금액을 이 함수에 'clamp_to_zero' 또는 'allow_negative' 로 넘기는 것을 전제로 한다.
  #   (계약 변경 제안: RevokeShortfall 전용 분기를 원하면 이 함수에 union 타입 확장 필요)
steps:
  1. balance = ledger.balance(customerId, 'paid', clock.now())
  2. available < amount:
       shortfall == 'clamp_to_zero'   -> revokeAmount = max(0, available); shortfallAmount = amount - revokeAmount
       shortfall == 'allow_negative'  -> revokeAmount = amount; shortfallAmount = 0   # 잔액 음수 허용, 다음 지급에서 상계
       shortfall == 'deny_downgrade'  -> throw InsufficientBalanceError(amount - available)
     else: revokeAmount = amount; shortfallAmount = 0
  3. revokeAmount <= 0: return { revoked: 0, shortfall: shortfallAmount, entry: null, duplicated: false }
  4. source = idempotencyKey.startsWith('revoke:downgrade:') ? 'downgrade'
            : idempotencyKey.startsWith('revoke:refund:')    ? 'refund'
            : 'manual'
  5. ledger.append({ pool:'paid', kind:'revoke', amount:-revokeAmount, source, reference, idempotencyKey, actor, reason })
output: { revoked: int, shortfall: int, entry: LedgerEntry|null, duplicated: bool }
idempotencyKey: 호출자 제공. 표준 규약(§7): revoke:downgrade:{sub.id}:{period.start ISO} / revoke:refund:{refund.id}
```

## [EC:B14] expireDue — 만료 부기(bookkeeping)

```pseudo
input: { ledger, clock, customerId }
steps:
  1. now = clock.now()
  2. all = ledger.entries(customerId)
  3. dueGrants = all.filter(kind='grant' and expiresAt != null and expiresAt <= now)
     # ledger.consume/balance 는 이미 expiresAt > now 조건으로 필터해 잔액 계산에서 제외한다 (B14).
     # 이 함수는 감사 목적의 'expire' 행을 남기는 정리 배치일 뿐, 잔액에 영향 없음.
  4. for g in dueGrants:
       used = sum(e.amount for e in all if e.kind in ('consume','revoke') and e.reference.grantId == g.id)
       remaining = max(0, g.amount + used)
       remaining <= 0: skip
       append 'expire' entry: pool=g.pool, amount=-remaining, source=g.source,
         reference={...g.reference, grantId: g.id}, idempotencyKey="expire:{g.id}"
output: { entries: LedgerEntry[] }
idempotencyKey: expire:{grantId}
```

---

## [EC:L5] grantForPeriod / topup / clawback / consume — correlationId propagation

Every write path here accepts an optional `correlationId?: string`, for callers that did NOT
already go through `webhook.process`'s own ledger-wrapping (`packages/webhook/{ts,py}/src/
correlation.*` — `withCorrelationId(ledger, id)`, which pre-scopes the `ledger` dep before calling
into credits). This is the "direct call" path — e.g. an app-driven `grantForPeriod` from a
scheduler tick, or `cs.regrant` threading its own `correlationId`.

```pseudo
# grantForPeriod / topup — the shared `reference` local var (already built once, reused for both
# the grant append and the EC:B17 offset entries) gets correlationId merged in at construction:
reference = {subscriptionId, periodStart, paymentId, ...(correlationId ? {correlationId} : {})}   # grantForPeriod
reference = {paymentId, ...(correlationId ? {correlationId} : {})}                                 # topup

# clawback — `reference` is already a caller-supplied param (unlike grantForPeriod/topup which
# build it fresh); correlationId is merged in only if the caller's reference doesn't already carry
# one (a caller-set value always wins — same "never overwrite" rule as webhook's own decorator):
ledger.append({..., reference: {...reference, correlationId: reference.correlationId ?? correlationId}, ...})

# consume — merged into `meta` (consume's ConsumeInput.meta IS a LedgerReference), same
# never-overwrite rule:
meta: {...reference, reason, actor, correlationId: reference.correlationId ?? correlationId}
```

**계약 변경 제안 아님, 구현 갭 발견 (core, 수정하지 않음)**: `InMemoryLedger.consume()`
(`packages/core/{ts,py}/src/memory.*`) rebuilds each written entry's `reference` from a fixed field
whitelist (`subscriptionId`/`periodStart`/`paymentId`/`caseId`/`refundId`/`grantId`) and does **not**
copy `meta.correlationId` through to the stored `LedgerEntry.reference` — so a `consume()` call's
correlationId reaches `ConsumeInput.meta` correctly (verified) but is silently dropped before it is
persisted by the in-memory (and, if it shares this code path, likely the Postgres) implementation.
`grantForPeriod`/`topup`/`clawback` are unaffected since they call `ledger.append()` directly, which
stores whatever `reference` it is given verbatim. Tests for `consume()`'s EC:L5 behavior therefore
assert against a spy `LedgerStore` (what `credits.consume()` hands to `ledger.consume()`), not
against `InMemoryLedger.entries()` — see `packages/credits/{ts,py}/test*/consume.test.ts` /
`test_consume.py` for the full explanation. core owner should fix `consume()`'s reference
construction to copy `meta.correlationId` through, the same way `append()` already passes any
`reference` field through untouched.

---

## 계약 의존성 메모 (구현 시 확인 필요)

- 위 rollover/clawback/expireDue 는 `LedgerStore.consume()` 이 실제로 소비한 각 원장 행에
  `reference.grantId` 를 채워 grant 단위로 추적 가능하다고 가정한다 (즉 한 번의 consume 호출이
  여러 grant 에서 끌어오면 grant 별로 별도 LedgerEntry 를 남긴다 — `ConsumeResult.entries` 가
  배열인 것과 일치). core 의 실제 `InMemoryLedger`/Postgres 구현이 이 가정과 다르면
  rollover/expireDue 의 "remaining" 계산이 부정확해진다. **core 담당에게 확인 필요.**
- **[EC:B16] 계약 변경 제안 (막힘, 우회하지 않음)**: `notifyExpiring` 이 실제로 알림을 보내려면
  core `NotifyType` 에 크레딧 만료 전용 케이스(예: `'credits.expiring'`)가 필요하다. 기존
  `'card.expiring'` 템플릿 문구("Your card on file expires…")는 결제 카드 전용이라 크레딧 만료에
  재사용하면 고객에게 틀린 메시지가 나간다. `packages/core/ts/src/types.ts` `NotifyType` /
  `packages/notify/{ts,py}` `templates` 확장이 필요 — core 는 이 작업 범위 밖(수정 금지)이라
  `notifyExpiring` 은 `pending` 만 반환하고 notifier 는 시그니처 호환용으로만 받는다.
- **[EC:A24] core `policy.ts` 발견 (버그, 수정하지 않음)**: `packages/core/ts/src/policy.ts`
  `validatePolicy` 의 제네릭 `walk()` 는 배열 필드(`dunning.retryIntervalHours` 등)를 일반 객체처럼
  `DEFAULT_POLICY` 배열의 길이(3)만큼 인덱스별로 순회해 `Object.keys` 비교한다. 그 결과
  `resolvePolicy({ dunning: { retryIntervalHours: [24] } })` 처럼 **DEFAULT 보다 짧은 배열**을 주면
  항상 `"retryIntervalHours.1: missing"` 류로 검증이 실패한다 — 그런데 A24 자체의 문서화된 의미는
  "retryIntervalHours 가 retryAttempts 보다 짧아도 된다(마지막 값 반복)" 이므로, `retryAttempts=3,
  retryIntervalHours=[24]` 같은 정상 설정을 TS `resolvePolicy` 가 거부하는 셈이다 (py 쪽
  `policy.py` 는 이 문제가 없다 — `_build` 가 리스트 필드를 길이 검증 없이 그대로 대입한다,
  비대칭). core 소유가 아니라 고치지 않았다 — 테스트는 `resolvePolicy()` 로 유효한 기본 정책을
  만든 뒤 `{...base, dunning: {...base.dunning, retryIntervalHours: [...]}}` 로 검증을 우회해
  런타임 동작만 확인했다 (`packages/lifecycle/ts/test/dunning.test.ts` 의 `dunningPolicy` 헬퍼).
