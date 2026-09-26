# PortOne V2 Provider — spec

소스: docs/ARCHITECTURE.md §3.4 `PaymentProvider` · docs/EDGE_CASES.md §F(Portone) + E4 E6 E8 E9 E12 E13 D4 D13 D14 D6.
공식 문서: developers.portone.io/api/rest-v2 (결제·취소·빌링키·스케줄), developers.portone.io/opi/ko/integration/webhook/readme-v2.

**2026-09-09 갱신**: developers.portone.io 사이트는 JS 렌더링이라 WebFetch 로는 스키마가 안 나와서,
실제 V2 REST API의 원본 OpenAPI 스펙(`portone-io/server-sdk` GitHub repo,
`codegen/openapi.json` — 공식 SDK 코드 생성에 쓰이는 그 스펙)을 직접 받아 대조했다. 이전 세션에서
"미검증"으로 남겨뒀던 두 항목(`issueBillingKey`, `cancelSchedules`)을 확정했고, 그 과정에서 실제
버그 세 개를 추가로 발견해 코드까지 고쳤다(아래 각 섹션에 표시). 요약:

- `normalizePortoneStatus`: 실제 상태 리터럴은 `PAY_PENDING` 이지 `PENDING` 이 아니다 (Payment
  discriminator: CANCELLED | FAILED | PAID | PARTIAL_CANCELLED | PAY_PENDING | READY |
  VIRTUAL_ACCOUNT_ISSUED). **버그 → 수정함.**
- `issueBillingKey`: `POST /billing-keys` 서버 발급 경로 **확인됨** (클라이언트 SDK 전용이 아니다).
  단, 응답의 키 필드는 `billingKeyInfo.billingKey` 이지 top-level `billingKey` 가 아니다. **버그 → 수정함.**
- `chargeBillingKey`: `POST /payments/{paymentId}/billing-key` 응답은 `{payment: {pgTxId, paidAt}}`
  뿐인 얇은 완료 요약이지, 우리가 그대로 `normalizePortonePayment` 에 넣던 전체 Payment 객체가 아니다.
  **버그 → 수정함** (호출자가 이미 아는 값 + 응답의 paidAt/pgTxId 로 직접 구성).
- `schedulePayment`: 요청 바디는 `{payment: {...}, timeToPay}` 로 감싸야 한다 — 필드를 최상위에
  평평하게 보내면 안 된다. **버그 → 수정함.**
- `cancelSchedules`: 실제 엔드포인트는 `DELETE /payment-schedules` (paymentId 로 취소하는 API는
  존재하지 않는다) — `{storeId, billingKey?, scheduleIds?}` 바디(둘 중 하나 필수), 응답은
  `{revokedScheduleIds, revokedAt}`. **버그 → 수정함**, 메서드 시그니처도 `{paymentId}` →
  `{billingKey?, scheduleIds?}` 로 변경.
- `listPayments`: `GET /payments` 는 쿼리 스트링에 `requestBody` 라는 단일 파라미터로 URL-encode 된
  JSON(`{page?, filter?}`)을 싣는 PortOne 특유의 GET-with-body 관례를 쓴다 — `filter.from` 같은 평평한
  쿼리 파라미터가 아니다. 그리고 **`PaymentFilterInput` 에는 customer id 로 거를 수 있는 필드가 아예
  없다** (merchantId/storeId/timestampType/from/until/status/methods/pgProvider/isTest/isScheduled/
  sortBy/sortOrder/version/webhookStatus/platformType/currency/isEscrow/escrowStatus/card*/
  giftCertificateType/cashReceipt*/textSearch 가 전부). "미검증" 딱지를 떼고 **서버사이드 customer
  필터는 불가능하다고 확정** — date range 로만 걸고 `customer.id` 를 앱단에서 매치한다.

PortOne 은 여러 PG 사(카드사·간편결제·가상계좌 등)를 뒤에 두는 게이트웨이다. **네이티브 구독 없음** —
빌링키 결제 + (provider 스케줄 API 또는 우리 self 스케줄러) 로 매 주기 결제한다. `scheduling` 생성자
옵션으로 둘 중 선택 (기본 `'provider'`).

## 인증 · 공통

```pseudo
base_url = "https://api.portone.io"   # config.apiBase(ts) / api_base(py) 로 override 가능 — 로컬 목업용
auth_header = "Authorization: PortOne " + apiSecret
storeId 는 모든 요청 바디/쿼리에 실린다.
```
로컬 목업(tools/mocks/portone/server.mjs, 키 불필요)에 대고 돌리려면 `apiBase: 'http://127.0.0.1:12212'`
(ts) / `api_base="http://127.0.0.1:12212"` (py) 를 생성자에 넘긴다 — Stripe provider 의 `apiBase`
override 와 동일한 패턴.

## capabilities()

```pseudo
{ nativeSubscriptions: false, partialRefund: true, meters: false, scheduling: config.scheduling ?? 'provider', webhookSignature: true }
```
partialRefund 는 **PG 의존적**(EC:D14) — 일부 PG/할부 결제는 부분취소 불가. provider 는 사전 차단하지
않고 PortOne 이 반환하는 에러를 그대로 전파한다 (`deny_partial` 은 호출자가 에러로 관찰).

## [EC:E10 E6] createCustomer / createCheckout

```pseudo
createCustomer({email, name?, metadata?}):
  # PortOne V2 는 별도 고객 생성 API가 없다 — customer 는 결제 요청마다 인라인으로 넘기는 값.
  customerId = metadata.customerId ?? ('cus_' + sha256(email)[:40])
  return {ref: customerId}

createCheckout(input):
  paymentId = 'pay_' + sha256(input.idempotencyKey)[:40]   # EC:E6 — 더블클릭 시 같은 paymentId 재사용
  url = successUrl + '?paymentId=' + paymentId
  return {id: paymentId, url, providerRef: paymentId}
  # 앱은 (storeId, channelKey, paymentId, amount) 로 PortOne 클라이언트 SDK(requestPayment) 를 렌더링한다.
```

## [EC:E13 E10] confirmPayment (extra 메서드)

PortOne V2 는 Toss 와 달리 서버 confirm 호출이 필수는 아니지만(SDK 가 결제창에서 바로 승인), 프론트
성공 콜백만으로 지급하면 안 되는 원칙(EC:E13)은 동일하다 — **서버가 재조회로 검증**해야 한다.

```pseudo
confirmPayment(paymentId, expectedAmount) -> Payment:
  raw = GET /payments/{paymentId}
  if raw.status != 'PAID': throw PaymentKitError('payment_not_paid')
  if raw.amount.total != expectedAmount.amountMinor: throw PaymentKitError('amount_mismatch')   # EC:E10
  return normalizePortonePayment(raw)
```

## [EC:F] issueBillingKey / chargeBillingKey / schedulePayment / cancelSchedules

```pseudo
issueBillingKey({...}) -> {billingKey, raw}:
  raw = POST /billing-keys {storeId, channelKey, method, customer, ...}   # IssueBillingKeyBody
  return {billingKey: raw.billingKeyInfo.billingKey, raw}
  # 확인됨(2026-09-09, OpenAPI): 서버 전용 POST /billing-keys 는 실재하는 발급 경로다(클라이언트
  # SDK requestIssueBillingKey 와 별개). 응답(IssueBillingKeyResponse)은 { billingKeyInfo, ... } 로
  # 감싸져 있고 키 문자열은 billingKeyInfo.billingKey 에 있다 — top-level 이 아니다.

chargeBillingKey({billingKey, amount, orderId, customerRef, idempotencyKey}) -> Payment:   # core interface
  # orderId 를 PortOne 의 {paymentId} 경로 파라미터로 사용한다 (PortOne 은 Idempotency-Key 헤더 대신
  # 매 결제 시도마다 고유한 paymentId 를 클라이언트가 생성하는 방식으로 멱등성을 보장 — orderId 를 그 역할로 매핑).
  raw = POST /payments/{orderId}/billing-key
        {storeId, billingKey, orderName: 'Subscription charge', amount: {total: amount.amountMinor}, currency: amount.currency, customer: {id: customerRef}}
  # 확인됨(2026-09-09, OpenAPI PayWithBillingKeyResponse): raw 는 { payment: { pgTxId, paidAt } } 뿐인
  # 완료 요약이다 — 전체 Payment 객체가 아니다. 200 이면 동기 성공(실패는 non-2xx
  # PayWithBillingKeyError 로 온다)이므로, 이미 아는 값 + 요약의 paidAt/pgTxId 로 직접 구성한다.
  summary = raw.payment ?? raw
  return normalizePortonePayment({ id: orderId, status: 'PAID', amount: {total: amount.amountMinor},
    currency: amount.currency, customer: {id: customerRef}, paidAt: summary.paidAt,
    requestedAt: summary.paidAt, pgTxId: summary.pgTxId })

schedulePayment({billingKey, amount, orderId, customerRef, timeToPay}) -> extra:
  # 확인됨(2026-09-09, OpenAPI CreatePaymentScheduleBody = { payment: BillingKeyPaymentScheduleInput,
  # timeToPay }) — 결제 필드는 payment 로 감싸야 한다. 평평하게 보내면 안 된다.
  raw = POST /payments/{orderId}/schedule
        { payment: {storeId, billingKey, orderName: 'Subscription charge',
                     amount: {total: amount.amountMinor}, currency, customer: {id: customerRef}},
          timeToPay }
  return raw   # { schedule: { id, ... } }
  # scheduling='provider' 일 때 lifecycle 이 매 갱신 시점마다 이걸 호출해 다음 결제를 예약한다.

cancelSchedules({billingKey?, scheduleIds?}) -> extra:   # 둘 중 하나 필수
  # 확인됨(2026-09-09, OpenAPI): 실제 취소 엔드포인트는 DELETE /payment-schedules
  # (RevokePaymentSchedulesBody) — paymentId 로 스케줄을 취소하는 API는 존재하지 않는다.
  # 이전 초안의 DELETE /payments/{paymentId}/schedule 는 존재하지 않는 경로였다.
  raw = DELETE /payment-schedules {storeId, billingKey?, scheduleIds?}
  return raw   # { revokedScheduleIds, revokedAt }
```

## [EC:E8 E9] getPayment · 상태 정규화 · 실패 정규화

```pseudo
getPayment(paymentId) -> Payment:
  raw = GET /payments/{paymentId}
  return normalizePortonePayment(raw)
```

상태 매핑 (normalizePortoneStatus):

| PortOne status | 정규화 |
|---|---|
| READY | pending |
| PAY_PENDING | pending — 확인됨(2026-09-09, OpenAPI Payment discriminator): 실제 리터럴은 `PAY_PENDING` 이지 `PENDING` 이 아니다 (이전 초안 버그) |
| VIRTUAL_ACCOUNT_ISSUED | pending — **지급 금지** (EC:E8, Toss WAITING_FOR_DEPOSIT 과 동일 취급) |
| PAID | succeeded |
| FAILED | failed |
| CANCELLED | refunded |
| PARTIAL_CANCELLED | partially_refunded |

실패 정규화 (EC:E9 — "뒤에 여러 PG, PG 별 실패 코드"): `raw.failure.pgCode/pgMessage` 를 원본 그대로
`providerCode`/`userMessage` 에 보존하고, 텍스트 휴리스틱으로만 대략 분류한다(PG 마다 코드 체계가 달라
전수 매핑이 불가능 — 이후 실제 실패 로그로 보강):

```pseudo
code = pgCode.includes('INSUFFICIENT') -> 'insufficient_funds'
     | pgCode.includes('EXPIRED')      -> 'expired_card'
     | pgCode.includes('DECLINE'|'REJECT') -> 'card_declined'
     | pgCode.includes('TIMEOUT'|'NETWORK'|'UNAVAILABLE') -> 'provider_unavailable' (retryable=true)
     | else -> 'unknown'
```

## listPayments — 확인됨(2026-09-09): customer 필터 없음, requestBody 쿼리 파라미터

```pseudo
listPayments({customerRef, since}) -> Payment[]:
  # 확인됨(OpenAPI GetPaymentsBody = { page?, filter? }): GET /payments 는 `requestBody` 라는
  # 단일 쿼리 파라미터에 URL-encode 된 JSON 을 싣는다 — filter.from 같은 평평한 파라미터가 아니다.
  # 그리고 PaymentFilterInput 에는 customer id 필터 필드가 아예 없다(merchantId/storeId/
  # timestampType/from/until/status/methods/pgProvider/isTest/isScheduled/sortBy/sortOrder/
  # version/webhookStatus/platformType/currency/isEscrow/escrowStatus/card*/giftCertificateType/
  # cashReceipt*/textSearch 가 전부) — 서버사이드 customer 필터는 불가능하다고 확정됐다.
  requestBody = JSON.stringify({ filter: { from: since } })
  raw = GET /payments?requestBody={urlencode(requestBody)}
  return raw.items.filter(p => p.customer?.id == customerRef).map(normalizePortonePayment)
  # cs.reconcile 등 이 메서드를 쓰는 다른 패키지는 "date range 만 서버가 걸러주고 customer 매치는
  # 클라이언트가 한다"는 전제로 문서화해야 한다.
```

## getSubscription / changeSubscription / cancelSubscription / uncancelSubscription — 계약 변경 제안

Toss 와 동일한 이유로 `unsupported` 를 던진다 (Subscription 필드를 지어낼 수 없음 — 값-출처
원칙). scheduling='provider' 인 경우도 PortOne 의 "schedule" 은 결제 예약이지 우리 `Subscription`
엔티티가 아니므로 동일하게 처리한다. `uncancelSubscription` 은 2026-09-09 `PaymentProvider` 계약에
신설된 A23 메서드 — PortOne 도 구독 상태를 안 갖고 있으므로 동일한 이유로 `unsupported`.

```pseudo
getSubscription/changeSubscription/cancelSubscription/uncancelSubscription(...): throw PaymentKitError('unsupported')
```

## [EC:D4 D13 D14 D6] refund

```pseudo
refund({paymentRef, amount, reason, idempotencyKey, extra}) -> Refund:
  body = {storeId, reason}
  if amount: body.amount = amount.amountMinor          # 부분 환불 EC:D4 — PG 미지원 시 PortOne 이 에러 반환 (EC:D14)
  if extra?.refundAccount: body.refundAccount = extra.refundAccount   # 가상계좌 환불 계좌 (EC:D13 과 동일 패턴)
  raw = POST /payments/{paymentRef}/cancel body
  return normalizePortoneRefund(raw)
  # EC:D6 — 환불액은 결제 통화·결제 금액 기준. PortOne 결제 통화는 payment.currency 에서 그대로 가져온다.
```
Toss 와 동일하게 `Refund.customerId`/`ruleId` 는 빈 값으로 반환 — `refund.execute` 가 채워야 한다
(계약 변경 제안, toss.pseudo.md 와 동일).

## [EC:K2 K3 K4 K5 K6 K7] issueCashReceipt / cancelCashReceipt / getCashReceipt (core 인터페이스 밖 extra 메서드)

한국 B2C 결제의 법정 의무. 세 메서드 모두 `PaymentProvider` 코어 인터페이스 밖의 extra 메서드다.
브리프는 `POST /payments/{paymentId}/cash-receipt` 를 발급 엔드포인트로 가정했으나 **실제
V2 OpenAPI 스펙(portone-io/server-sdk `codegen/openapi.json`, 2026-09-09 fetch)엔 그런 엔드포인트가
없다** — 결제 스코프의 `cash-receipt` 경로는 `GET`(단건 조회) 과 `POST .../cancel`(취소) 뿐이고,
발급은 독립된 `/cash-receipts` 리소스(`paymentId` 를 바디에 넣어 지정)다. 계약 변경 제안이 아니라
**엔드포인트 자체가 다르다** — 이 spec 은 실제 스펙을 따른다.

```pseudo
issueCashReceipt({paymentRef, type, customerIdentityNumber, orderName?, taxFreeAmountMinor?,
                   customerName?, customerEmail?, customerPhoneNumber?}) -> CashReceipt:
  if !channelKey: throw PaymentKitError('channel_key_required')   # IssueCashReceiptBody 필수 필드
  rawPayment = GET /payments/{paymentRef}
  # EC:K4 — PaidPayment.method 는 discriminated union({type: 'PaymentMethodCard'|...})
  # (실제 스펙 확인). PortOne 이 여러 PG 를 정규화하므로 method 리포팅이 PG 마다 다를 수 있어
  # 이 판별은 normalizePortoneFailure 와 같은 급의 휴리스틱이다(문서화됨).
  if rawPayment.method?.type == 'PaymentMethodCard':
    throw PaymentKitError('cash_receipt_unsupported_for_payment_method')
  body = {
    paymentId: paymentRef, channelKey,
    type: type == 'business' ? 'CORPORATE' : 'PERSONAL',   # EC:K3 — CashReceiptType enum
    orderName: orderName ?? rawPayment.orderName ?? 'Payment',
    currency: rawPayment.currency ?? 'KRW',
    amount: {total: rawPayment.amount.total, taxFree: taxFreeAmountMinor},
    customer: {identityNumber: customerIdentityNumber, name: customerName, email: customerEmail, phoneNumber: customerPhoneNumber},
  }
  raw = POST /cash-receipts body
  # IssueCashReceiptResponse = {cashReceipt: CashReceiptSummary} — CashReceiptSummary 는
  # {issueNumber, url, pgReceiptId} 뿐인 요약이지 완전한 CashReceipt 객체가 아니다(실제 스펙
  # 확인) — 나머지 필드(paymentId/type/amount)는 우리가 이미 아는 값으로 합성한다.
  return normalizePortoneCashReceipt({status:'ISSUED', paymentId: paymentRef, type: body.type,
                                       amount: rawPayment.amount.total, currency: body.currency,
                                       issueNumber: raw.cashReceipt.issueNumber, url: raw.cashReceipt.url})

cancelCashReceipt({paymentRef}) -> CashReceipt:
  # EC:K5 — 실제 스펙 확인: 이 엔드포인트는 requestBody 가 아예 없다(쿼리 파라미터 storeId 만) —
  # **부분 취소를 지원하지 않는다.** Toss 와 달리 amount 파라미터 자체가 없어 항상 전액 취소다.
  raw = POST /payments/{paymentRef}/cash-receipt/cancel?storeId={storeId}
  # CancelCashReceiptResponse = {cancelledAmount, cancelledAt} 뿐 — 영수증 신원 필드가 없어
  # paymentRef 로 합성한다.
  return normalizePortoneCashReceipt({status:'CANCELLED', paymentId: paymentRef, amount: raw.cancelledAmount})

getCashReceipt({paymentRef}) -> CashReceipt | null:
  # EC:K7 — GET /payments/{paymentId}/cash-receipt. 없으면 404 CashReceiptNotFoundError —
  # 이를 예외가 아니라 null 로 매핑해 "아직 발행 안 됨" 을 정상 케이스로 다룬다.
  try: raw = GET /payments/{paymentRef}/cash-receipt; return normalizePortoneCashReceipt(raw)
  catch ProviderError as e:
    if e.failure.providerCode == 'CashReceiptNotFoundError': return null
    throw e
```

`CashReceipt` (oneOf `IssuedCashReceipt`/`IssueFailedCashReceipt`/`CancelledCashReceipt`,
discriminator `status`) 스키마는 실제 OpenAPI 스펙으로 확인했다. **실서비스 API 로는 재현하지
못했다** — 이 환경에서 완결 가능한 (cash-eligible 결제를 실제로 완료할 수 있는) PortOne 테스트
결제 건이 없었다(`apps/cli/src/commands/live.ts` 의 portone 섹션도 마찬가지로 실결제를 한 번도
완료하지 못함). Toss 쪽처럼 실측 확인은 못 했고, 스펙 문서 대조로만 검증됐다 — 최종 보고에 명시.

**중복 발행 가드 (EC:K7)** · **결제·환불 롤백 금지 (EC:K6)** — toss.pseudo.md 와 동일 원칙:
provider 는 dedup 을 제공하지 않으므로 호출자가 발행 여부를 기록해야 하고, 발행·취소 실패는
결제/환불 성공을 롤백하지 않는다(`refund.pseudo.md` "[EC:K5 K6] execute" 참고).

## reportUsage

```pseudo
reportUsage(...): throw PaymentKitError('unsupported')   # capabilities().meters = false
```

## [EC:E4] verifyWebhook — Standard Webhooks (Svix 호환)

```pseudo
verifyWebhook({headers, rawBody}) -> NormalizedEvent:
  id = headers['webhook-id']; timestamp = headers['webhook-timestamp']; sigHeader = headers['webhook-signature']
  if !id or !timestamp or !sigHeader: throw WebhookSignatureError
  if abs(now() - timestamp) > 300s: throw WebhookSignatureError   # 5분 tolerance
  key = base64_decode(webhookSecret.replace('whsec_', ''))
  signedContent = `${id}.${timestamp}.${rawBody}`
  expected = base64(HMAC_SHA256(key, signedContent))
  ok = any(sig in sigHeader.split(' ').map(s => s.split(',')[1]) where timingSafeEqual(sig, expected))
  if !ok: throw WebhookSignatureError
  event = mapPortoneWebhook(JSON.parse(rawBody))
  event.id = id   # svix/webhook-id 는 메시지 단위 고유값 — 재전송에도 동일해 idempotency_key 로 그대로 쓴다
  return event
```

웹훅 매핑 (mapPortoneWebhook, `body.type` + `body.data` 기준, body = `{type, timestamp, data}`):

| type | NormalizedEvent.type |
|---|---|
| Transaction.Paid | payment.succeeded |
| Transaction.Failed | payment.failed |
| Transaction.Cancelled | refund.created |
| Transaction.PartialCancelled | refund.created |
| Transaction.VirtualAccountIssued | payment.pending |
| Transaction.PayPending | payment.pending |
| Transaction.CancelPending | refund.pending |

| Transaction.DisputeCreated | dispute.opened |
| Transaction.DisputeResolved | dispute.closed |
| BillingKey.* (Issued/Failed/Deleted/Updated/Ready) | unknown — 로그만, 지급 로직 미연동 (브리프 지시대로) |
| 그 외 | unknown |

`data.paymentId` → `paymentRef`. **핸들러는 반드시 재조회한다 (EC:E3)** — 여기서도 정규화만 하고
지급 트리거는 `webhook.default_handlers` 가 `provider.getPayment(paymentRef)` 재조회 후 결정한다.

## self-scheduler 계약

`scheduling='self'` 일 때는 toss.pseudo.md 의 self-scheduler 계약과 동일 (`chargeBillingKey` 반복 호출).
`scheduling='provider'` 일 때는 `lifecycle` 이 최초 1회만 `schedulePayment` 를 호출해 다음 결제를 예약하고,
PortOne 이 자체적으로 결제를 실행한 뒤 `Transaction.Paid`/`Transaction.Failed` 웹훅으로 결과를 통지한다 —
이 경우 `lifecycle.scheduler.tick` 은 due_subscriptions 를 폴링하지 않고 webhook 만 기다린다
(구현 갈림길이므로 lifecycle 쪽에 `scheduling` 값을 전달해 분기해야 함 — 계약 확인 필요, 최종 보고 기재).

## [EC:L5] withCorrelationId — correlationId scoping (added 2026-09-09)

`PortoneProvider` implements a duck-typed `withCorrelationId(correlationId) -> PaymentProvider`
(ts) / `with_correlation_id(correlation_id)` (py) — NOT part of the shared `PaymentProvider`
interface/Protocol, so this is additive only. Returns a scoped clone whose `request()`/logging
uses `correlationId` instead of the per-call idempotencyKey-derived default (falls back to that
default when no override is set — unchanged behavior from before this addition). `packages/webhook`
calls it from `process()` when present, threading one webhook delivery's correlationId through
every provider call the handler makes for that delivery. See
`packages/webhook/spec/webhook.pseudo.md` [EC:L5] for the full design; regression coverage in
`ts/test/correlation-id.test.ts` / `py/tests/test_portone_correlation_id.py`.

### Refund cancellation identity and authoritative lookup (2026-09-10)

- Refund response `cancellation.id` becomes `Refund.providerRef`; status `SUCCEEDED` -> succeeded, `FAILED` -> failed, `REQUESTED` or unrecognized/missing status -> pending. `requestedAt` supplies creation time before `cancelledAt` exists.
- Webhook `data.cancellationId` becomes `refundRef`. `Transaction.Cancelled` / `Transaction.PartialCancelled` are final-success notifications; `Transaction.CancelPending` is `refund.pending`, never payment.pending.
- Webhook bodies contain no individual refund amount. Keep amount null and read the actual cancellation with `getRefund({paymentRef, refundRef})` / `get_refund(...)`: GET payment, exact `cancellations[].id` match, use its `totalAmount` and payment currency (`KRW`, not `CURRENCY_KRW`). No match returns null.
- No `Transaction.CancelFailed` webhook is documented. A failed authoritative cancellation can be reconciled when queried; no invented webhook type is treated as a failure.
- Delivery identity (`webhook-id`) stays separate from cancellation identity. The direct mapper's fallback ID also includes cancellationId, separating same-time partial refunds.

Sources: [cancellation integration](https://developers.portone.io/opi/ko/integration/cancel/v2/readme), [webhook contract](https://developers.portone.io/opi/ko/integration/webhook/readme-v2?v=v2), [official cancellation schema](https://raw.githubusercontent.com/portone-io/server-sdk/main/javascript/src/generated/payment/PaymentCancellation.ts).
