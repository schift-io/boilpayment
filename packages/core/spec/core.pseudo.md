# core — spec (source of truth)

이 문서는 `packages/core` 의 소스 오브 트루스다. 각 섹션은 `docs/EDGE_CASES.md` 의 같은
ID 를 가리키며, 구현(`ts/src/*`, `py/src/boilpayment_core/*`)은 이 섹션을 주석으로
인용한다 (`// EC:B5` / `# EC:B5`).

types.ts / types.py 는 이 패키지의 계약이며 수정하지 않는다. 여기서는 `LedgerStore`,
`Clock`, `Period` 관련 함수의 **구현 알고리즘**만 정의한다.

---

## Policy configuration boundary

- Resolved policies own all nested values; neither another resolved policy nor caller-owned
  retry arrays may alter them. Serialized Python policy snapshots also own their arrays.
- Validate boolean values without truthiness coercion. Validate numeric policy values as
  integers within the shared TypeScript/Python safe range, respecting the schema's nullable
  fields and numeric bounds. In particular, CS authority limits are nonnegative, fraud
  windows are positive, and retry intervals contain only positive integers.
- Optional credit conversion is null or a complete `{unit, creditsPerUnit}` object.
  Invalid policy shapes and values raise `PolicyValidationError` before rules execute.
- Unknown configuration keys are rejected, including nested keys; Python accepts the
  documented snake_case and camelCase spellings. `refund.annualMethod=deny_after_days`
  requires a non-null `refund.annualDenyAfterDays` threshold (zero is valid).

## [EC:B5] atomic consume

```pseudo
consume(input: ConsumeInput) -> ConsumeResult:
  # 고객 단위 락 안에서 전부 수행 (transaction()). 중간 상태가 외부에 보이지 않는다.
  with transaction(input.customerId):
    if consumeResults[input.idempotencyKey] exists:      # EC:B12
      return { ...cached, duplicated: true }

    plan = []                # [{pool, signedAmount, grantId|null}]
    remaining = input.amount

    for pool in input.poolOrder:                          # EC:B3 순서 1/2
      if remaining <= 0: break
      buckets = grantBucketsFor(input.customerId, pool)
        .filter(b => b.expiresAt == null or b.expiresAt > input.now)   # EC:B14
        .filter(b => b.remaining > 0)
        .sortBy(b => b.expiresAt ?? +Infinity)              # EC:B3 순서 2/2: soonest-expiry-first, null last
      for bucket in buckets:
        if remaining <= 0: break
        draw = min(bucket.remaining, remaining)
        if draw > 0:
          plan.append({ pool, amount: -draw, grantId: bucket.id })
          remaining -= draw

    (ok, shortfall) = applyNegativeBalancePolicy(remaining, plan, input)   # EC:B4, 아래 섹션

    if not ok:
      result = { ok: false, entries: [], shortfall, duplicated: false }
      consumeResults[input.idempotencyKey] = result
      return result

    entries = []
    for i, step in enumerate(plan):
      # 각 원장 행은 고유 멱등키를 가진다 (append() 의 UNIQUE 제약, EC:B12).
      { entry } = append({
        customerId: input.customerId, pool: step.pool, kind: 'consume', amount: step.amount,
        source: 'usage', reference: { ...input.meta, grantId: step.grantId },
        idempotencyKey: f"{input.idempotencyKey}#{i}", actor: input.actor, reason: input.reason,
      })
      entries.append(entry)

    result = { ok: true, entries, shortfall: 0, duplicated: false }
    consumeResults[input.idempotencyKey] = result
    return result
```

- 원자성: InMemory 구현은 고객별 뮤텍스(`transaction`)로 직렬화한다. Postgres 구현(schema-postgres)은
  `SELECT ... FOR UPDATE` 또는 `balance_version` optimistic lock + 단일 트랜잭션으로 대체한다(같은 계약).
- **멱등키**: `consume()` 호출 전체는 `input.idempotencyKey` 로 캐시된다(재호출 시 `duplicated=true`,
  같은 `entries`/`ok`/`shortfall` 반환). 호출이 쓰는 개별 원장 행은 `{idempotencyKey}#{i}` 로 append UNIQUE 제약을 만족시킨다.

---

## [EC:B14] expiry filter at consume time

```pseudo
grantBucketsFor(customerId, pool?) -> Map<grantId, {pool, expiresAt, remaining}>:
  buckets = {}
  for entry in ledgerEntriesFor(customerId):
    if entry.kind == 'grant':
      buckets[entry.id] = { pool: entry.pool, expiresAt: entry.expiresAt, remaining: entry.amount }
  for entry in ledgerEntriesFor(customerId):
    if entry.kind == 'grant': continue
    if entry.reference.grantId in buckets:
      buckets[entry.reference.grantId].remaining += entry.amount   # consume/revoke/hold/release/adjust 는 signed
  return pool ? filter(buckets, b => b.pool == pool) : buckets
```

- **만료 판정은 소비 시점의 `now` 로만** 한다 (`expiresAt > now`). 배치(`credits.expire_due`)는 정리용일
  뿐이며 만료 크레딧이 소비되는 것을 막는 유일한 게이트는 이 필터다.
- `balance()` 도 같은 필터를 쓴다: `expiresAt <= now` 인 버킷은 `available`/`expiring` 에서 제외한다.

---

## [EC:B3] consume order — expiring_first / promo_first_then_expiring / paid_first

```pseudo
# credits 모듈(다른 담당)이 policy.credits.consumeOrder 를 poolOrder 로 번역해 ledger.consume() 에 넘긴다.
# ledger.consume() 자신은 poolOrder 를 있는 그대로 순회 + 풀 내부 expiring-first 만 안다 (위 EC:B5 참고).
translateConsumeOrder(policy) -> Pool[]:
  match policy.credits.consumeOrder:
    'expiring_first':            return ['paid', 'promo', 'trial']   # 풀 간 우선순위 없음 후보 — 진짜 교차 풀
                                                                       # expiry 정렬이 필요하면 credits 모듈이
                                                                       # ledger.entries()+append() 로 직접 구현한다.
    'promo_first_then_expiring': return ['promo', 'trial', 'paid']   # 실제 매핑은 credits/spec/credits.pseudo.md [EC:B3] 가 원본
    'paid_first':                return ['paid', 'trial', 'promo']
```

- 이 함수는 credits 모듈의 책임이며 core 는 `poolOrder: Pool[]` 만 받는다 (계약 변경 제안 아님 —
  `docs/ARCHITECTURE.md` §3.5 `credits.consume` 시그니처가 이미 이렇게 되어 있음).

---

## [EC:B4] negative balance policy

```pseudo
applyNegativeBalancePolicy(remaining, plan, input) -> (ok: bool, shortfall: int):
  if remaining <= 0:
    return (true, 0)

  overflowPool = last(input.poolOrder) ?? 'paid'

  match input.negativeBalance:
    'block':
      return (false, remaining)          # entries 는 전혀 쓰지 않는다

    'allow_unbounded':
      plan.append({ pool: overflowPool, amount: -remaining, grantId: null })   # grantId 없음 = 버킷 밖 조정
      return (true, 0)

    'allow_to_floor':
      currentTotal = balance(input.customerId, now=input.now).available   # 버킷 소진 후 잔액(이미 0에 근접)
      room = currentTotal - input.negativeFloor       # 바닥까지 남은 여유 (floor 는 <= 0)
      allowed = max(0, room)
      if remaining <= allowed:
        plan.append({ pool: overflowPool, amount: -remaining, grantId: null })
        return (true, 0)
      else:
        return (false, remaining - allowed)           # 바닥을 넘는 초과분만 shortfall
```

- `allow_to_floor` 는 **바닥을 넘기면 전체 거절**한다(부분 소비 없음) — `block` 과 동일하게 원자적.
  다른 해석(바닥까지만 부분 이행)이 필요하면 정책 세분화가 필요하다 → 계약 변경 제안 후보로 아래 "계약
  변경 제안"에 기록.
- `grantId: null` 인 consume 행은 특정 grant 버킷에 귀속되지 않는 "초과 인출"이며 만료 대상이 아니다
  (버킷이 없으므로).

---

## [EC:B12] idempotent append

```pseudo
append(entry: NewLedgerEntry) -> AppendResult:
  existing = byIdempotencyKey[entry.idempotencyKey]
  if existing exists:
    return { entry: existing, duplicated: true }     # webhook 재전송 등 재시도는 no-op
  row = { ...entry, id: newId(), createdAt: now() }
  ledgerEntriesFor(entry.customerId).push(row)
  byIdempotencyKey[entry.idempotencyKey] = row
  return { entry: row, duplicated: false }
```

- `idempotencyKey` 는 원장 전체에서 UNIQUE (Postgres 구현은 유니크 인덱스로 강제, 여기서는 Map 으로 강제).
- 멱등키 규약은 `docs/ARCHITECTURE.md` §7 표를 따른다 (`grant:{subscription_id}:{period_start}` 등) —
  core 는 키를 생성하지 않고 호출자가 준다.

---

## [EC:G1] next_period — month-end anchor

```pseudo
nextPeriod(period, interval, anchorDay, tz, monthEndAnchor) -> Period:
  end = civilPartsInTz(period.end, tz)                # {year, month, day, hour, minute, second, ms}
  effectiveDay = (monthEndAnchor == 'clamp_permanently') ? end.day : anchorDay
  monthsToAdd = (interval == 'year') ? 12 : 1
  targetIndex = (end.month - 1) + monthsToAdd
  targetYear  = end.year + floor(targetIndex / 12)
  targetMonth = (targetIndex mod 12) + 1
  day = min(effectiveDay, daysInMonth(targetYear, targetMonth))
  newEnd = civilToUtc({ year: targetYear, month: targetMonth, day,
                         hour: end.hour, minute: end.minute, second: end.second, ms: end.ms }, tz)
  return { start: period.end, end: newEnd }
```

- **`clamp_keep_original_day`**: 매 주기마다 원래 `anchorDay` 로 다시 시도한다. 짧은 달에서 잘렸어도
  다음달이 그 날짜를 수용하면 원래 자리로 돌아간다.
  예: `anchorDay=31`, 2026-01-31 → (Feb, 28일뿐) → 2026-02-28 → (Mar, 31일 있음) → **2026-03-31**.
- **`clamp_permanently`**: 한 번 잘리면 그 잘린 날짜가 이후 영구 기준일이 된다. 이 상태는 별도 필드 없이
  **직전 `period.end` 의 day-of-month 에서 그대로 유도**한다(무상태 재귀).
  예: 2026-01-31 → 2026-02-28 → (Mar, day=28 유지) → **2026-03-28**.
- `interval='year'` 는 12개월을 더하는 것으로 처리 — 월 자체는 유지되므로 매년 같은 달, 같은
  (혹은 클램프된) 일자로 갱신된다. 윤년의 2/29 앵커는 `daysInMonth` 클램프로 자연히 처리(EC:G5).

```pseudo
periodContaining(anchorStart, interval, now, anchorDay, tz, monthEndAnchor) -> Period:
  period = nextPeriod({ start: anchorStart, end: anchorStart }, interval, anchorDay, tz, monthEndAnchor)
  while period.end <= now:
    period = nextPeriod(period, interval, anchorDay, tz, monthEndAnchor)
  return period
```

- `anchorStart` 이전 시각의 `now` 는 지원하지 않는다(구독은 생성 이후에만 존재).
- 반복 횟수는 최대 100,000 으로 캡핑 — 초과 시 에러 (입력 오류 방어용, 정상 사용에서는 도달하지 않음).

---

## [EC:G2] proration ratio

```pseudo
daysInPeriod(period) -> float:
  return (period.end - period.start) / 1_day

prorationRatio(period, now, denominator) -> float in [0,1]:   # "남은" 비율
  totalDays = (denominator == 'fixed_30') ? 30 : daysInPeriod(period)
  if totalDays <= 0: return 0
  remainingDays = (period.end - now) / 1_day
  return clamp(remainingDays / totalDays, 0, 1)

elapsedRatio(period, now, denominator) -> float in [0,1]:
  return 1 - prorationRatio(period, now, denominator)
```

- `policy.proration.denominator`:
  **`actual_days_in_period`** — 분모는 해당 주기의 실제 일수(윤년·짧은 달 반영, EC:G5).
  `fixed_30` — 항상 30일 분모(주기 실제 길이 무관, 단순화용).
- 업그레이드/다운그레이드 차액 계산(`credits.rollover`, `lifecycle.upgrade` 등)은 이 두 함수 중 하나를
  가져다 쓴다.

---

## [EC:G3] UTC storage

- `Clock.now()`, `Period.start/end`, `LedgerEntry.createdAt`, `Subscription.currentPeriod` 등 시각을
  다루는 모든 필드는 **UTC 인스턴트**(TS `Date`, Py `datetime` naive-UTC 또는 tz-aware UTC)로 저장·전달한다.
- 타임존(`policy.period.timezone`)은 **월/일 경계 계산에만** 쓰인다 — `period.ts`/`period.py` 의
  `civilPartsInTz`/`civilToUtc` 두 헬퍼가 유일한 tz 진입점이다. 그 외 코드는 tz 를 모른다.
- DST 경계(EC:G3)는 civil-time ↔ UTC 왕복 변환(반복 수렴, 최대 3회 조정)으로 흡수한다. 표시(포맷팅)는
  이 패키지 밖(앱/알림) 책임.

---

## [EC:G4] Clock DI

```pseudo
interface Clock: now() -> DateTime

class SystemClock implements Clock:
  now() -> return wall-clock UTC now

class FixedClock implements Clock:
  constructor(date): current = date
  now() -> return current
  advance(ms): current = current + ms   # 테스트에서 시간 이동
```

- **모든** 모듈 함수는 `clock` 을 인자로 받는다(전역 `Date.now()`/`datetime.now()` 직접 호출 금지, core
  자체의 `SystemClock`/`FixedClock` 내부 구현은 예외 — 그게 이 규칙의 구현체이므로).
  `LedgerStore.append()` 의 `createdAt` 은 예외적으로 wall-clock 을 쓴다(계약 변경 제안 참고).

---

## [EC:J1 J2 J3 J4 J5] runIdempotent — 연산 레벨 멱등성

EDGE_CASES.md §J. 원장 append 의 `idempotency_key` UNIQUE (EC:B12) 는 "이 정확한 append 를 두 번
쓰지 않는다" 만 보장한다. `lifecycle.upgrade` 처럼 재시도마다 새 grant id·새 idempotency key(예:
`clock.now()` 기반)를 만드는 연산은 B12 만으로 멱등하지 않다 — 이 계층이 그 위에 앉는다.

```pseudo
type Operation:
  id: string        # == key (Table<T> 계약상 id 필드 필요)
  key: string        # 호출자가 주거나 EC:J5 기본 규칙으로 유도한 idempotency key
  kind: string        # 'lifecycle.upgrade' 같은 연산 이름 — 디버깅/관측용, 판정에는 안 쓴다
  payloadHash: string  # sha256(stableStringify(payload))
  status: 'in_progress' | 'done' | 'failed'
  result: JSON | null  # status=='done' 일 때만; Date 필드는 ISO 문자열로 직렬화되어 있다
  error: string | null
  createdAt: DateTime
  completedAt: DateTime | null

Repo.operations: OperationTable extends Table<Operation>
  claim(candidate: Operation) -> Operation | null:
    # Atomic: absent key inserts in_progress (attempts=1); matching failed key transitions
    # to in_progress, clears result/error/completedAt and increments attempts.
    # Preserve original createdAt/kind. Every other state or payload mismatch returns null.
    # In-memory: no suspension between check and write. PostgreSQL: conditional UPSERT.

runIdempotent({repo, key, kind, payload, clock, fn, serialize?, deserialize?}) -> {result, replayed: bool}:
  payloadHash = sha256(stableStringify(payload))
  claimed = repo.operations.claim({id: key, key, kind, payloadHash, status: 'in_progress',
    result: null, error: null, createdAt: clock.now(), completedAt: null, attempts: 1})
  if claimed == null:
    existing = repo.operations.get(key)
    if existing != null and existing.payloadHash != payloadHash:
      raise PaymentKitError('idempotency key reused with a different payload', 'idempotency_key_reused')
    if existing != null and existing.status == 'done':
      repo.operations.put({...existing, attempts: existing.attempts + 1})
      return {result: deserialize(existing.result), replayed: true}
    raise PaymentKitError('operation already in progress', 'idempotency_in_progress')
  try:
    result = fn()
    repo.operations.put({ ...claimed, status: 'done', result: serialize(result), completedAt: clock.now() })
    return { result, replayed: false }
  except err:
    repo.operations.put({ ...claimed, status: 'failed', error: str(err), completedAt: clock.now() })
    raise err
```

- **직렬화 전략**: `result` 는 JSON 이어야 한다. `LedgerStore` 에 `get(id)` 가 없어(원장 append 결과
  LedgerEntry 를 나중에 id 로 재조회할 방법이 없음) "재조회로 대체" 방식은 grant/clawback/revoke 결과에
  적용 불가능하다 — 그래서 **모든 호출부가 재조회가 아니라 결과 자체를 직렬화**하는 한 가지 전략으로
  통일한다. `serializeSubscription`/`serializeRefund`/`serializeLedgerEntry`/`serializeCsCase` (+ 대응
  deserialize) 가 Date ↔ ISO 문자열 변환을 담당하고, 각 호출부는 이걸 조합해 자기 결과 타입의
  serialize/deserialize 쌍을 만든다.
- **EC:J4** — 보존 기간(기본 7일)은 v0 에서 문서화만 하고 강제하지 않는다(정리 배치 없음). `failed`
  상태는 보존 기간과 무관하게 즉시 재실행 가능.
- **EC:J5 키 유도** — 이 함수 자체는 키를 유도하지 않는다(호출자가 `key` 를 전달). 각 모듈이
  `idempotencyKey` 를 optional 로 받고, 없으면 EDGE_CASES.md §J J5 표의 규칙으로 결정적 키를 만든다.
  **`clock.now()`/`ids.newId()` 를 키에 섞지 않는다** — 그러면 재시도마다 키가 달라져 J1 이 깨진다.
- payload 로는 그 연산의 **의미 있는 입력만** 넣는다(예: upgrade 는 `{subId, newPlanId, periodStart}`)
  — `clock`/`ledger`/`repo` 같은 DI 객체는 당연히 payload 에서 제외.

---

## [EC:L1] Logger DI + provider.request 로깅

`Logger`/`LogEntry`/`LogLevel` 은 types.ts/py 에, 구현체(`NoopLogger`/`BaseLogger`/`ConsoleLogger`/
`CollectingLogger`)와 `redact()` 는 logger.ts/py 에 있다. `Deps.logger` 는 optional — 안 주면
`NoopLogger` 로 폴백해 기존 호출부가 하나도 깨지지 않는다 (docs/EDGE_CASES.md §L).

```pseudo
interface Logger:
  log(entry: {level, event, at?: DateTime, ...fields}) -> Promise<void>

# redact() 는 BaseLogger.log() 안에서 호출된다 — call site 가 아니다. 그래서 "redact 호출을
# 깜빡함" 이 구조적으로 불가능하다: NoopLogger 는 애초에 아무것도 emit 하지 않고, Console/
# Collecting/Postgres 는 전부 BaseLogger 를 상속해 write() 를 받기 전에 이미 스크럽되어 있다.
abstract class BaseLogger implements Logger:
  async log(entry):
    redacted = redact(entry)          # EC:L2
    redacted.at = entry.at ?? now()
    await this.write(redacted)
  abstract write(entry): Promise<void> | void
```

provider 어댑터(toss/portone/polar 의 `request()`, stripe 의 SDK `on('response')` 훅)는 매 HTTP
호출마다 정확히 한 번 `provider.request` 이벤트를 로깅한다 — method/path/status/durationMs/
provider/(있으면) correlationId·providerErrorCode. 바디는 call site 가 그대로 넘기고, redact 는
Logger 구현체가 담당한다(위 구조). `Authorization`/시크릿 헤더는 애초에 이벤트에 넣지 않는다
(redact 대상에도 있지만 방어가 이중이 되도록).

## [EC:L2] redact() — 민감 키 목록 + PAN 마스킹

```pseudo
REDACT_KEYS (정규화: lower-case, '_'/'-' 제거 후 비교) = {
  customerIdentityNumber, cardNumber, cardPassword, customerBirthday,
  secretKey, apiKey, apiSecret, accessToken, authorization, webhookSecret,
  refundReceiveAccount,
}
MASK_KEYS = { billingKey }   # 지우지 않고 마스킹 — CS 가 같은 billingKey 로 요청들을 상관관계 지어야 함

redact(value):
  if value is Date: return copy(value)
  if value is list: return [redact(v) for v in value]
  if value is string: return maskPansInString(value)   # 13-19자리 숫자 런 → 앞6/뒤4만 남기고 마스킹
  if value is not dict: return value   # number/bool 등
  for k, v in value.items():
    nk = normalize(k)
    if nk in REDACT_KEYS: out[k] = '[redacted]'
    elif nk in MASK_KEYS: out[k] = maskGeneric(v) if v is string else '[redacted]'
    else: out[k] = redact(v)   # 재귀 — 중첩 객체 전부 스캔
  return out
```

PAN 마스킹은 키 이름과 무관하게 **모든 문자열 값**에 적용된다 — `cardNumber` 로 안 불리는 필드(예:
raw provider 응답의 다른 키) 안에 카드번호가 섞여 있어도 잡는다. `docs/EDGE_CASES.md` §L2 에 이
목록의 최종 판본이 있다 — 새 민감 필드가 생기면 거기부터 갱신.

## [EC:L5] correlationId 전파

provider `request()` 호출부는 이미 갖고 있는 caller-supplied 값(대개 `idempotencyKey`)을
`correlationId` 로 로그에 싣는다 — 새 필드를 `PaymentProvider` 공개 인터페이스에 추가하지 않는다
(그러면 lifecycle/refund/credits/webhook/cs 전부가 깨진다). `idempotencyKey` 가 없는 조회성 호출
(`getPayment`/`listPayments` 등)은 기본적으로 `correlationId` 없이 로깅된다.

**(2026-09-09 갱신)** webhook 수신부터 원장 append 까지의 스레딩은 `packages/webhook`
(`webhook.receive`가 mint, `webhook.process`가 스레드, `defaultHandlers`가 `ledger` 를 데코레이터로
감싸 lifecycle/credits/refund/cs 를 안 건드리고 커버)과 `packages/providers/*`(duck-typed
`withCorrelationId(id)` — `PaymentProvider` 인터페이스 무변경)로 대부분 구현됐다. `LedgerReference`
에 `correlationId?` 필드가 추가된 것이 이 작업의 유일한 core 변경. 자세한 설계는
`packages/webhook/spec/webhook.pseudo.md` [EC:L5] · `docs/EDGE_CASES.md` §L5 참고.

---

## 계약 변경 제안 (수정 안 함, 기록만)

- **(2026-09-09 해소)** `InMemoryLedger.append()` 가 `createdAt` 을 주입된 `Clock` 이 아니라 벽시계로
  찍던 문제 — `refund.evaluate` FINDINGS#1 · dispute 회귀 테스트 · `cs.timeline` 3회 독립 발견 — 를
  `InMemoryLedger(ids, clock?)` 로 Clock 을 생성자에서 선택 주입받게 고쳐 해소했다(기본값은 여전히
  벽시계라 기존 `new InMemoryLedger(ids)` 호출부는 안 깨진다).
- **(2026-09-09 해소)** `LedgerStore.balance(customerId, pool?, now?)` 의 `now` 를 **필수**로 올렸다
  (`balance(customerId, pool: Pool | undefined, now: Date)` — py는
  `balance(self, customer_id, pool, now)`, 둘 다 기본값 없음). 앞서 이 항목은 "호출부에
  `packages/cs` 가 다수 포함돼 있어 그쪽을 건드리지 않고는 끝낼 수 없다"고 미뤄졌었으나, 이후
  `packages/cs`·`packages/lifecycle`(및 그 연쇄로 `packages/credits`·`packages/refund`·
  `packages/usage`)의 `balance(` 호출 줄만 표면적으로 고치는 것을 명시적으로 허가해 해소했다 —
  호출부 전체(레포 전역)를 실측으로 고쳐 전 스위트 그린 유지. `now` 를 놓을 clock 이 정말 없는
  호출부는 없었다(전부 `clock.now()`/`FixedClock` 이 스코프에 있었음).
- `policy.credits.negativeBalance='allow_to_floor'` 가 바닥을 넘는 요청을 **전부 거절**할지
  **바닥까지만 부분 이행**할지 EDGE_CASES.md 에 명시가 없어 "전부 거절"로 구현했다(원자성 우선).
  부분 이행이 맞다면 `ConsumeResult` 에 `entries` + `shortfall` 동시 반환이 이미 가능하므로 정책 문서만
  갱신하면 된다(타입 변경 불필요).
- **EC:L5 — 대부분 해소, 자세한 내용은 위 [EC:L5] 섹션 참고.** 남은 갭: lifecycle/refund/credits/cs
  **자기 내부**에서 만드는 `PaymentProvider` 호출(예: `refund.execute` 의 `provider.refund()`)은
  webhook 이 넘긴 correlationId 를 받지 못한다 — 그 패키지들의 내부 구현을 고쳐야 하므로 webhook
  소유 범위 밖.

### Normalized refund notification contract (Step 1)

`NormalizedEvent.refundRef` / `refund_ref` optionally identifies the provider's actual refund
or cancellation transaction. `id` remains the delivery identity. `refund.created` means final
success, `refund.failed` final failure, and `refund.pending` nonterminal status. Unknown or
aggregate provider notifications do not fabricate refund identifiers.

The optional `RefundLookupProvider` capability returns `Refund | null` from
`getRefund({paymentRef, refundRef})` / `get_refund(payment_ref=..., refund_ref=...)`.
It must read the provider's authoritative cancellation and match the exact refund reference.
It does not change the mandatory `PaymentProvider` interface or assume all providers offer
this lookup.

## [EC:J6] [EC:J7] Currency exponents and exact money math

```pseudo
currencyExponent(c): 0 for ZERO_DECIMAL (BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX UYI VND VUV XAF XOF XPF),
                     3 for BHD IQD JOD KWD LYD OMR TND, else 2
money(n, c): require |n| <= 2^53 - 1 (safe integer)
scaleMinor(amount, num, den, rounding): exact integer amount*num/den; floor | ceil | round (half away from zero)
prorationFraction(period, now, denominator) -> { num: remaining ms clamped, den: total ms }
roundHalfAwayFromZero(x): the same .5 rule in TS and Python
```

## [EC:J8] 결제사 경계의 금액 검사와 Python 반올림 일치

```pseudo
provider normalizers: amount = money(amountMinor, currency)   # 안전 정수 아니면 throw (TS Error / Py TypeError·ValueError)

round_half_away_from_zero(x):          # Python, TS Math.round 와 같은 결과
   if x < 0: return -round_half_away_from_zero(-x)
   whole = floor(x); return whole + 1 if x - whole >= 0.5 else whole   # floor(x + 0.5) 아님

proration_fraction(period, now, denominator):   # Python, TS prorationFraction 과 같은 정수
   den = round_half_away_from_zero(totalDays * DAY_MS)
   num = clamp(epoch_ms(period.end) - epoch_ms(now), 0, den)          # epoch_ms = floor to whole ms
```
