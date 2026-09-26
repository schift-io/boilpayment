# Architecture

작성일: 2026-09-09

## 1. 모노레포 레이아웃

```
boilpayment/
  docs/                      EDGE_CASES · ARCHITECTURE · STEP1_E2E · RELEASE
  packages/
    core/                    타입 · Policy 스키마+기본값 · 인터페이스 · InMemoryLedger · 기간/일할 계산
    credits/                 크레딧 원장 로직 (grant/consume/expire/rollover/clawback)
    usage/                   이용량 (record/check/close_period/outbox)
    lifecycle/               upgrade/downgrade/cancel/trial/dunning/self-scheduler
    refund/                  환불 판정(evaluate) + 실행(execute) + 회수
    webhook/                 수신 저장 → 비동기 처리 → 핸들러 디스패치
    notify/                  Email(Resend/SMTP) · Slack 어댑터
    cs/                      reconcile · regrant · refund_assist · dispute · metrics · widget token
    schema-postgres/         SQL 마이그레이션 + PostgresLedgerStore (py: psycopg / ts: pg)
    providers/
      stripe/  polar/  toss/  portone/
  apps/
    cli/                     `npx boilpayment init` 위저드 (TS)
```

**각 패키지 내부** (공통 규칙):

```
packages/<name>/
  spec/<name>.pseudo.md      ← 소스 오브 트루스. 섹션 제목에 [EC:<id>] 표기
  ts/                        boilpayment-<name>
    package.json  tsconfig.json  src/index.ts ...
  py/                        boilpayment-<name>  (모듈명 boilpayment_<name>)
    pyproject.toml  src/boilpayment_<name>/__init__.py ...
```

- 구현 코드는 spec 섹션을 주석으로 인용: `// EC:A3` / `# EC:A3`
- py 와 ts 는 **같은 함수명·같은 인자 순서·같은 반환 형태** (케이스만 snake/camel 변환)

## 2. 도구

| | TS | Py |
|---|---|---|
| 워크스페이스 | pnpm workspace (`pnpm-workspace.yaml`) | uv workspace (`[tool.uv.workspace]`) |
| 빌드 | `tsc` (ESM, `dist/`) | hatchling, `src/` layout |
| 런타임 | Node ≥ 20 | Python ≥ 3.11 |
| 테스트(후순위) | vitest | pytest |
| 배포 | npm `boilpayment*` | PyPI `boilpayment-*` |

패키지 간 의존은 워크스페이스 참조 (`workspace:*` / `{ workspace = true }`).

## 3. 핵심 계약 (core)

아래 타입·인터페이스는 `packages/core/ts/src/types.ts` 와
`packages/core/py/src/boilpayment_core/types.py` 에 **동일하게** 존재한다.
다른 패키지는 이것만 import 해서 구현한다.

### 3.1 값 객체

```
Money            { amount_minor: int, currency: str }        # minor unit (KRW 는 1원 = 1)
Period           { start: datetime, end: datetime }          # [start, end)
Clock            { now(): datetime }                          # DI. 테스트에서 고정
IdGen            { new_id(): str }
```

### 3.2 Policy (= paykit.config.json 의 `policy`)

`docs/EDGE_CASES.md` 의 정책 키 전부. 중첩 객체:

```
Policy {
  period:    { timezone, month_end_anchor }
  proration: { denominator }
  credits:   { rollover, bank_cap, bank_reset, consume_order, negative_balance, negative_floor, pools, topup_expiry_days, grant_lag_behavior }
  upgrade:   { mode, credit_delta }
  downgrade: { mode, clawback_shortfall }
  cancel:    { mode, credits }
  trial:     { credits_on_convert, credits_on_cancel, abuse_guard }
  dunning:   { grace_days, usage_during_grace, grant_during_grace, on_final_failure, on_recovery, pre_expiry_notice_days }
  refund:    { no_questions_days, method, overuse_behavior, rounding, revoke_shortfall, fee_bearer, max_per_customer_per_year, annual_method }
  usage:     { overage, overage_unit_price_minor, late_report_window_hours, included_quantity, credit_conversion }
  dispute:   { on_open, on_lost }
  cs:        { regrant: { mode }, auto_approve: { max_amount_minor, max_credits }, fraud: { refund_velocity } }
  subscription: { multiple_per_customer }
  interval_change: { mode }
}
```

`DEFAULT_POLICY` 는 EDGE_CASES.md 의 굵은 기본값. `validate_policy(obj) -> Policy` 는 enum 검사.

### 3.3 도메인 엔티티

```
Customer      { id, email?, provider_refs: {provider: str, ref: str}[], status: 'active'|'frozen'|'banned', created_at }
Plan          { id, name, interval: 'month'|'year'|null, credits_per_period: int, usage_included: int, trial_days: int, prices: {currency: str, amount_minor: int}[] }
Subscription  { id, customer_id, plan_id, provider, provider_ref, status: 'trialing'|'active'|'past_due'|'canceled'|'expired',
                current_period: Period, anchor_day: int, cancel_at_period_end: bool, grace_until?: datetime, created_at }
Payment       { id, customer_id, provider, provider_ref, subscription_id?, amount: Money, status: 'pending'|'requires_action'|'succeeded'|'failed'|'refunded'|'partially_refunded'|'disputed',
                kind: 'subscription'|'topup'|'overage', period?: Period, occurred_at, raw? }
LedgerEntry   { id, customer_id, pool: 'paid'|'promo'|'trial', kind: 'grant'|'consume'|'revoke'|'expire'|'hold'|'release'|'adjust',
                amount: int (signed: grant + / consume − / revoke − / hold − / release +), unit_price_minor?, currency?, expires_at?,
                source: 'subscription'|'topup'|'manual'|'regrant'|'refund'|'downgrade'|'dispute'|'trial'|'promo'|'usage',
                reference: { subscription_id?, period_start?, payment_id?, case_id?, grant_id? },
                idempotency_key: str (UNIQUE), actor: str, reason?: str, created_at }
Balance       { customer_id, pool, available: int, held: int, expiring: {expires_at, amount}[] }
UsageEvent    { id, customer_id, meter, quantity: int, occurred_at, received_at, period_start, idempotency_key, meta? }
Refund        { id, payment_id, amount: Money, status: 'pending'|'succeeded'|'failed', provider_ref?, credits_revoked: int, rule_id, created_at }
CsCase        { id, customer_id, kind: 'regrant'|'refund'|'dispute'|'double_charge'|'refund_failed'|'reconcile_mismatch',
                status: 'open'|'needs_human'|'resolved_auto'|'resolved_human'|'rejected', reference_id, policy_snapshot: Policy,
                decision?: object, churn_reason?: str, opened_at, resolved_at? }
```

### 3.4 인터페이스 (DI)

```
PaymentProvider
  name: 'stripe'|'polar'|'toss'|'portone'
  capabilities(): { native_subscriptions, partial_refund, meters, scheduling: 'provider'|'self', webhook_signature: bool }
  create_customer({email, name?, metadata?}) -> {ref}
  create_checkout({customer_ref, plan, price, mode: 'subscription'|'one_time', success_url, cancel_url, idempotency_key, metadata?}) -> {id, url, provider_ref}
  get_payment(provider_ref) -> Payment
  list_payments({customer_ref, since}) -> Payment[]                       # H4 · E1 대조용
  get_subscription(provider_ref) -> Subscription                           # E3 re-fetch
  change_subscription(provider_ref, {new_price_ref, proration: 'immediate'|'none', reset_anchor: bool}) -> Subscription
  cancel_subscription(provider_ref, {at_period_end: bool}) -> Subscription
  charge_billing_key({billing_key, amount, order_id, customer_ref, idempotency_key}) -> Payment   # Toss·Portone self-scheduling
  refund({payment_ref, amount, reason, idempotency_key, extra?}) -> Refund   # extra: Toss refundReceiveAccount 등
  report_usage({meter, customer_ref, quantity, occurred_at, idempotency_key}) -> void
  verify_webhook({headers, raw_body}) -> NormalizedEvent                    # 서명 실패 시 WebhookSignatureError

NormalizedEvent
  { id, provider, type: 'payment.succeeded'|'payment.failed'|'payment.requires_action'|'payment.pending'
                     |'subscription.created'|'subscription.updated'|'subscription.canceled'|'subscription.payment_failed'
                     |'refund.created'|'refund.failed'|'dispute.opened'|'dispute.closed'|'unknown',
    occurred_at, customer_ref?, subscription_ref?, payment_ref?, amount?: Money, raw }

LedgerStore
  append(entry) -> LedgerEntry                       # DuplicateIdempotencyKey 시 기존 행 반환 + duplicated=true
  balance(customer_id, pool?) -> Balance
  entries(customer_id, {pool?, kind?, since?}) -> LedgerEntry[]
  consume({customer_id, pool_order, amount, idempotency_key, meta, now}) -> {ok, entries, shortfall}   # 원자적, expiry·순서·음수정책 반영
  transaction(fn) -> T                                # 고객 단위 락

Repo (엔티티 CRUD; 최소)
  customers · plans · subscriptions · payments · usage_events · refunds · cs_cases · webhook_events · outbox
  각각 get / put / list(filter). Postgres 구현은 schema-postgres, InMemory 는 core.

Notifier
  send({type, customer_id?, payload}) -> void
  type: 'payment.failed'|'grace.started'|'grace.ending'|'subscription.canceled'|'refund.executed'|'cs.needs_human'|'reconcile.mismatch'|'card.expiring'

Scheduler (self-scheduling providers 용)
  due_subscriptions(now) -> Subscription[]
  tick(now) -> {charged, failed}
```

### 3.5 모듈 공개 API

**2026-09-09 실측 갱신** (`examples/e2e/round-trip.ts` · `round_trip.py` 로 9 모듈 전부 실행해
확인; 실제와 다르던 부분은 `examples/e2e/FINDINGS.md` 참고). 표기 규칙: **ts** 는 단일 입력
객체(camelCase) 한 개를 받는 함수 — `fn(input)`. **py** 는 기본적으로 단일 dataclass 입력
(snake_case, `kw_only=True`) 한 개를 받는 함수 — `fn(Input(...))`. **py 예외**로 표시된 것은
진짜 keyword-only 함수(dataclass 없음) — `fn(a=..., b=...)`. ts 는 예외 없이 전부 단일 입력
객체다.

```
credits (ts: boilpayment-credits · py: boilpayment_credits)
  grantForPeriod / grant_for_period({sub, plan, period, payment, policy, ledger, clock}) -> GrantResult                    EC:B1 B2 B7 A15
  consume({customerId, amount, policy, ledger, clock, idempotencyKey, reference?, reason?, actor?}) -> ConsumeResult       EC:B3 B4 B5 B14
  rolloverOnRenewal / rollover_on_renewal({sub, policy, ledger, clock, newPeriod}) -> RolloverResult                       EC:B1 B2
  clawback({customerId, amount, policy, ledger, clock, reason, reference, actor, idempotencyKey, shortfall}) -> ClawbackResult   EC:A4 B13
  expireDue / expire_due({ledger, clock, customerId}) -> ExpireDueResult                                                   EC:B14
  topup({customerId, payment, credits, policy, ledger, clock}) -> GrantResult (credits: number, NOT optional — see FINDINGS.md #4)   EC:B10
  grantPromo / grant_promo, grantTrial / grant_trial({customerId, amount, ledger, clock, idempotencyKey, expiresAt?, reason?, actor?, reference?}) -> GrantResult
  manualGrant / manual_grant, manualRevoke / manual_revoke({customerId, pool, amount, reason, actor, ledger, clock, idempotencyKey, expiresAt?, reference?}) -> GrantResult   EC:B9

lifecycle (ts: boilpayment-lifecycle · py: boilpayment_lifecycle)
  — namespaces, both languages: lifecycle.dunning.*, lifecycle.scheduler.*, lifecycle.period.* (submodules, not flat exports)
  upgrade({sub, newPlan, policy, provider, ledger, repo, clock, ids}) -> {sub, grant, creditDelta}                         EC:A1 A2 A8
  downgrade({sub, newPlan, policy, provider, ledger, repo, clock, ids}) -> {sub, clawback}                                 EC:A3 A4
  cancel({sub, policy, provider, ledger, repo, clock, churnReason?, churnText?, onChurn?}) -> {sub, churn, revoked}        EC:A5 A6 A10 I4
  convertTrial / convert_trial({sub, plan, payment, policy, ledger, repo, clock}) -> {sub, grant, trialRevoked}            EC:A9
  isTrialEligible / is_trial_eligible({customerId, email, repo, policy}) -> bool                                          EC:A11
  onRenewalPaid / on_renewal_paid({sub, payment, policy, ledger, repo, clock}) -> {sub, grant, rollover, duplicated, recovered}   EC:A7 A17 B12
  dunning.onPaymentFailed / dunning.on_payment_failed({sub, policy, repo, notifier, clock}) -> {sub}                       EC:A13
  dunning.onGraceExpired / dunning.on_grace_expired({sub, policy, ledger, repo, notifier, clock}) -> {sub, revoked}        EC:A16
  dunning.onRecovered / dunning.on_recovered({sub, payment, policy, ledger, repo, clock}) -> {sub, grants}                 EC:A17
  scheduler.dueSubscriptions / scheduler.due_subscriptions({repo, clock}) -> Subscription[]                                EC:F
  scheduler.tick({provider, repo, policy, ledger, clock, ids, notifier?}) -> {charged, failed}                             EC:F (Toss self-scheduling only; no-op if capabilities().scheduling !== 'self')
  period.nextPeriod / period.next_period(period, interval, anchorDay, tz, monthEndAnchor) -> Period                        EC:G1  (re-exported from core verbatim, incl. monthEndAnchor arg — not in old signature)
  period.prorationRatio / period.proration_ratio(period, now, denominator) -> number                                       EC:G2

refund (ts: boilpayment-refund · py: boilpayment_refund)
  evaluate({payment, sub?, policy, ledger, repo, clock, requestedAmount?, providerFeeMinor?}) -> RefundDecision            EC:D1 D2 D3 D4 D5 D7 D10 B13 B8
    ⚠ evaluate.ts:48/176, evaluate.py:78/241 call `ledger.balance(customerId, 'paid')` WITHOUT
      `now: clock.now()` — under InMemoryLedger this silently falls back to the real wall clock,
      not the injected Clock. Real, reproduced bug — see examples/e2e/FINDINGS.md #1.
  execute({decision, provider, ledger, repo, clock, ids, extra?, cs?}) -> Refund                                           EC:D12 D15 B8
  onExternalRefund / on_external_refund({event, ledger, repo, cs?}) -> void                                                EC:D8

usage (ts: boilpayment-usage · py: boilpayment_usage)
  record({event, sub, policy, repo, clock, ids, provider?, plan?}) -> {event, duplicated}                                  EC:C2 C3 C4 C7
    py exception: keyword-only — record(*, event, sub, policy, repo, clock, ids, provider=None, plan=None)
  check({customerId, meter, quantity, sub, policy, repo, ledger, clock, ids?, includedQuantity?, idempotencyKey?}) -> {allow, overage, reason, remaining, notify?}   EC:C1 C5 C6 C8 A14
    py exception: keyword-only — check(*, customer_id, meter, quantity, sub, policy, repo, ledger, clock, ids=None, included_quantity=None, idempotency_key=None)
  closePeriod / close_period({sub, policy, repo, provider, clock}) -> ClosePeriodResult                                    EC:C2 C9
  flushOutbox / flush_outbox({repo, provider}) -> FlushOutboxResult                                                        EC:C4

webhook (ts: boilpayment-webhook · py: boilpayment_webhook)
  receive({provider, headers, rawBody, repo, clock}) -> {status: 200|400, eventId?, duplicated?}                          EC:E4 E5
    py exception: keyword-only — receive(*, provider, headers, raw_body, repo, clock)
    note: `provider` is a single PaymentProvider instance (already resolved by the caller), not a `providers` map.
  process({eventId, providers, handlers, repo, clock}) -> void                                                             EC:E3 E13
    py exception: keyword-only — process(*, event_id, providers, handlers, repo, clock)
  processPending / process_pending({repo, providers, handlers, clock, maxAttempts?}) -> {processed, failed}
    py exception: keyword-only
  defaultHandlers / default_handlers({policy, ledger, repo, notifier, clock, ids, lifecycle?, credits?, refund?, cs?}) -> HandlerMap   → lifecycle/credits/refund/cs 호출
    py exception: keyword-only — default_handlers(*, policy, ledger, repo, notifier, clock, ids, lifecycle=None, credits=None, refund=None, cs=None)
    ⚠ ts: lifecycle/credits/refund/cs deps are duck-typed to match the REAL module functions'
      call shape 1:1 (single input object) — pass them directly, no adapter needed.
    ⚠ py: the LifecycleDeps/CreditsDeps/RefundDeps/CsDeps Protocols call dependencies with FLAT
      KEYWORD ARGS (e.g. `lifecycle.on_renewal_paid(sub=..., payment=..., ...)`), but the real
      py lifecycle.on_renewal_paid/dunning.on_payment_failed/refund.evaluate/refund.execute all
      take a single dataclass input. A thin in-file adapter is required — see
      examples/e2e/round_trip.py's `_LifecycleAdapter`/`_refund_evaluate_adapter` and
      examples/e2e/FINDINGS.md #3. `credits.topup` dep is called with `credits: null`/`None` for
      bare top-up payments — see FINDINGS.md #4 (not exercised, flagged from reading).
  getGrantsForCheckout / get_grants_for_checkout({checkoutIdOrPaymentRef, repo, ledger}) -> {ready, customerId?, entries?}   EC:E13

notify (ts: boilpayment-notify · py: boilpayment_notify) — not exercised in the e2e run
  resend(cfg) / smtp(cfg) / slack(cfg) -> Notifier

cs (ts: boilpayment-cs · py: boilpayment_cs)
  reconcile({customerId?, providers, ledger, repo, policy, clock, ids, since, onCaseEvent?}) -> CsCase[]                   EC:E1 H4
  checkBalances / check_balances({ledger, repo, customerIds?}) -> BalanceMismatch[]   (no-op unless repo exposes a duck-typed `creditBalances`/`credit_balances` table)   EC:H4
  regrant({case, ledger, repo, policy, clock, ids, plan, approvedBy?, onCaseEvent?}) -> CsCase   (plan: {pool, amount, unitPriceMinor?, currency?, expiresAt?, idempotencyKey?, reason?, customerId?})   EC:A18 E1 E2 E14
  refundAssist / refund_assist({case, payment, sub?, policy, ledger, repo, clock, ids, provider, refundEvaluate, refundExecute, requestedAmount?, providerFeeMinor?, notifier?, churnReason?, churnText?, onCaseEvent?}) -> CsCase   EC:D* I1 I2 I4
    ⚠ py's refundEvaluate/refundExecute Protocols use flat keyword args — see webhook note above, same adapter pattern applies.
  dispute({event, policy, ledger, repo, notifier}) -> CsCase                                                               EC:B11 D9
  openCase / open_case({customerId, kind, referenceId, policy, repo, clock, ids, onCaseEvent?}) -> CsCase                  EC:I7 I8
  escalate({case, repo, clock, reason, notifier?, onCaseEvent?}) -> CsCase                                                 EC:I3
  resolve({case, by, decision, repo, clock, onCaseEvent?}) -> CsCase
  reject({case, reason, repo, clock, onCaseEvent?}) -> CsCase   (local extension, not an EC id)
  metrics: CaseMeter / Metrics classes (record/snapshot), NoopLicenseReporter — object API, not a bare function   EC:I4
  churn.record({customerId, reason, text?, case, repo, clock, onCaseEvent?}) -> ChurnRecord                                EC:I4
  widget.verifyToken / widget.verify_token(token, secret) -> {customerId, exp}                                            EC:I6
  widget.signToken / widget.sign_token({customerId, ttlSeconds}, secret) -> string   (app-side helper, not part of the EC contract)
```

## 4. 데이터 흐름

```
[Checkout] app → provider.create_checkout → 고객 결제
[Webhook]  provider → webhook.receive (저장, 200) → worker: webhook.process
             → provider.verify_webhook → NormalizedEvent
             → provider.get_subscription/get_payment (re-fetch, E3)
             → handlers: payment.succeeded → lifecycle.on_renewal_paid → credits.grant_for_period
                         subscription.payment_failed → dunning.on_payment_failed
                         refund.created (외부) → refund.on_external_refund
                         dispute.opened → cs.dispute
[Consume]  app → credits.consume (원자적) / usage.check + usage.record
[Cron]     credits.expire_due · dunning.on_grace_expired · usage.close_period · usage.flush_outbox
           lifecycle.scheduler.tick (Toss/Portone) · cs.reconcile (일 1회)
[CS]       widget/API → cs.open_case → regrant / refund_assist / dispute → resolve or needs_human → notify
```

## 5. Postgres 스키마 (schema-postgres)

테이블: `customers` `plans` `plan_prices` `subscriptions` `payments` `ledger_entries` `credit_balances`
`usage_events` `usage_periods` `usage_outbox` `webhook_events` `outbox` `refunds` `refund_attempts`
`cs_cases` `cs_events` `churn_reasons` `policy_snapshots` `notifications`

규칙: `ledger_entries` 는 UPDATE/DELETE 거절 트리거 (H3). `idempotency_key` UNIQUE.
`credit_balances` 는 앱이 갱신하는 스냅샷 + 일일 정합성 검사 (B15 H4).
마이그레이션은 모듈별 파일: `0001_core.sql` `0002_credits.sql` `0003_usage.sql` `0004_webhook.sql` `0005_refund.sql` `0006_cs.sql`.
위저드는 선택 모듈의 파일만 복사한다.

## 6. 위저드 (apps/cli)

`npx boilpayment init [--config paykit.config.json] [--yes]`

1. 질문 (EDGE_CASES.md "위저드 질문 순서") → `paykit.config.json`
2. 생성:
   - `paykit/` — 선택 언어로 모듈 조합한 진입점 (`createPaymentKit(config, deps)` / `create_payment_kit`)
   - `paykit/migrations/*.sql` — 선택 모듈분
   - `paykit/webhook.(ts|py)` — 프레임워크 무관 핸들러 + Next.js/Express/FastAPI 예시 주석
   - `.env.example` — provider 키 · DB URL · 알림 키
   - `POLICY.md` — 정책 요약 (사람용)
3. 약관 생성 명령은 미지원.
4. `boilpayment check` — config 검증 + 마이그레이션 적용 여부 조회 (읽기만)

의존성 없음 원칙: prompts 는 `@clack/prompts`, 그 외 최소.

## 7. 멱등키 규약

| 동작 | idempotency_key |
|---|---|
| 주기 지급 | `grant:{subscription_id}:{period_start ISO}` |
| 충전 지급 | `topup:{payment_id}` |
| 소비 | 앱이 제공 (요청 ID) |
| 환불 회수 | `revoke:refund:{refund_id}` |
| 다운그레이드 회수 | `revoke:downgrade:{subscription_id}:{period_start}` |
| 재지급 | 원래 지급과 **같은 키** (E2 E14) |
| webhook | `provider_event_id` |
| 체크아웃 | `checkout:{customer_id}:{plan_id}:{floor(now, 1m)}` (E6) |
