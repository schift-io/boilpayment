# refund — pseudo spec

소스 오브 트루스. ts/py 구현은 이 섹션 ID를 `# EC:<id>` / `// EC:<id>` 주석으로 인용한다.
공개 API: `evaluate` · `execute` · `onExternalRefund` (docs/ARCHITECTURE.md §3.5).

공통 규약:
- 금액은 전부 minor unit 정수. 크레딧은 정수.
- pool은 `policy.credits.pools`와 무관하게 v0에서는 `'paid'` 풀만 다룬다 (B7: 환불·회수는 paid 풀만).
- 원장 조회는 `ledger.entries(customerId, {...})` / `ledger.balance(customerId, 'paid')`.
- 멱등키는 ARCHITECTURE.md §7.

---

## [EC:D1] evaluate — no_questions_days 무조건 전액 환불

```pseudo
input: payment, sub?, policy, ledger, repo, clock, requestedAmount?, providerFeeMinor?
if requestedAmount is supplied and (amount is not a positive safe integer or currency differs from payment.amount.currency):
    return ineligible(ruleId='D-request', reason='invalid requested amount or currency')
now = clock.now()
daysSince = floor((now - payment.occurredAt) in days)
if daysSince <= policy.refund.noQuestionsDays:
    alreadyRefundedMinor = sum(r.amount.amountMinor for r in repo.refunds.list({paymentId: payment.id}) if r.status == 'succeeded')
    grantedByPayment = ledger.entries(payment.customerId, {kind:'grant'}) filtered by reference.paymentId == payment.id and source in ('subscription','topup')
    totalGranted = sum(e.amount for e in grantedByPayment)          # positive
    alreadyRevoked = sum(-e.amount for e in ledger.entries(customerId,{kind:'revoke'}) if e.reference.paymentId == payment.id and e.source == 'refund')
    amountMinor = payment.amount.amountMinor - alreadyRefundedMinor
    creditsToRevoke = max(0, totalGranted - alreadyRevoked)
    ruleId = 'D1'
    reason = "D1: no-questions window (%d/%d days) → full %d minor, revoke %d credits" % (daysSince, policy.refund.noQuestionsDays, amountMinor, creditsToRevoke)
output: continues to [EC:D5] (D2/D3/D4 skipped — window already decided full amount)
idempotency: none (read-only decision, no side effects)
```

## [EC:D2][EC:D3][EC:D4][EC:B8] evaluate — 창 밖 산정 (method)

Only runs when `daysSince > policy.refund.noQuestionsDays`.

```pseudo
method = policy.refund.method
grantedByPayment, totalGranted as in D1
consumedFromGrants:
    grantIds = {e.id for e in grantedByPayment}
    consume_entries = ledger.entries(customerId, {kind:'consume'}) where e.reference.grantId in grantIds
    if consume_entries attribute every consumed unit to a grantId:
        consumed = sum(-e.amount for e in consume_entries)
    else (no grantId attribution found at all):
        # fallback: min(balance, granted) — B8 fallback clause
        balance = ledger.balance(customerId, 'paid').available
        consumed = max(0, totalGranted - min(balance, totalGranted))

if method == 'deny':
    return ineligible(ruleId='D2', reason='refund.method=deny')

if method == 'unused_credits':
    unused = max(0, totalGranted - consumed)
    unitPrice = weighted_avg_unit_price(grantedByPayment)   # sum(amount*unitPriceMinor)/sum(amount), 0 if totalGranted==0
    amountMinor = round(unused * unitPrice)
    creditsToRevoke = unused
    ruleId = 'D2'

if method == 'time_prorated':
    require payment.period is not None
    ratio = proration_ratio(payment.period, now, policy.proration.denominator)   # remaining/total, see G2
    amountMinor = round(payment.amount.amountMinor * ratio)
    elapsedRatio = 1 - ratio
    consumedRatio = consumed / totalGranted if totalGranted > 0 else 0
    if consumedRatio > elapsedRatio and policy.refund.overuseBehavior == 'deny':
        return ineligible(ruleId='D3', reason='overuse: consumed %.2f%% > elapsed %.2f%%' % (consumedRatio*100, elapsedRatio*100))
    # D4: credits derived from amount, not from ratio directly
    unitPrice = weighted_avg_unit_price(grantedByPayment)
    rawCredits = amountMinor / unitPrice if unitPrice > 0 else 0
    creditsToRevoke = apply_rounding(rawCredits, policy.refund.rounding)   # floor_credits/ceil_credits/round_credits
    ruleId = 'D2'

if method == 'min_of_both':
    (amountA, creditsA) = compute unused_credits branch above
    (amountB, creditsB, ineligibleB?) = compute time_prorated branch above
    if amountB is ineligible: return ineligible(ruleId='D3', reason=overuse reason)
    else: pick branch with smaller amountMinor
    ruleId = 'D2'

output: amountMinor, creditsToRevoke, ruleId, reason
idempotency: none
```

## [EC:D16] evaluate — 환불 사유별 처리

```pseudo
input.reason = { category: technical_failure | dissatisfied | user_error | other, evidenceRef? } | null
r = policy.refund.reasons                          # defaults all 'rules' = no effect
user_error and r.userError == 'deny'         -> ineligible(ruleId 'D16')             # before any math
technical_failure and r.technicalFailure == 'full':
    take the D1 branch even outside noQuestionsDays (ruleId 'D16'), skip D5,
    B13 behaves as clamp_to_zero: revoke what is left, never reduce the amount
dissatisfied and r.dissatisfied == 'needs_human'                    -> needsHuman
dissatisfied and r.dissatisfied == 'evidence_required' and !evidenceRef -> needsHuman
other / 'rules'                              -> unchanged
```

## [EC:D5] evaluate — 연간 플랜 환불 창

```pseudo
input: sub?, repo, policy
if sub is not None:
    plan = repo.plans.get(sub.planId)
    if plan is not None and plan.interval == 'year' and policy.refund.annualMethod == 'deny_after_days':
        limit = policy.refund.annualDenyAfterDays
        if limit is not None and daysSince > limit:
            return ineligible(ruleId='D5', reason='annual plan, deny_after_days=%d, elapsed=%d' % (limit, daysSince))
remainingMinor = max(0, payment.amount.amountMinor - sum(successful refunds for this payment))
if amountMinor > remainingMinor:
    creditsToRevoke = apply_rounding(creditsToRevoke * remainingMinor / amountMinor, policy.refund.rounding)
    amountMinor = remainingMinor
if requestedAmount is supplied and requestedAmount.amountMinor < amountMinor:
    creditsToRevoke = apply_rounding(creditsToRevoke * requestedAmount.amountMinor / amountMinor, policy.refund.rounding)
    amountMinor = requestedAmount.amountMinor
output: continue to D7 (remaining-payment cap applies to every calculation method)
```

## [EC:D7] evaluate — PG 수수료 (customer 부담)

```pseudo
if policy.refund.feeBearer == 'customer':
    fee = providerFeeMinor or 0
    amountMinor = max(0, amountMinor - fee)
    reason += "; D7 fee %d deducted (customer-borne)" % fee
output: continue to B13
```

## [EC:B13] evaluate — 회수 크레딧 > 잔액 (revoke_shortfall)

After all request, fee and shortfall calculations, a nonpositive refund amount returns
`ineligible(ruleId='D-zero', reason='no refundable amount remains after applying policy')`
with zero credits to revoke. This is a deterministic denial, not an executable refund.

```pseudo
available = max(0, ledger.balance(customerId, 'paid').available)
if available < creditsToRevoke:
    switch policy.refund.revokeShortfall:
      case 'clamp_and_reduce_refund':
          ratio = available / creditsToRevoke if creditsToRevoke > 0 else 1
          amountMinor = floor(amountMinor * ratio)
          creditsToRevoke = available
      case 'clamp_to_zero':
          creditsToRevoke = available    # amountMinor unchanged
      case 'allow_negative':
          pass   # creditsToRevoke unchanged, balance goes negative on execute
output: continue to D6 + D10 + I1
```

## [EC:D6] evaluate — 통화

```pseudo
currency = payment.amount.currency   # always payment currency, never the plan's display currency
```

## [EC:D10] evaluate — 환불 어뷰징 속도 (velocity)

Runs conceptually as step 2 (checked before D1/D2), but its effect (`needsHuman`/`ruleId` override)
is only *applied* after amount/credits are computed, so the decision still carries real numbers for a
human to review.

```pseudo
windowStart = now - 365 days
count = len([r for r in repo.refunds.list({customerId: payment.customerId}) if r.status == 'succeeded' and r.createdAt >= windowStart])
velocityTriggered = count >= policy.refund.maxPerCustomerPerYear
# applied at the end of evaluate: if velocityTriggered: needsHuman = true; ruleId = 'D10'
```

## [EC:A22] evaluate — 즉시 취소(오결제)

No separate code path: A22 is D1 with a very fresh payment (daysSince ≈ 0). Covered by the D1 branch —
no additional logic needed, documented here for coverage traceability only.

## evaluate — 최종 조립

```pseudo
needsHuman = amountMinor > policy.cs.autoApprove.maxAmountMinor or creditsToRevoke > policy.cs.autoApprove.maxCredits
if velocityTriggered: needsHuman = true; ruleId = 'D10'
return RefundDecision{
  eligible: true, amount: {amountMinor, currency}, creditsToRevoke, ruleId, reason,
  needsHuman, paymentId: payment.id, customerId: payment.customerId, subscriptionId: sub?.id ?? null
}
```

---

## [EC:D15][EC:D12] execute — hold → provider.refund → revoke/release

```pseudo
input: decision, provider, ledger, repo, clock, ids, extra?, cs?, approvedBy?, idempotencyKey?
require decision.eligible == true
require not decision.needsHuman or trustedHostApproved(approvedBy)
executionKey = idempotencyKey or "refund:{paymentId}:{amountMinor}:{ruleId}"
runIdempotent(executionKey):
    requestKey = "refund.provider:{executionKey}"
    request = repo.operations.get(requestKey)
    if request.status == done: providerResult = deserialize(request.result)
    elif request.error == refund_submitted:
        providerResult = deserialize(request.result) # pending: never resend
    else:
        # Validate customer/currency, positive amount/nonnegative credits, refundable payment,
        # amount <= paid minus other succeeded/pending refunds. Own pending row is excluded.
        refundId = request.result.id if a prepared retry else ids.newId()
        claim requestKey atomically; persist pending Refund identity as operation.result
        append hold using "hold:refund:{refundId}"; persist pending Refund row
        # Preparation failure can reclaim with the same identity; no network call occurred.
        persist request.error = refund_submitted BEFORE calling provider
        try:
            providerResult = provider.refund(..., idempotencyKey="refund:{paymentId}:{refundId}")
        except refund_receive_account_required:
            providerResult = failed # known adapter preflight: no submitted request
        except any other provider exception:
            providerResult = pending with failure.code=refund_outcome_unknown, retryable=false
        persist request.status=done and normalized providerResult BEFORE local settlement
        # A response checkpoint write failure leaves submitted+pending intact: reconciliation only.

    if providerResult.status == pending:
        persist pending; retain hold; return pending
    if providerResult.status == failed:
        release hold; persist failed; open CS case; return failed
    # Only confirmed success reaches local settlement. Storage errors propagate and are not declines.
    revoke payment grant buckets idempotently using stable refundId; release hold after revoke
    payment.status = refunded or partially_refunded based on succeeded totals, excluding own row
    persist payment and succeeded refund
    return succeeded
# Retry after confirmed-provider/local-storage failure replays provider checkpoint and only settles locally.
# Lost/unknown provider outcomes never trigger automatic resubmission, even if provider has no idempotency.
# Final execute replay reads the current refund row, so later confirmed reconciliation is visible.
# refund.provider checkpoints are financial request identity: generic operation retention MUST preserve
# pending/submitted AND confirmed checkpoints, even when the outer refund.execute receipt expires.
```

`cs` is an optional injected callback, keeping refund independent of the CS package.
A provider request that was submitted but not confirmed remains pending; the provider's trusted
refund reference/webhook or operator reconciliation must resolve it. A timeout is not a failed refund.

---

## [EC:K5 K6] execute — 현금영수증 취소 (환불 성공 이후, 절대 롤백하지 않음)

`execute` 는 `policy?: {cashReceipt}` 와 기존 `extra` 를 추가로 읽는다. `extra.cashReceiptKey`
(EC:D13 의 `extra.refundReceiveAccount` 와 같은 camelCase 키 관례)는 호출자가 "이 결제에 발행된
현금영수증이 있다"를 알릴 때 채운다 — Toss 는 실제 `receiptKey`, PortOne 은 아무 truthy 값이면
된다(PortOne 취소는 결제 스코프라 영수증 id 자체가 필요 없음, `toss.pseudo.md`/`portone.pseudo.md`
참고). `refund` 자체는 발행 여부를 기록하지 않는다(core `Payment` 에 필드가 없다 — 계약 변경 제안).

```pseudo
# doExecute 의 성공 분기, repo.refunds.put(refund) 직후 / return refund 직전에 삽입:
if policy?.cashReceipt.cancelOnRefund and extra?.cashReceiptKey and refund.status == 'succeeded':
    canceler = provider   # duck-typed: cancelCashReceipt(paymentRef, receiptKey?, amountMinor?) -> unknown
    if typeof canceler.cancelCashReceipt == 'function':
        try:
            canceler.cancelCashReceipt({paymentRef: payment.providerRef, receiptKey: extra.cashReceiptKey,
                                         amountMinor: providerResult.amount.amountMinor})   # EC:K5 부분 환불 = 부분 취소
        except Exception as receiptErr:
            # EC:K6 — 절대 refund 를 되돌리지 않는다. refund 는 이미 'succeeded' 로 저장되었고 그대로 반환된다.
            if cs is not None:
                cs.openRefundFailedCase({customerId: decision.customerId, referenceId: refund.id,
                                          reason: "cash receipt cancel failed: %s" % receiptErr,
                                          needs: 'cash_receipt_cancel_failed'})
return refund   # 현금영수증 취소 실패와 무관하게 항상 성공한 refund
```

`provider.cancelCashReceipt` 는 core `PaymentProvider` 인터페이스 밖의 extra 메서드다(Toss/PortOne
둘 다 구현) — `refund` 패키지는 이를 duck-type 으로만 참조하고, 구체 provider 패키지를 import 하지
않는다(EC:D12 의 `RefundFailedCaseOpener` 와 같은 원칙).

발행 자체(결제 성공 시 `mode: 'auto'`)의 실패는 이 파일 소관이 아니다 — 그 트리거는
`webhook.default_handlers` 의 `payment.succeeded` 경로이며, 같은 K6 원칙(결제 성공을 롤백하지
않고 기록·에스컬레이션만)을 따라야 한다.

---

## [EC:D8] onExternalRefund — provider 대시보드에서 직접 환불

```pseudo
input: event (NormalizedEvent, type in {'refund.created','refund.failed'}), ledger, repo, cs, clock, ids
payments = repo.payments.list({providerRef: event.paymentRef})
payment = payments[0] if payments else None

# idempotency: treat the webhook event id as the external refund's providerRef surrogate —
# NormalizedEvent has no dedicated refund-ref field, so redelivery of the same event must no-op.
existing = [] if payment is None else [r for r in repo.refunds.list({paymentId: payment.id}) if r.providerRef == event.id]
if existing:
    return existing[0]     # no-op, already processed (E14-style dedup)

refundId = ids.newId()
if payment is None:
    # totally unmatched — can't compute credits, just open a mismatch case and record a bare refund stub
    customerId = event.customerRef or 'unknown'
    refund = Refund{id: refundId, paymentId:'', customerId, amount: event.amount or {amountMinor:0, currency:'???'},
                     status: 'failed' if event.type=='refund.failed' else 'succeeded',
                     providerRef: event.id, creditsRevoked: 0, ruleId:'D8', reason:'unmatched external refund', failure:None,
                     createdAt: clock.now()}
    repo.refunds.put(refund)
    cs.openCase({customerId, kind:'reconcile_mismatch', referenceId: event.paymentRef or event.id, ...})
    return refund

alreadyRefundedMinor = sum(r.amount.amountMinor for r in repo.refunds.list({paymentId: payment.id}) if r.status=='succeeded')
amountMinor = event.amount.amountMinor if event.amount else (payment.amount.amountMinor - alreadyRefundedMinor)
currency = event.amount.currency if event.amount else payment.amount.currency

grantedByPayment = ledger.entries(payment.customerId, {kind:'grant'}) filtered reference.paymentId==payment.id
totalGranted = sum(e.amount for e in grantedByPayment)
alreadyRevoked = sum(-e.amount for e in ledger.entries(customerId,{kind:'revoke'}) if e.reference.paymentId==payment.id and e.source=='refund')
unitPrice = weighted_avg_unit_price(grantedByPayment)
rawCredits = round(amountMinor / unitPrice) if unitPrice > 0 else 0
available = ledger.balance(payment.customerId, 'paid').available
creditsToRevoke = max(0, min(rawCredits, totalGranted - alreadyRevoked, available))   # clamp_to_zero-style, we can't touch provider's own refund

if creditsToRevoke > 0 and event.type == 'refund.created':
    ledger.append({customerId: payment.customerId, pool:'paid', kind:'revoke', amount: -creditsToRevoke,
                    source:'refund', reference:{paymentId: payment.id, refundId},
                    idempotencyKey: "revoke:refund:%s" % refundId, actor:'system', reason:'D8 external refund reconcile'})

status = 'failed' if event.type == 'refund.failed' else 'succeeded'
refund = Refund{id: refundId, paymentId: payment.id, customerId: payment.customerId, amount:{amountMinor, currency},
                 status, providerRef: event.id, creditsRevoked: creditsToRevoke if status=='succeeded' else 0,
                 ruleId:'D8', reason:'external refund reconcile', failure: None, createdAt: clock.now()}
repo.refunds.put(refund)

if status == 'succeeded':
    totalRefunded = alreadyRefundedMinor + amountMinor
    payment.status = 'refunded' if totalRefunded >= payment.amount.amountMinor else 'partially_refunded'
    repo.payments.put(payment)

mismatch = (rawCredits != creditsToRevoke) or (event.amount is None)
if mismatch:
    cs.openCase({customerId: payment.customerId, kind:'reconcile_mismatch', referenceId: refund.id, ...})
return refund
idempotency: "revoke:refund:{refundId}" (refundId freshly generated per event; event-level dedup via existing.providerRef==event.id scan above)
```

---

## [EC:L5] execute / onExternalRefund — correlationId propagation

`execute` and `onExternalRefund` accept an optional `correlationId?: string` on their input, for
callers that do NOT already go through `webhook.process`'s own ledger/provider correlationId
wrapping (`packages/webhook/{ts,py}/src/correlation.*` — `withCorrelationId(ledger, id)` +
`provider.withCorrelationId(id)`, which pre-scope both dependencies before calling into refund).
This is the "direct call" path — e.g. an app-driven refund from a support tool, or `cs.refundAssist`
threading its own `correlationId` straight through.

```pseudo
# execute — resolved once, near the top of doExecute:
scopedProvider = provider.withCorrelationId(correlationId) if correlationId and typeof provider.withCorrelationId == 'function' else provider
# every ledger.append() call in execute merges correlationId into `reference` (only if given; never
# overwrites one a caller already set on the object literal — there is none here since execute builds
# these fresh, so this is purely additive):
reference: {paymentId, refundId, ...(correlationId ? {correlationId} : {})}
# the provider.refund() call and the duck-typed cancelCashReceipt() call (EC:K5) both go through
# scopedProvider, not the bare `provider` — so a correlated cash-receipt-cancel HTTP call is also
# tagged.
providerResult = scopedProvider.refund({paymentRef, amount, reason, idempotencyKey, extra})

# onExternalRefund — the one ledger.append (the revoke) merges correlationId the same way. No
# provider call exists on this path (the refund already happened externally), so there is nothing
# else to scope.
reference: {paymentId, refundId, ...(correlationId ? {correlationId} : {})}
```

Not threaded into the `runIdempotent` payload comparison (EC:J2) — a retry that legitimately carries
a different `correlationId` for the same idempotency key must still replay, not be rejected as a
payload mismatch; `correlationId` is delivery metadata, not business identity.

`cs.refundAssist` (packages/cs) threads its own optional `correlationId` straight into the
`refundExecute` call it makes — see `cs.pseudo.md` [EC:L5].

### Pending settlement boundary

`onExternalRefund.refundRef` / `on_external_refund.refund_ref` is an optional trusted-host
provider refund identifier. `NormalizedEvent.id` is a delivery identifier and cannot establish
this match. A matching pending refund settles the existing refund ID and releases its hold;
success revokes the held credits, failure does not revoke. Replays must retain the same refundRef.
Without a matching reference, a payment with pending refunds opens a reconciliation mismatch,
retains its hold and never creates a second completed refund. A single pending refund is returned;
multiple candidates raise `refund_reconciliation_required`. Amount disagreement also stays pending.
The default webhook normalization does not supply this reference, so automatic completion of pending
provider refunds requires trusted-host reconciliation; it is not a completed SDK-only flow.

### Provider refund settlement evidence (Step 1)

`NormalizedEvent.refundRef` / `refund_ref` is an optional **provider refund identifier**,
never a webhook delivery/event ID. `onExternalRefund` uses it automatically; the explicit
`refundRef` / `refund_ref` input remains an override for trusted integrations. A matching
pending record is updated in place. `refund.pending` preserves its hold; final
`refund.created` or `refund.failed` releases the hold, with credit revocation only on success.
Repeated terminal deliveries do not create another refund or revoke again.

The match is constrained by payment provider. When the notification lacks `paymentRef`,
an exact refund reference may resolve the already stored refund's payment. Ambiguous IDs,
unmatched pending refunds, missing refund IDs, and untracked refunds without an amount require
reconciliation. The kit does not use delivery IDs or infer the remaining refundable amount.
Known pending refunds can use their stored approved amount when the final event omits it.

## [EC:D17] Refund cap check is serialized per customer

```pseudo
operation = ledger.transaction(decision.customerId, () =>
   committed = sum(refunds of this payment in succeeded | pending)
   require decision.amount <= payment.amount - committed        # else refund_invalid_decision
   claim operation; hold credits; refunds.put(pending))
provider.refund(...)                                           # outside the lock
```

Without the lock, two requests with different keys for one payment both read the same `committed`
and both pass; Postgres race test before the fix: 600 + 600 on a 1000 payment refunded 1200 in 4 of
5 rounds (TS) and 5 of 5 (Py).


## [EC:D18] 외부 환불 회수는 고객 잠금 안에서, grant 버킷에 묶어서

```pseudo
onExternalRefund(event):
   ... payment, pending, settlementAmount 확인 (잠금 밖, 읽기만) ...
   return ledger.transaction(payment.customerId, () =>          # consume 과 같은 고객 잠금
      balance = ledger.balance(customer, 'paid', now)
      creditsToRevoke = pending ? heldCredits : min(raw, granted - alreadyRevoked, balance.available)
      parts = split creditsToRevoke over live paid grant buckets:
                 grants of this payment first, then earliest expiry, then oldest
      excess = creditsToRevoke - sum(parts)                     # 승인된 allow_negative pending 만 > 0
      if excess > 0: append revoke(-excess, key revoke:refund:{refundId})           # grant 없음
      for (grantId, n) in parts: append revoke(-n, grantId, key revoke:refund:{refundId}:{grantId})
      put refund; update payment status
      if clamped or no amount: open reconcile case)
```

grant 에 묶이지 않은 회수는 잔액만 줄이고 버킷은 그대로 두어, 이어지는 consume 이 회수된 크레딧을
다시 쓸 수 있었다(잔액 -100).
