# Stripe Provider — spec

`PaymentProvider` 구현. `docs/ARCHITECTURE.md` §3.4/3.5, `docs/EDGE_CASES.md` F(Stripe) 절 참조.
ts: `StripeProvider` (`packages/providers/stripe/ts/src/index.ts`)
py: `StripeProvider` (`packages/providers/stripe/py/src/schift_payment_kit_stripe/__init__.py`)

## Capabilities

```
nativeSubscriptions: true
partialRefund:       true
meters:               true   (Billing Meter Events)
scheduling:          'provider'   (Stripe Billing 이 갱신을 자체 스케줄링)
webhookSignature:    true
```

## 생성자

```
StripeProvider({ secretKey, webhookSecret, apiVersion? })
```
`apiVersion` 미지정 시 SDK 기본값 사용. `Stripe(secretKey, { apiVersion, typescript: true })`.

## 엔드포인트 매핑

| PaymentProvider 메서드 | Stripe 호출 | 비고 |
|---|---|---|
| `createCustomer` | `customers.create({ email, name, metadata })` | `{ ref: customer.id }` |
| `createCheckout` | `checkout.sessions.create({ mode, customer: customerRef, client_reference_id: customerRef, line_items:[{price: price.providerPriceRefs.stripe, quantity:1}], metadata:{...input.metadata, planId}, subscription_data/payment_intent_data:{metadata}, success_url, cancel_url }, { idempotencyKey })` | mode `subscription`→`'subscription'`, `one_time`→`'payment'`. `price.providerPriceRefs.stripe` 없으면 `PaymentKitError('missing_provider_price_ref')`. 반환 `{id: session.id, url: session.url, providerRef: session.id}` |
| `getPayment(ref)` | `pi_...` → `paymentIntents.retrieve(ref, {expand:['invoice']})`. `in_...` → `invoices.retrieve(ref)` 후 legacy payment_intent 또는 basil payments.data의 PaymentIntent 별도 조회 | E7: PaymentIntent 상태 → `requires_action`. invoice 존재 시 kind=`subscription`, 아니면 `topup` |
| `listPayments({customerRef, since})` | `invoices.list({customer, created:{gte: unix(since)}})` + `paymentIntents.list({customer, created:{gte: unix(since)}})` | invoice 에 연결된 PaymentIntent 는 invoice 결과로만 카운트 (payment_intent.id 기준 dedup). H4·E1 대조용 |
| `getSubscription(ref)` | `subscriptions.retrieve(ref, {expand:['items']})` | E3 재조회. `id`/`customerId`/`planId` 는 Stripe subscription/customer `metadata.subscriptionId` `metadata.customerId` `metadata.planId` 를 읽어 채운다(체크아웃 시 심어둔 값). 없으면 빈 문자열 — **호출부(lifecycle)가 자기 repo 로 덮어써야 함**. 아래 "계약 메모" 참조 |
| `changeSubscription(ref, {newPriceRef, proration, resetAnchor})` | `subscriptions.retrieve(ref)` → `subscriptions.update(ref, {items:[{id: currentItem.id, price:newPriceRef}], proration_behavior: proration==='immediate'?'create_prorations':'none', billing_cycle_anchor: resetAnchor?'now':undefined})` | A1 `immediate_prorate_reset_anchor`→proration=immediate,resetAnchor=true. `keep_anchor`→resetAnchor=false. Stripe 는 interval 변경 시 anchor 를 강제 리셋함(F, `reset_anchor` 문서 참고) — resetAnchor=false 요청이어도 월↔연 전환이면 Stripe 가 리셋한다. 우리는 요청값만 그대로 전달하고 결과 anchor 는 재조회로 반영 |
| `cancelSubscription(ref, {atPeriodEnd})` | atPeriodEnd → `subscriptions.update(ref, {cancel_at_period_end:true})` / false → `subscriptions.cancel(ref)` | A5 |
| `uncancelSubscription(ref)` | `subscriptions.retrieve(ref)` 로 현재 status 확인 → 이미 `canceled` 면 실제 Stripe status 를 담아 `PaymentKitError('not_reactivatable')` 던짐(Stripe 는 완전히 끝난 구독의 update 를 거부함) / 아니면 `subscriptions.update(ref, {cancel_at_period_end:false})` | A23 (2026-09-09 신설 — lifecycle.reactivate 의 "계약 변경 제안" 갭을 닫는다) |
| `chargeBillingKey` | — | Stripe 는 자체 스케줄링(Billing)이라 미지원. `throw new PaymentKitError('billing key charge unsupported for stripe (native subscriptions)', 'unsupported')` |
| `refund({paymentRef, amount, reason, idempotencyKey, extra})` | `paymentRef` 가 `in_...` 면 invoice 재조회로 `payment_intent` 추출. `refunds.create({payment_intent, amount: amount.amountMinor, reason: mapReason(reason)}, {idempotencyKey})` | D4 D6: 환불은 결제 통화·금액 기준 그대로 전달(minor unit). reason 매핑: `duplicate`→`duplicate`, `fraudulent`→`fraudulent`, 그 외→`requested_by_customer` |
| `reportUsage({meter, customerRef, quantity, occurredAt, idempotencyKey})` | `billing.meterEvents.create({event_name: meter, payload:{stripe_customer_id: customerRef, value: String(quantity)}, identifier: idempotencyKey, timestamp: unix(occurredAt)})` | C4: 로컬 `usage_events` 가 원본, 이 호출은 outbox 에서 재시도 |
| `verifyWebhook({headers, rawBody})` | `webhooks.constructEvent(rawBody, headers['stripe-signature'], webhookSecret)` | 실패 시 `WebhookSignatureError` (E4) |

## Webhook 이벤트 매핑

| Stripe `event.type` | `NormalizedEventType` | 필드 소스 |
|---|---|---|
| `invoice.paid` | `payment.succeeded` | paymentRef=invoice.id, subscriptionRef=invoice.subscription, customerRef=invoice.customer, amount=invoice.amount_paid |
| `invoice.payment_failed` | `subscription.payment_failed` | subscriptionRef=invoice.subscription, customerRef=invoice.customer |
| `checkout.session.completed` (mode=`payment`) | `payment.succeeded` | paymentRef=session.payment_intent, customerRef=session.customer ?? client_reference_id |
| `checkout.session.completed` (mode=`subscription`) | `subscription.created` | subscriptionRef=session.subscription, customerRef=session.customer |
| `payment_intent.succeeded` | `payment.succeeded` **단, `invoice` 필드가 없을 때만** (E3 중복 방지 — invoice.paid 가 이미 지급을 트리거함) | paymentRef=pi.id |
| `payment_intent.payment_failed` | `payment.failed` | paymentRef=pi.id, failure=normalizeFailure(pi.last_payment_error) |
| `customer.subscription.created` | `subscription.created` | subscriptionRef=sub.id, customerRef=sub.customer |
| `customer.subscription.updated` | `subscription.updated` | 〃 |
| `customer.subscription.deleted` | `subscription.canceled` | 〃 |
| `refund.created`, `refund.updated`, `charge.refund.updated`, `refund.failed` | status=`succeeded` → `refund.created`; `failed`/`canceled` → `refund.failed`; 나머지 → `refund.pending` | refundRef=refund.id, paymentRef=refund.payment_intent, amount=refund.amount |
| `charge.refunded` | `unknown` | 누적 charge.amount_refunded는 개별 환불 금액이 아님. refundRef=null, raw 보존 |
| `charge.dispute.created` | `dispute.opened` | paymentRef=dispute.payment_intent |
| `charge.dispute.closed` | dispute.status==='lost' → `dispute.closed` (D9 on_lost 는 cs 모듈이 판정) | 〃 |
| 그 외 | `unknown` | raw 그대로 보존 |

## [EC:E7] requires_action (3DS/SCA)

```pseudo
input: PaymentIntent (status)
steps:
  if pi.status in {requires_action, requires_confirmation, requires_payment_method}:
    Payment.status = 'requires_action'
  # 확정 webhook(payment_intent.succeeded 또는 invoice.paid) 도착 전까지 지급 보류는 lifecycle 책임
output: Payment{status:'requires_action'}
```

## [EC:E12] 실패 코드 정규화

```pseudo
input: Stripe.last_payment_error { code, decline_code, message }
steps:
  key = decline_code ?? code
  if key in FAILURE_MAP: return FAILURE_MAP[key]  # 표 아래 참조
  else: return { code:'unknown', providerCode:key, retryable:false, userMessage: message ?? '...' }
idempotencyKey: n/a (순수 함수)
```

실패 코드 표 (`FAILURE_MAP`):

| Stripe code/decline_code | 정규화 code | retryable |
|---|---|---|
| `insufficient_funds` | `insufficient_funds` | true |
| `card_declined` (generic) | `card_declined` | false |
| `expired_card` | `expired_card` | false |
| `processing_error` | `processing_error` | true |
| `incorrect_cvc` | `incorrect_cvc` | true |
| `incorrect_number` | `incorrect_number` | true |
| `authentication_required` | `authentication_required` | true |
| `lost_card` / `stolen_card` | `lost_card`/`stolen_card` | false |
| `api_connection_error` / `api_error` / `rate_limit_error` | `provider_unavailable` | true (E12) |
| 그 외 | `unknown` | false |

## [EC:E13] success URL 은 UX 전용

```pseudo
# createCheckout 의 successUrl 은 화면 리다이렉트용일 뿐, 지급 트리거 아님.
# 지급은 verifyWebhook 을 통과한 invoice.paid / payment_intent.succeeded 만 신뢰.
```

## [EC:E6] 체크아웃 이중 클릭

```pseudo
input: idempotencyKey = `checkout:{customerId}:{planId}:{floor(now,1m)}` (앱이 생성, ARCHITECTURE §7)
steps:
  checkout.sessions.create(..., { idempotencyKey })
  # Stripe 가 동일 idempotencyKey 재요청 시 첫 응답을 그대로 반환 → 중복 세션 생성 방지
```

## [EC:D6] 통화·환율

```pseudo
# 환불은 결제 통화·결제 금액(minor unit) 그대로 refunds.create 에 전달. 환산 없음.
# Money.amountMinor 는 Stripe 의 smallest-unit 표현과 1:1 (KRW 포함 zero-decimal 통화도 동일 관례).
```

## [EC:D11] 세금

```pseudo
# Stripe Tax 사용 시 invoice/refund 세금은 Stripe 가 자동 계산·환불. 이 provider 는 관여하지 않음(P1, 문서화만).
```

## 계약 메모 (core 계약 변경 제안 아님 — 구현 판단)

`getSubscription`/`getPayment` 는 core `Subscription`/`Payment` 전체를 반환해야 하지만, provider 는
우리 DB 의 `id`/`customerId`/`planId` 를 모른다. 체크아웃 생성 시 Stripe 객체의 `metadata` 에
`customerId`/`planId`/`subscriptionId` 를 심어두고, 재조회 시 그 metadata 를 읽어 채운다.
metadata 가 없으면 (예: Stripe 대시보드에서 수동 생성) 해당 필드는 빈 문자열로 반환하며,
**호출부(lifecycle/webhook 모듈)가 자신의 repo 조회 결과로 덮어써야 한다** — E1/E3 대조 로직은
이미 provider_ref 기준으로 repo 를 조회하므로 이 값에 의존하지 않는 것이 안전하다.

## [EC:L5] withCorrelationId — correlationId scoping (added 2026-09-09)

`StripeProvider` implements a duck-typed `withCorrelationId(correlationId) -> PaymentProvider`
(ts) / `with_correlation_id(correlation_id)` (py) — NOT part of the shared `PaymentProvider`
interface/Protocol, so this is additive only. Returns a scoped clone whose `request()`/logging
uses `correlationId` instead of the per-call idempotencyKey-derived default (falls back to that
default when no override is set — unchanged behavior from before this addition). `packages/webhook`
calls it from `process()` when present, threading one webhook delivery's correlationId through
every provider call the handler makes for that delivery. See
`packages/webhook/spec/webhook.pseudo.md` [EC:L5] for the full design; regression coverage in
`ts/test/correlation-id.test.ts` / `py/tests/test_stripe_correlation_id.py`.


## 환불 웹훅의 식별자와 확정 시점

`NormalizedEvent.id`는 Stripe `event.id`(전달 이벤트), `refundRef`는 `data.object.id`(환불 객체)다.
`refund.created`라는 원본 이벤트 이름은 성공을 보장하지 않는다. `pending`, `requires_action`,
누락된 상태는 확정하지 않으며, `succeeded` 상태만 정규화된 `refund.created`로 전달한다.
웹훅 구독에는 `refund.created`, `refund.updated`, `refund.failed`를 포함한다.
`charge.refunded`만 구독하면 개별 환불과 pending→terminal 전환을 대조할 수 없다.

근거: [Stripe 이벤트 정의](https://docs.stripe.com/api/events/types),
[Refund 객체의 상태와 ID](https://docs.stripe.com/api/refunds/object).


## 체크아웃 권한 스냅샷의 결제 연결

`customer`에 기존 Stripe 고객 ID를 전달하여 새 고객 생성으로 소유자가 바뀌지 않게 한다.
`checkoutEntitlementKey`는 세션 metadata와 함께 일회 결제의 `payment_intent_data.metadata`,
구독의 `subscription_data.metadata`에도 전달한다. invoice는 구독 metadata를 루트에 복사하지 않으므로
`subscription_details.metadata`(legacy) 또는 `parent.subscription_details.metadata`(basil)의
생성 시점 스냅샷을 `Payment.raw.metadata`에 투영한다. 원본 invoice는 수정하지 않는다.
구독 ID 역시 legacy `subscription`과 basil `parent.subscription_details.subscription` 모두 지원한다.

근거: [Stripe metadata 전파 규칙](https://docs.stripe.com/metadata),
[Invoice subscription snapshot](https://docs.stripe.com/api/invoices/object).
