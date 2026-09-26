# Toss Payments Provider — spec

소스: docs/ARCHITECTURE.md §3.4 `PaymentProvider` · docs/EDGE_CASES.md §F(Toss) + E4 E6 E8 E9 E12 E13 D4 D13 D14 D6.
공식 문서: docs.tosspayments.com/reference (결제 승인·조회·취소·빌링), docs.tosspayments.com/reference/using-api/webhook-events.

Toss 는 **네이티브 구독이 없다.** 빌링키(자동결제) + 우리 스케줄러(`lifecycle.scheduler.tick`)가 매 주기
`chargeBillingKey` 를 호출한다. `Subscription` 엔티티는 항상 우리 `Repo` 가 원본이며, Toss 는 결제
행위(단건 승인·빌링키 결제·취소)만 안다.

## 인증 · 공통

```pseudo
base_url = "https://api.tosspayments.com"
auth_header = "Basic " + base64(secretKey + ":")
모든 쓰기(POST) 요청에 Idempotency-Key 헤더를 실을 수 있음 (Toss 지원 시 서버가 중복 방지)
```

## capabilities()

```pseudo
{ nativeSubscriptions: false, partialRefund: true, meters: false, scheduling: 'self', webhookSignature: false }
```
webhookSignature=false 인 이유: PAYMENT_STATUS_CHANGED 류 결제 웹훅에는 서명 헤더가 없다
(payout.changed/seller.changed 등 파트너 웹훅에만 `webhook-signature` 헤더가 붙는다 — 결제 흐름과 무관).
→ IP 화이트리스트 + 재조회로 신뢰를 대신한다 (EC:E4 변형, EC:E3).

## [EC:E10 E6] createCustomer / createCheckout

```pseudo
createCustomer({email, name?, metadata?}):
  Toss 에는 고객 객체가 없다.
  customerKey = metadata.customerKey ?? ('cus_' + sha256(email)[:40])   # Toss 제약: 2~50자, [A-Za-z0-9-_=.@]
  return {ref: customerKey}

createCheckout(input):
  if input.price.currency != 'KRW': throw PaymentKitError('currency_unsupported')   # EC:E10 — Toss 는 KRW 전용
  orderId = 'ord_' + sha256(input.idempotencyKey)[:40]    # EC:E6 — 같은 idempotencyKey(고객,플랜,분) 는 같은 orderId → 더블클릭 시 위젯이 같은 주문 재사용
  url = successUrl + '?orderId=' + orderId + '&amount=' + amountMinor
  return {id: orderId, url, providerRef: orderId}
  # 앱은 반환된 (clientKey, orderId, amount) 로 Toss 위젯을 렌더링한다.
  # 위젯 성공 콜백은 UX 용일 뿐이며 지급 트리거가 아니다 (EC:E13). 지급은 confirmPayment 성공 이후.
```

## [EC:E13 E10 E6] confirmPayment (core 인터페이스 밖 extra 메서드)

결제 승인은 **반드시 서버가 호출**해야 한다 — 프론트 성공 콜백만으로 지급 금지.

```pseudo
confirmPayment({paymentKey, orderId, amount}) -> Payment:
  # 호출자(app)는 자신의 주문 테이블에서 조회한 기대 금액을 amount 로 넘긴다.
  # Toss 서버가 위젯 오픈 시점 금액과 confirm 금액을 자체 대조해 불일치 시 에러를 반환한다 (EC:E6/E10 방어선).
  raw = POST /v1/payments/confirm {paymentKey, orderId, amount}
  return normalizeTossPayment(raw)
```

## [EC:F] issueBillingKey / chargeBillingKey (extra + core)

```pseudo
issueBillingKey({authKey, customerKey}) -> {billingKey, customerKey, raw}:
  raw = POST /v1/billing/authorizations/issue {authKey, customerKey}
  return {billingKey: raw.billingKey, customerKey: raw.customerKey, raw}

chargeBillingKey({billingKey, amount, orderId, customerRef, idempotencyKey}) -> Payment:   # core interface
  raw = POST /v1/billing/{billingKey} {customerKey: customerRef, amount: amount.amountMinor, orderId, orderName: 'Subscription charge'}
        headers: {Idempotency-Key: idempotencyKey}
  return normalizeTossPayment(raw)
  # lifecycle.scheduler.tick 이 due_subscriptions() 순회하며 매 주기 이 함수를 호출한다.
  # idempotencyKey 는 ARCHITECTURE §7 규약대로 subscription 단위로 앱이 생성 (예: charge:{sub_id}:{period_start}).
```

## [EC:E8 E9] getPayment · 상태 정규화 · 실패 정규화

```pseudo
getPayment(paymentKey) -> Payment:
  raw = GET /v1/payments/{paymentKey}
  return normalizeTossPayment(raw)
```

상태 매핑 (normalizeTossStatus):

| Toss status | 정규화 |
|---|---|
| READY | pending |
| IN_PROGRESS | pending |
| WAITING_FOR_DEPOSIT | pending — **지급 금지** (EC:E8). `DONE` 웹훅이 와야 지급 |
| DONE | succeeded |
| CANCELED | refunded |
| PARTIAL_CANCELED | partially_refunded |
| ABORTED | failed |
| EXPIRED | failed |

실패 정규화 (EC:E9 패턴, `raw.failure.code` 기준). 매핑표는 코드 내 `TOSS_FAILURE_MAP` 에 위치하며
Toss 실패 코드 전체를 다루진 않는다 — 매핑 안 된 코드는 `{code:'unknown', retryable:false}` 로 안전하게
떨어지고 `providerCode` 원본을 보존한다 (확장은 실제 실패 로그 축적 후).

## [EC:H4] listPayments — 한계

```pseudo
listPayments({customerRef, since}) -> Payment[]:
  # Toss 에는 고객 기준 결제 목록 API가 없다. /v1/transactions 는 날짜 범위 거래 내역이며
  # 응답에 customerKey 가 실려 있지 않을 수 있다 (카드 단건 결제 등).
  raw[] = GET /v1/transactions?startDate=since&endDate=now
  matched = raw.filter(t => t.customerKey == customerRef)   # 실려 있을 때만 매칭됨
  return matched.map(normalizeTossPayment)
  # → cs.reconcile 은 Toss 는 이 목록이 불완전할 수 있음을 전제하고, 앱 자체 주문 테이블(order.orderId ↔ customerRef)
  #   대조를 1차 신뢰 소스로 삼아야 한다. 문서화된 한계.
```

**2026-09-09 실측 (paykit live, `test_sk_zXLkKEypNArWmo50nX3lmeaxYG5R` 공개 문서용 테스트 키)**: 위
"문서화된 한계"가 실제로 재현됨을 확인했다. `issueBillingKeyByCard` + `chargeBillingKey` 로 방금 만든
실 결제(`tviva...`, status DONE, 9900원)를 만든 직후 같은 `customerKey` 로 `listPayments` 를 호출하면:
- **1시간 범위**: 방금 만든 결제가 `/v1/transactions` 응답에 **안 잡힘**(rows 0) — 반영 지연이 있는
  것으로 보임(정확한 지연 시간은 미확인).
- **24시간 범위**: 다른 상점(`mId: tvivarepublica2` 등, 이 공개 문서용 키를 공유하는 다른 테스터의
  거래)의 행이 섞여 나옴 — `matched = raw.filter(t => t.customerKey == customerRef)` 로 걸러지긴
  하지만, `/v1/transactions` 자체가 **상점 경계도 안전하게 안 지켜진다**는 뜻이므로 신뢰도가 더 낮다.
- 결론: `listPayments` 는 "호출이 성공한다"는 것 이상을 보장하지 않는다. `boilpayment live`/
  `examples/live/real_round_trip.py` 는 이 호출을 PASS 로 기록하되 **방금 만든 결제가 포함되는지는
  단언하지 않는다** — 위 실측 결과가 근거다.

## getSubscription / changeSubscription / cancelSubscription / uncancelSubscription — 계약 변경 제안

```pseudo
getSubscription(providerRef): throw PaymentKitError('unsupported', 'toss has no native subscription; use Repo.subscriptions')
changeSubscription / cancelSubscription / uncancelSubscription: 동일하게 throw PaymentKitError('unsupported')
```
`uncancelSubscription` 은 2026-09-09 `PaymentProvider` 계약에 신설된 A23 메서드 — Toss 는 애초에
구독 상태를 안 갖고 있으므로(self-scheduling) 위 세 메서드와 같은 이유로 동일하게 `unsupported`.
`lifecycle.reactivate` 가 `capabilities().nativeSubscriptions===false` 면 이 메서드를 아예 호출하지
않으므로 실제로는 도달하지 않는 경로지만, 계약을 충족하려면 구현은 있어야 한다.
**브리프 원안**("no-op marker 반환")과 다르게 구현함: `Subscription` 은 `customerId·planId·currentPeriod·
anchorDay·createdAt` 등 provider 가 알 수 없는 필드를 갖는다. 이를 채운 "마커"를 반환하면 값을 지어내는
것이 되어 값-출처 원칙(추측한 값을 쓰지 않는다)에 위배된다. 대신 명확히 `unsupported` 를 던지고,
호출자(`lifecycle.upgrade/downgrade/cancel`)가 self-scheduling 구독에서는 provider 호출을 건너뛰고
`Repo.subscriptions` 행만 갱신하도록 분기해야 한다 — **이 분기가 core/lifecycle 쪽에 아직 없다면 계약
보강 필요** (최종 보고에 기재).

## [EC:D4 D13 D6] refund

```pseudo
refund({paymentRef, amount, reason, idempotencyKey, extra}) -> Refund:
  rawPayment = GET /v1/payments/{paymentRef}          # method 확인용
  if '가상계좌' in rawPayment.method and not extra?.refundReceiveAccount:
    throw PaymentKitError('refund_receive_account_required')   # EC:D13
  body = {cancelReason: reason}
  if amount: body.cancelAmount = amount.amountMinor    # 부분 환불 EC:D4. round(환불액/단가) 는 refund.execute 책임
  if extra?.refundReceiveAccount: body.refundReceiveAccount = extra.refundReceiveAccount
  raw = POST /v1/payments/{paymentRef}/cancel body   headers: {Idempotency-Key: idempotencyKey}
  return normalizeTossRefund(raw)
  # EC:D6 — 환불은 결제 통화·결제 금액 기준(Toss 는 KRW 고정이라 환율 이슈 자체가 없음)
  # EC:D14(할부): Toss 도 카드사별로 부분취소 제한이 있을 수 있음 — 사전 감지 안 함, Toss 에러를 그대로 전파
```
`Refund.customerId` · `Refund.ruleId` 는 provider 가 알 수 없어 빈 문자열로 반환한다 — **계약 변경 제안**:
`refund.execute` 가 provider.refund() 결과를 자신의 컨텍스트(customerId, 판정 ruleId)로 덮어써야 한다.

## [EC:K2 K3 K4 K5 K6 K7] issueCashReceipt / cancelCashReceipt / getCashReceipt (core 인터페이스 밖 extra 메서드)

한국 B2C 결제의 법정 의무. 세 메서드 모두 `PaymentProvider` 코어 인터페이스 밖의 extra 메서드다
(`confirmPayment`·`issueBillingKey` 와 동일 패턴). 정책은 `policy.cashReceipt` (core 에 이미 존재,
`packages/core/ts/src/policy.ts`) — `mode`(off/manual/auto) · `defaultType`(personal/business) ·
`cancelOnRefund`(bool).

**실측(2026-09-09, 실서비스 test API, `test_sk_zXLkKEypNArWmo50nX3lmeaxYG5R`)** — 이 섹션의 모든
엔드포인트/바디/응답 필드는 문서(docs.tosspayments.com/reference)뿐 아니라 실제 호출로 확인했다:

```pseudo
issueCashReceipt({paymentRef, type, customerIdentityNumber, orderName?, taxFreeAmountMinor?}) -> CashReceipt:
  rawPayment = GET /v1/payments/{paymentRef}
  # EC:K4 — 실측: POST /v1/cash-receipts 는 orderId 가 실제 결제와 매칭되는지, 결제수단이 무엇인지
  # 서버가 검증하지 않는다(임의 orderId 로도 200 발급됨을 확인). 카드 결제 제외는 반드시 여기서,
  # 클라이언트 쪽에서 강제한다 — provider·서버가 걸러주지 않는다.
  if '카드' in rawPayment.method:
    throw PaymentKitError('cash_receipt_unsupported_for_payment_method')
  body = {
    orderId: rawPayment.orderId, orderName: orderName ?? rawPayment.orderName ?? 'Payment',
    amount: rawPayment.totalAmount,
    type: type == 'business' ? '지출증빙' : '소득공제',   # EC:K3 — Toss 는 한글 리터럴, enum 코드 아님
    customerIdentityNumber,
  }
  if taxFreeAmountMinor: body.taxFreeAmount = taxFreeAmountMinor
  raw = POST /v1/cash-receipts body   # 실측 응답: {receiptKey, orderId, orderName, type, issueNumber,
                                       #   receiptUrl, businessNumber, transactionType:'CONFIRM',
                                       #   amount, taxFreeAmount, issueStatus:'IN_PROGRESS', failure,
                                       #   customerIdentityNumber, requestedAt}
  return normalizeTossCashReceipt(raw)

cancelCashReceipt({receiptKey, amountMinor?}) -> CashReceipt:
  body = amountMinor != null ? {amount: amountMinor} : {}   # 생략 = 전액 취소, 실측 확인
  raw = POST /v1/cash-receipts/{receiptKey}/cancel body   # 실측 응답: transactionType:'CANCEL'
  return normalizeTossCashReceipt(raw)   # EC:K5 — 부분 환불이면 amountMinor 만큼만 부분 취소

getCashReceipt({orderId, requestDate}) -> CashReceipt | null:
  # EC:K7 — Toss 에 receiptKey 단건 조회 GET 이 없다(실측: GET /v1/cash-receipts/{receiptKey} 는
  # 라우트 자체가 없는 404 — Toss 형식 에러가 아님). 유일한 조회는 날짜별 목록
  # GET /v1/cash-receipts?requestDate=yyyy-MM-dd (실측: requestDate 필수, startDate/endDate 는
  # INVALID_REQUEST 로 거절됨) 뿐이라 orderId 로 클라이언트 필터링한다.
  # 실측 주의: 공개 테스트 키(사업자번호 미등록)로는 이 목록 조회 자체가
  # NOT_FOUND_MERCHANT_BUSINESS_NUMBER 로 404 난다 — 엔드포인트/파라미터 모양은 검증됐지만 성공
  # 응답까지는 이 환경에서 재현하지 못했다.
  raw = GET /v1/cash-receipts?requestDate={requestDate}
  match = raw.find(c => c.orderId == orderId)
  return match ? normalizeTossCashReceipt(match) : null
```

**중복 발행 가드 (EC:K7)** — 실측: 같은 `orderId` 로 `POST /v1/cash-receipts` 를 두 번 호출하면
서버가 막지 않고 서로 다른 `receiptKey` 로 두 번 발행된다. 따라서 발행 여부는 **호출자가**
멱등하게 기록해야 한다(예: `repo.payments.put` 으로 `payment.raw.cashReceipt` 갱신) — provider
쪽에는 dedup 이 없다.

**결제·환불 롤백 금지 (EC:K6)** — 발행·취소 실패는 결제/환불의 성공 여부에 영향을 주지 않는다.
`refund.execute` 는 환불 성공 뒤 `cancelCashReceipt` 를 시도하고, 실패해도 `Refund.status` 는
그대로 `succeeded` 를 유지하며 `cs.openRefundFailedCase`(`needs: 'cash_receipt_cancel_failed'`)
로만 기록한다 — `refund.pseudo.md` "[EC:K5 K6] execute — 현금영수증 취소" 참고.

## reportUsage

```pseudo
reportUsage(...): throw PaymentKitError('unsupported')   # capabilities().meters = false
```

## [EC:E4 E3] verifyWebhook · mapTossWebhook

```pseudo
verifyWebhook({headers, rawBody}) -> NormalizedEvent:
  body = JSON.parse(rawBody)   # {eventType, createdAt, data}
  if allowedWebhookIps set:
    remoteIp = headers['x-paykit-remote-ip']   # 앱이 실제 클라이언트 IP를 이 헤더로 채워 넣는다 (문서화된 관례 — Toss 는 서명이 없으므로 IP만이 방어선)
    if remoteIp not in allowedWebhookIps: throw WebhookSignatureError
  return mapTossWebhook(body)
```

웹훅 매핑 (mapTossWebhook, `eventType` + `data.status` 기준):

| eventType | data.status | NormalizedEvent.type |
|---|---|---|
| PAYMENT_STATUS_CHANGED / DEPOSIT_CALLBACK | DONE | payment.succeeded |
| PAYMENT_STATUS_CHANGED / DEPOSIT_CALLBACK | CANCELED, PARTIAL_CANCELED | refund.created |
| PAYMENT_STATUS_CHANGED / DEPOSIT_CALLBACK | WAITING_FOR_DEPOSIT | payment.pending |
| PAYMENT_STATUS_CHANGED / DEPOSIT_CALLBACK | EXPIRED, ABORTED | payment.failed |
| CANCEL_STATUS_CHANGED | cancelStatus=DONE | refund.created |
| CANCEL_STATUS_CHANGED | other or missing cancelStatus | refund.pending |

| BILLING_DELETED | — | subscription.canceled |
| 그 외 | — | unknown |

`NormalizedEvent.id` 는 `eventType:paymentKey:status:createdAt` 로 합성한다 — Toss 웹훅 바디에는
고유 `eventId` 필드가 없다(공식 문서·재검색 확인). `createdAt` 은 최초 이벤트 생성 시각이라 **재전송에도
값이 같아** 이 합성 키가 `provider_event_id` 대체 역할을 하며 ARCHITECTURE §7 의 UNIQUE idempotency_key
로 재전송(no-op)을 잡아낸다.

**핸들러는 반드시 재조회한다 (EC:E3)** — `mapTossWebhook` 은 알림만 정규화할 뿐 지급 트리거가 아니다.
`webhook.default_handlers` 는 `payment.succeeded` 수신 시 `provider.getPayment(paymentRef)` 로
현재 상태를 다시 읽어 `status == DONE` 확인 후에만 `lifecycle.on_renewal_paid` 를 호출해야 한다.

## self-scheduler 계약 (lifecycle.scheduler.tick 이 호출하는 것)

```pseudo
Scheduler.due_subscriptions(now) -> Repo.subscriptions.list({provider:'toss', status:'active', current_period.end <= now})
Scheduler.tick(now):
  for sub in due_subscriptions(now):
    idempotencyKey = `charge:${sub.id}:${sub.current_period.start.toISOString()}`
    try:
      payment = provider.chargeBillingKey({billingKey: sub.billingKey, amount, orderId: idempotencyKey, customerRef: ..., idempotencyKey})
      if payment.status == 'succeeded': lifecycle.on_renewal_paid(...)
      else: dunning.on_payment_failed(...)
    catch ProviderError as e:
      dunning.on_payment_failed({..., failure: e.failure})
```
(위 tick 본체는 lifecycle 담당 — 여기서는 Toss provider 가 만족해야 할 입출력 계약만 명시.)

## [EC:L5] withCorrelationId — correlationId scoping (added 2026-09-09)

`TossProvider` implements a duck-typed `withCorrelationId(correlationId) -> PaymentProvider`
(ts) / `with_correlation_id(correlation_id)` (py) — NOT part of the shared `PaymentProvider`
interface/Protocol, so this is additive only. Returns a scoped clone whose `request()`/logging
uses `correlationId` instead of the per-call idempotencyKey-derived default (falls back to that
default when no override is set — unchanged behavior from before this addition). `packages/webhook`
calls it from `process()` when present, threading one webhook delivery's correlationId through
every provider call the handler makes for that delivery. See
`packages/webhook/spec/webhook.pseudo.md` [EC:L5] for the full design; regression coverage in
`ts/test/correlation-id.test.ts` / `py/tests/test_toss_correlation_id.py`.

### Webhook time compatibility rule (2026-09-10)

The [official webhook reference](https://docs.tosspayments.com/reference/using-api/webhook-events)
uses an offset-free `createdAt` format for payment events. It does not explicitly establish
its timezone. The kit interprets those legacy timestamps as Korea time (`+09:00`) to preserve
existing Korea-host behavior consistently across deployment timezones. This is a **kit
compatibility assumption**, not a verified provider timezone guarantee. Explicit `Z` or
numeric offsets are preserved. The original timestamp remains in the synthesized event ID,
so normalization does not change retry deduplication identity. Invalid timestamp handling
remains unchanged.

### Refund transaction identity and authoritative lookup (2026-09-10)

- `Refund.providerRef` and webhook `refundRef` refer to `Cancel.transactionKey`, never a payment key or delivery ID.
- `PAYMENT_STATUS_CHANGED` selects the cancellation matching `lastTransactionKey`; its `cancelAmount` is the individual amount. `totalAmount` remains the original payment amount and is never a refund amount. Without a matching cancellation, refund reference and amount remain null.
- `CANCEL_STATUS_CHANGED` carries a Cancel object. `DONE` means final success; missing or other `cancelStatus` values stay `refund.pending`. The current official reference only specifies `DONE`; this kit does not guess a final-failure enum. Such outcomes need authoritative follow-up/manual recovery until a documented final-failure mapping is available.
- Cancel-only bodies may omit payment key and currency. Preserve null; do not invent KRW for an overseas cancellation. Match an existing refund by transaction key, then call `getRefund({paymentRef, refundRef})` / `get_refund(...)`.
- Authoritative lookup GETs the payment and matches an exact entry in `cancels`. It returns that cancellation's amount, the payment currency and actual status; no match returns null. A refund request response uses the same identity/status contract.
- Synthetic refund delivery IDs include the transaction key to distinguish simultaneous partial refunds; non-refund delivery IDs and timestamp compatibility are unchanged.

Sources: [Toss API reference](https://docs.tosspayments.com/reference), [webhook event reference](https://docs.tosspayments.com/reference/using-api/webhook-events).

## [EC:E18] Webhook origin: peer address and deposit secret

```pseudo
verifyWebhook({ headers, rawBody, receivedAt?, remoteAddress? }):
   atReceipt = receivedAt is undefined               # process() re-verifies a row that passed these
   if atReceipt and allowedWebhookIps:
      require remoteAddress in allowedWebhookIps      # the app's socket peer; headers are never read
   if atReceipt and body.secret is a string:          # DEPOSIT_CALLBACK (virtual account)
      payment = GET /v1/payments/orders/{orderId}
      require constantTimeEqual(payment.secret, body.secret)
   return mapTossWebhook(body)
```

## [EC:E22] 허용목록: 주소, CIDR, IPv4-mapped IPv6

```pseudo
construct: for entry in allowedWebhookIps: parse as address or CIDR (IPv4/IPv6); otherwise throw
receipt:   addr = remoteAddress; if addr is ::ffff:a.b.c.d: addr = a.b.c.d
           allowed iff addr parses and falls in some entry of the same family
```


## [EC:A52] getPaymentByOrderId: only the provider's own "not found" is null

`getPaymentByOrderId(orderId)` returns null only for a 404 whose body code is `NOT_FOUND_PAYMENT`. Any other 404
(an HTML page from a proxy, a wrong base URL, an unknown route) is thrown, so the attempt stays
unresolved instead of being closed as "never arrived" and charged again.
