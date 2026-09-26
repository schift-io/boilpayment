# Polar Provider — spec

`PaymentProvider` 구현. `docs/ARCHITECTURE.md` §3.4/3.5, `docs/EDGE_CASES.md` F(Polar) 절 참조.
ts: `PolarProvider` (`packages/providers/polar/ts/src/index.ts`), `@polar-sh/sdk@0.20`
py: `PolarProvider` (`packages/providers/polar/py/src/boilpayment_polar/__init__.py`), `polar-sdk` (설치판 0.32)

**Polar 자체 Benefits(크레딧/라이선스키)는 사용하지 않는다. 이 킷의 원장(ledger)이 재화의 유일한 소스
오브 트루스다.** Polar 는 결제·구독 상태·환불만 담당한다 (EC F 표).

## Capabilities

```
nativeSubscriptions: true
partialRefund:       true    (RefundCreate.amount 로 부분 환불 가능 — SDK 확인함)
meters:               true    (Events.ingest → Polar Meters 로 집계)
scheduling:          'provider'
webhookSignature:    true    (Standard Webhooks: webhook-id/webhook-timestamp/webhook-signature)
```

## 생성자

```
PolarProvider({ accessToken, webhookSecret, server?: 'production' | 'sandbox' })
```

## SDK 버전 불일치 — webhook 은 수동 검증

설치된 `@polar-sh/sdk@0.20.2` 의 `webhooks.validateEvent` 헬퍼는 `order.paid` / `order.refunded` /
`subscription.past_due` 등 최신 이벤트 타입을 모른다(내부 switch 에 없어 `SDKValidationError` 를
던짐). 반면 py `polar-sdk`(설치판 0.32.0)는 이 타입들을 지원한다. **언어 간 일관성을 위해 SDK
헬퍼에 의존하지 않고 Standard Webhooks 서명 검증을 직접 구현한다** (ts: `node:crypto`, py: `hmac`/`hashlib`).
파싱은 raw JSON 만 사용하고 SDK 의 이벤트 모델 클래스는 쓰지 않는다.

```pseudo
[EC:webhookSignature] verify_webhook(headers, raw_body, secret)
steps:
  id = headers['webhook-id']; timestamp = headers['webhook-timestamp']; sig_header = headers['webhook-signature']
  if not (id and timestamp and sig_header): raise WebhookSignatureError
  signed_content = f"{id}.{timestamp}.{raw_body}"
  key = base64_decode(secret.removeprefix('whsec_'))
  expected = base64_encode(HMAC_SHA256(key, signed_content))
  candidates = [part.split(',',1)[1] for part in sig_header.split(' ') if ',' in part]  # "v1,<b64>" 여러 개 가능
  if expected not in candidates: raise WebhookSignatureError
  event = json.loads(raw_body)
  return to_normalized_event(event)
```

## 엔드포인트 매핑

| PaymentProvider 메서드 | Polar 호출 | 비고 |
|---|---|---|
| `createCustomer` | `customers.create({email, name, externalId?})` | `{ ref: customer.id }` |
| `createCheckout` | `POST /v1/checkouts/ {products:[price.providerPriceRefs.polar], customer_id: customerRef, metadata:{...input.metadata, planId}, success_url}` | Polar 체크아웃은 상품(Product) 단위 — `price.providerPriceRefs.polar` 를 Polar Product ID 로 취급. 없으면 `PaymentKitError('missing_provider_price_ref')`. mode(subscription/one_time) 는 상품 설정에 귀속되어 Polar 쪽에서 결정 — 우리는 전달만. idempotencyKey 는 `httpHeaders:{'Idempotency-Key':...}` 로 best-effort 전달(Polar 공식 문서에 idempotency 헤더 지원이 명시돼있지 않음 — 없어도 무해). 반환 `{id: checkout.id, url: checkout.url, providerRef: checkout.id}` |
| `getPayment(ref)` | `orders.get({id: ref})` | order 가 결제 단위. kind: `order.subscriptionId` 있으면 `subscription`, 없으면 `topup` |
| `listPayments({customerRef, since})` | `orders.list({customerId: customerRef})` 후 `createdAt >= since` 로 필터 (list API 가 since 필터 미제공) | H4·E1 대조용 |
| `getSubscription(ref)` | `subscriptions.get({id: ref})` | `id`/`customerId`/`planId` 는 `metadata.subscriptionId`/`metadata.customerId`/`metadata.planId` 읽어 채움 (stripe.pseudo.md 의 "계약 메모"와 동일 규칙) |
| `changeSubscription(ref, {newPriceRef, proration, resetAnchor})` | `subscriptions.update({id:ref, subscriptionUpdate:{productId:newPriceRef, prorationBehavior: proration==='immediate'?'prorate':'next_period'}})` | Polar 에는 `billing_cycle_anchor` 리셋 개념이 없음 — `resetAnchor` 는 무시하고 spec 에 문서화(F). `prorationBehavior:'reset'` 옵션이 있으나 이는 사이클 자체를 리셋하는 다른 의미라 A1 의 reset_anchor 요구와 정확히 대응하지 않음 — `resetAnchor=true` 여도 매핑하지 않는다(계약 메모 참고) |
| `cancelSubscription(ref, {atPeriodEnd})` | atPeriodEnd → `subscriptions.update({id:ref, subscriptionUpdate:{cancelAtPeriodEnd:true}})` / false → `subscriptions.revoke({id:ref})` | A5 |
| `uncancelSubscription(ref)` | `GET /v1/subscriptions/{ref}` 로 현재 status 확인 → `canceled`/`revoked` 면 실제 Polar status 를 담아 `PaymentKitError('not_reactivatable')` 던짐 / 아니면 changeSubscription/cancelSubscription 과 동일 엔드포인트로 `PATCH /v1/subscriptions/{ref} {cancel_at_period_end:false}` | A23 (2026-09-09 신설 — Polar 공식 문서(`polar.sh/docs/features/subscriptions/manage`) 확인: 별도 uncancel 엔드포인트는 없고 `cancel_at_period_end` 를 PATCH 로 되돌리는 것이 곧 uncancel. 이미 끝난 구독엔 거부됨) |
| `chargeBillingKey` | — | Polar 는 자체 스케줄링. `throw PaymentKitError('billing key charge unsupported for polar (native subscriptions)', 'unsupported')` |
| `refund({paymentRef, amount, reason, idempotencyKey, extra})` | `refunds.create({orderId: paymentRef, amount: amount.amountMinor, reason: mapReason(reason)})` | D4 D6: 결제 통화·금액 그대로. reason 매핑: `duplicate`→`duplicate`, `fraudulent`→`fraudulent`, 그 외→`customer_request` |
| `reportUsage({meter, customerRef, quantity, occurredAt, idempotencyKey})` | `events.ingest({events:[{name:meter, customerId:customerRef, metadata:{value:quantity}, timestamp:occurredAt, externalId:idempotencyKey}]})` | C4: `externalId` 로 Polar 측 중복 수집 방지(문서화된 dedup 필드). 로컬 `usage_events` 가 원본 |
| `verifyWebhook` | 위 "SDK 버전 불일치" 섹션 | E4 |

## Webhook 이벤트 매핑

| Polar `type` | `NormalizedEventType` | 필드 소스 |
|---|---|---|
| `order.paid` | `payment.succeeded` | paymentRef=order.id, subscriptionRef=order.subscription_id, customerRef=order.customer_id, amount=order.total_amount |
| `order.created` (미지급, `order.paid=false`) | `payment.pending` | 〃 |
| `order.refunded` | `unknown` | 누적 주문 스냅샷: refundRef=null, raw 보존 |
| `subscription.created` | `subscription.created` | subscriptionRef=subscription.id, customerRef=subscription.customer_id |
| `subscription.updated` / `subscription.active` / `subscription.uncanceled` | `subscription.updated` | 〃 |
| `subscription.canceled` | `subscription.canceled` | 〃 |
| `subscription.revoked` | `subscription.canceled` | 〃 (완전 종료) |
| `subscription.past_due` | `subscription.payment_failed` | 〃 |
| `refund.created`, `refund.updated` | status=`succeeded` → `refund.created`; `failed`/`canceled` → `refund.failed`; 나머지 → `refund.pending` | refundRef=refund.id, paymentRef=refund.order_id, amount=refund.amount |
| 그 외 (`checkout.*`, `customer.*`, `benefit.*`, `product.*` 등) | `unknown` | raw 보존. Benefits 이벤트는 원장과 무관하므로 무시 |

## [EC:F(Polar)] 자체 Benefits 미사용

```pseudo
# Polar 의 Benefits(크레딧/라이선스키) 기능은 사용하지 않는다.
# credits 모듈의 원장(ledger)만이 잔액의 원본이다. Benefits 관련 webhook(benefit.*, benefit_grant.*)은
# type='unknown' 으로 정규화되고 default_handlers 는 이를 무시한다.
```

## [EC:E12] 실패 코드 정규화

Polar 는 결제 실패 사유를 `order.status` 수준에서만 노출하고(카드사 디클라인 코드 원문은 제공 안 함),
주문이 실패하면 `order`가 생성되지 않고 checkout 이 `expired`/`failed` 로 남는 경우가 많다.
provider 실패 정규화는 아래처럼 보수적으로 처리한다.

```pseudo
input: { message?: string }
steps:
  return { code:'unknown', providerCode:null, retryable:true, userMessage: message ?? '결제 처리 중 오류가 발생했습니다. 다시 시도해 주세요.' }
```

## [EC:E7] requires_action

```pseudo
# Polar Checkout 은 완료(성공) 또는 미완료(만료/실패)만 노출하고 별도의 3DS 보류 상태를 우리에게 넘기지 않음.
# order 가 아직 없으면 Payment.status='pending' 으로 취급 (E13 과 동일하게 webhook 만 신뢰).
```

## [EC:E13] success URL 은 UX 전용

```pseudo
# createCheckout 의 successUrl 은 화면 전용. 지급은 order.paid webhook 만 신뢰.
```

## [EC:E6] 체크아웃 이중 클릭

```pseudo
# idempotencyKey 를 Idempotency-Key 헤더로 best-effort 전달(공식 지원 미확인).
# 신뢰 가능한 방어선은 앱 레이어의 idempotencyKey = checkout:{customerId}:{planId}:{floor(now,1m)} 자체.
```

## [EC:D6] 통화

```pseudo
# 환불은 order 의 결제 통화·금액(minor unit) 그대로 refunds.create 에 전달. 환산 없음.
```

## [EC:D11] 세금

```pseudo
# Polar 는 Merchant of Record — 세금·환불세금 계산은 Polar 가 전담(P1, 문서화만).
```

## 계약 메모 (core 계약 변경 제안 아님 — 구현 판단)

stripe.pseudo.md 의 "계약 메모"와 동일: `getSubscription`/`getPayment` 의 `id`/`customerId`/`planId`
는 Polar 객체의 `metadata` 를 읽어 채우고, 없으면 빈 문자열 — 호출부가 자신의 repo 로 덮어써야 한다.

`changeSubscription` 의 `resetAnchor` 는 Polar API 에 대응 개념이 없어 무시된다. `policy.upgrade.mode`
가 `immediate_prorate_reset_anchor` 인 배포에서 Polar 를 쓰면 anchor 는 Polar 의 기본 갱신 로직을
따른다 — 위저드/문서에 안내 필요(향후 CLI 담당자에게 전달할 사항).

## [EC:L5] withCorrelationId — correlationId scoping (added 2026-09-09)

`PolarProvider` implements a duck-typed `withCorrelationId(correlationId) -> PaymentProvider`
(ts) / `with_correlation_id(correlation_id)` (py) — NOT part of the shared `PaymentProvider`
interface/Protocol, so this is additive only. Returns a scoped clone whose `request()`/logging
uses `correlationId` instead of the per-call idempotencyKey-derived default (falls back to that
default when no override is set — unchanged behavior from before this addition). `packages/webhook`
calls it from `process()` when present, threading one webhook delivery's correlationId through
every provider call the handler makes for that delivery. See
`packages/webhook/spec/webhook.pseudo.md` [EC:L5] for the full design; regression coverage in
`ts/test/correlation-id.test.ts` / `py/tests/test_polar_correlation_id.py`.


## 환불 웹훅의 식별자와 확정 시점

서명이 확인된 `webhook-id` 헤더를 `NormalizedEvent.id`로 사용한다.
`refundRef`는 `data.id`이며, 전달 ID를 환불 ID로 대신 사용하지 않는다.
같은 환불에 대한 여러 `refund.updated` 이벤트는 각각 처리하고, 같은 전달의 재시도만 중복 제거한다.
`refund.created`도 `status=pending`이면 아직 성공이 아니다. `refund.created`와 `refund.updated`를 모두 구독한다.
`order.refunded`는 개별 환불을 식별할 수 없어 원장 확정 이벤트로 사용하지 않는다.

근거: [Polar refund.updated](https://polar.sh/docs/api-reference/webhooks/refund.updated),
[공식 Refund 스키마](https://github.com/polarsource/polar/blob/main/server/polar/refund/schemas.py),
[공식 RefundStatus 정의](https://github.com/polarsource/polar/blob/main/server/polar/models/refund.py),
[웹훅 서명 검증](https://polar.sh/docs/integrate/webhooks/delivery).


## 체크아웃 권한 스냅샷의 결제 연결

`customerRef`는 `createCustomer`가 반환한 Polar 고객 ID이므로 체크아웃의 `customer_id`로 전달한다.
`external_customer_id`는 앱 자체 고객 ID를 의미하여 여기에 provider ID를 넣으면 다른 고객이 생성될 수 있다.
`checkoutEntitlementKey`를 포함한 checkout metadata는 Polar가 order/subscription에 복사하며,
`getPayment`는 order metadata를 `Payment.raw`에 보존한다. 문서화된 `/v1/checkouts/`를 사용한다.
기존 `/v1/checkouts/custom/`는 공식 서버 소스에 숨겨진 호환 alias로 남아 있다.

근거: [Polar checkout 생성 및 metadata 전파](https://polar.sh/docs/api-reference/checkouts/create-session),
[공식 checkout route](https://github.com/polarsource/polar/blob/main/server/polar/checkout/endpoints.py).
