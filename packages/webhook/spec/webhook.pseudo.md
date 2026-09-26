# webhook — spec (source of truth)

Public API: `receive`, `process`, `processPending`, `defaultHandlers`,
`createNodeHandler`, `toFetchHandler`, `getGrantsForCheckout`, `resolveWebhookIdentity`.
Mirrors `docs/ARCHITECTURE.md` §3.5 `webhook.*`, extended per `docs/ARCHITECTURE.md`.

Design note: `lifecycle`, `credits`, `refund`, `cs` packages are built
concurrently and are **not imported**. `defaultHandlers` takes duck-typed
interfaces (defined locally, see EC:E3 section) as injected deps — any object
with the right async method shape works, real or fake.

---

## [EC:E4] webhook signature failure

```pseudo
# see receive() step 1 — WebhookSignatureError -> 400, nothing stored, no side effects.
```

## [EC:E5] webhook.receive — store immediately, 200, process async

```pseudo
input: { provider: PaymentProvider, headers, rawBody, repo, clock }
output: { status: 200 | 400, eventId?: str, duplicated?: bool }

steps:
  1. try: event = provider.verifyWebhook({ headers, rawBody })
     except WebhookSignatureError: return { status: 400 }        # EC:E4 — nothing stored
  2. existing = repo.webhookEvents.get(event.id)
     if existing is not null:                                     # EC:E5 dedupe (shares B12's idempotency-by-id idea)
        return { status: 200, eventId: event.id, duplicated: true }
  3. identity = resolveWebhookIdentity(repo, provider, event)          # EC:I9 — see below
  4. record = WebhookEventRecord{
       id: event.id, provider: provider.name, type: event.type, status: 'received',
       rawBody, headers, receivedAt: clock.now(), processedAt: null, error: null, attempts: 0,
       customerId: identity.customerId, paymentId: identity.paymentId, subscriptionId: identity.subscriptionId,
     }
  5. repo.webhookEvents.put(record)
  6. return { status: 200, eventId: event.id, duplicated: false }
     # actual handling happens later, out of the request/response cycle — see process()
```

## [EC:I9] resolveWebhookIdentity — LOCAL customer/payment/subscription for a webhook event

Added 2026-09-09 (core contract gap #1 from `cs.timeline`): `WebhookEventRecord` had no way to
answer "did the webhook that should have granted this customer's credits fail?" — the exact
question the paid CS product exists to answer. Resolved by both `receive()` (first sighting) and
`process()` (re-verified — may resolve better once more local rows exist by the time it retries).

```pseudo
function resolveWebhookIdentity(repo, provider, event) -> {customerId, paymentId, subscriptionId}:
  # EC:E3 — never trust event.customerRef/subscriptionRef/paymentRef as local identity directly;
  # they're provider-adapter best-effort. Look up the LOCAL row by (provider, providerRef) instead.
  if event.paymentRef:
    [payment] = repo.payments.list({provider: provider.name, providerRef: event.paymentRef})
    if payment: paymentId = payment.id; customerId = payment.customerId
  if event.subscriptionRef:
    [sub] = repo.subscriptions.list({provider: provider.name, providerRef: event.subscriptionRef})
    if sub: subscriptionId = sub.id; customerId ??= sub.customerId
  if not customerId and event.customerRef:
    # last resort — Customer.providerRefs is a list, no flat column to filter on; full scan.
    customers = repo.customers.list()
    match = customers.find(c => c.providerRefs.any(r => r.provider == provider.name and r.ref == event.customerRef))
    if match: customerId = match.id
  return {customerId, paymentId, subscriptionId}   # any leg not resolved stays null
```

`process()` re-runs this after re-verifying the event and merges non-null results into the stored
record (`record.customerId = identity.customerId ?? record.customerId`, etc.) before dispatching to
the handler, so even a handler that throws still leaves the record with whatever identity was
resolvable. `packages/schema-postgres` `sql/0004_webhook.sql` adds `customer_id`/`payment_id`/
`subscription_id` columns (no FK — a webhook for a checkout that never landed locally must still be
storable) plus a `(customer_id, received_at)` index for a customer-scoped CS timeline query.

## HTTP adapters (framework-agnostic)

```pseudo
createNodeHandler({ provider, repo, clock }) -> (req: { headers, body: str }) -> Promise<{ status, body: str }>
  handler(req):
     result = receive({ provider, headers: req.headers, rawBody: req.body, repo, clock })
     return { status: result.status, body: JSON.stringify(result) }

toFetchHandler(nodeHandler) -> (request: Request) -> Promise<Response>
  fetchHandler(request):
     headers = Object.fromEntries(request.headers.entries())
     body = await request.text()
     result = await nodeHandler({ headers, body })
     return new Response(result.body, { status: result.status, headers: { 'content-type': 'application/json' } })
```

## [EC:E3] [EC:E13] webhook.process — re-fetch, dispatch, no payload trust

```pseudo
input: { eventId, providers, handlers, repo, clock }
output: void   # errors are captured on the record, not thrown

steps:
  1. record = repo.webhookEvents.get(eventId)
     if record is null: return   # nothing to do
  2. record.status = 'processing'; record.attempts += 1; repo.webhookEvents.put(record)
  3. try:
        provider = providers[record.provider]
        if provider is null: raise Error('no provider configured for ' + record.provider)
        event = provider.verifyWebhook({ headers: record.headers, rawBody: record.rawBody })
           # EC:E3 — re-verify/re-parse from the *stored* raw body rather than trusting
           # anything cached; handlers below additionally re-fetch entity state from
           # the provider (get_subscription/get_payment) instead of trusting event.raw,
           # so an out-of-order webhook (e.g. invoice.paid before subscription.created)
           # still converges to the true current state.
        handler = handlers[event.type] ?? handlers['unknown']
        if handler is not null:
           handler({ event, provider, repo, clock })
        record.status = 'processed'; record.processedAt = clock.now(); record.error = null
     except Exception as e:
        record.status = 'failed'; record.error = str(e)
     repo.webhookEvents.put(record)
```

```pseudo
processPending({ repo, providers, handlers, clock, maxAttempts = 8 }) -> { processed: int, failed: int }
  candidates = repo.webhookEvents.list({ status: 'received' })
             + [r for r in repo.webhookEvents.list({ status: 'failed' }) if r.attempts < maxAttempts]
  for record in candidates:
     process({ eventId: record.id, providers, handlers, repo, clock })
  return counts of resulting processed / failed statuses
```

## [EC:E3] Handler duck types + defaultHandlers wiring

```pseudo
# Local interfaces (webhook package only — no cross-package import):
LifecycleDeps {
  onRenewalPaid({ sub, payment, policy, ledger, repo, clock }) -> Promise<unknown>
  dunning: { onPaymentFailed({ sub, policy, repo, notifier, clock }) -> Promise<unknown> }
}
# EC:B10 J1-J5 — `repo` is threaded through so the real credits.topup() can wrap the grant in
# runIdempotent the same way every other webhook-triggered mutation is: without it, a redelivered
# payment.succeeded for a one-time payment only gets ledger-level idempotency_key dedup (B12), not
# the operation-level in-progress/replay guarantees (J1-J3).
CreditsDeps { topup({ customerId, payment, credits, policy, ledger, clock, repo }) -> Promise<unknown> }
RefundDeps  { onExternalRefund({ event, ledger, repo, cs }) -> Promise<unknown> }
CsDeps      { dispute({ event, policy, ledger, repo, notifier }) -> Promise<unknown> }
# EC:K2-K7 — duck-typed against TossProvider/PortoneProvider's `issueCashReceipt` extra method
# (not part of core PaymentProvider — Stripe/Polar don't have one).
CashReceiptIssuer { issueCashReceipt({ paymentRef, type, customerIdentityNumber, orderName?, taxFreeAmountMinor? })
                     -> Promise<{ receiptKey, type }> }

defaultHandlers({ policy, ledger, repo, notifier, clock, ids, lifecycle?, credits?, refund?, cs?,
                   resolveTopupCredits?, resolveCashReceiptIdentity?, onCashReceiptError? })
  -> Record<NormalizedEventType, (ctx: { event, provider, repo, clock }) -> Promise<void>>
```

### [EC:K1] retryOnVersionConflict at every internal read-then-eventually-write call site

`Subscription.version` (EC:K1, `packages/schema-postgres`) makes `repo.subscriptions.put` throw
`PaymentKitError('subscription_version_conflict')` when the row changed since it was read. Any
handler here that reads a `Subscription` and, after real async work, ends up writing it back can
now hit that — so every such call site is wrapped in a small locally-duplicated
`retryOnVersionConflict(fn, attempts=3)` (deliberately NOT imported from `boilpayment-
lifecycle` — this package intentionally has no dependency on it, see the EC:E3 duck-typing note
above; the helper is ~15 lines, copied identically). `fn` re-resolves the subscription (or re-reads
the row) on every attempt, so a retry sees the latest version instead of replaying a stale one:
- `payment.succeeded` (subscription branch) — `resolveLocalSubscription` reads, `lifecycle.onRenewalPaid`
  does rollover/grant/ledger work then writes; `onRenewalPaid`'s own EC:A7 idempotency check
  (period already granted → `duplicated: true`, no re-grant) makes replaying the whole call safe.
- `subscription.payment_failed` — same shape, `lifecycle.dunning.onPaymentFailed` writes.
- `subscription.canceled` — `list()` then `put({...sub, status:'canceled'})` per matching row; each
  iteration re-reads via `repo.subscriptions.get(sub.id)` immediately before its own retry-wrapped write.

### Identity rule (2026-09-09, per team-lead) — local repo row wins, provider re-fetch is verification-only

`provider.getPayment` / `provider.getSubscription` are called by handlers **only to confirm
live status/period/amount**. Their `id` / `customerId` / `planId` / `subscriptionId` fields are
provider-adapter best-effort (restored from checkout metadata, per the `providers.*` packages) and
**must not** be trusted as local identity — a provider-side entity created outside our app (e.g. a
subscription made directly in the Stripe dashboard) has no reliable local id at all. The object
passed to `lifecycle`/`credits` is always **the local repo row found by `providerRef`**, with only
the verified live fields (`status`, `currentPeriod`/`period`, `cancelAtPeriodEnd`, `graceUntil` for
subscriptions; `status`, `amount`, `period`, `occurredAt`, `failure` for payments) overlaid on top.

```pseudo
resolveLocalSubscription(ctx, providerRef) -> Subscription:
   subs = repo.subscriptions.list({ providerRef })
   if subs is empty: markUnknownProviderRef('subscription', providerRef, ctx.provider.name)   # throws, see below
   sub = subs[0]
   # EC:F — Toss/PortOne have no native provider-side subscription (billing-key + our own
   # scheduler owns period state instead); getSubscription() throws PaymentKitError('unsupported')
   # there, so only re-fetch when the provider actually supports it.
   if ctx.provider.capabilities().nativeSubscriptions:
      providerSub = provider.getSubscription(providerRef)   # re-fetch for verification (EC:E3)
      sub = { ...sub, status: providerSub.status, currentPeriod: providerSub.currentPeriod,
              cancelAtPeriodEnd: providerSub.cancelAtPeriodEnd, graceUntil: providerSub.graceUntil }
   return sub

resolveLocalPayment(ctx, providerRef) -> Payment:
   payments = repo.payments.list({ providerRef })
   if payments is empty: markUnknownProviderRef('payment', providerRef, ctx.provider.name)      # throws
   providerPayment = provider.getPayment(providerRef)   # re-fetch for verification (EC:E3)
   return { ...payments[0], status: providerPayment.status, amount: providerPayment.amount,
            period: providerPayment.period, occurredAt: providerPayment.occurredAt, failure: providerPayment.failure }
```

## [EC:E16] Native renewal — record the renewal invoice for a known subscription

Stripe/Polar renew on their own schedule, so a renewal invoice reaches us first as
`payment.succeeded` with a paymentRef that has no local row. Without this every native renewal
would end in `unknown_provider_ref`.

```pseudo
resolveRenewalPayment(ctx, paymentRef, subscriptionRef) -> Payment:
   if repo.payments.list({ providerRef: paymentRef }) is not empty: return resolveLocalPayment(ctx, paymentRef)
   sub = first of repo.subscriptions.list({ provider: ctx.provider.name, providerRef: subscriptionRef })
   if sub is null or not ctx.provider.capabilities().nativeSubscriptions:
      return resolveLocalPayment(ctx, paymentRef)            # unchanged: unknown payment -> throws
   remote = ctx.provider.getPayment(paymentRef)                # re-fetch (EC:E3), never the payload
   if remote.kind != 'subscription' or remote.subscriptionId != subscriptionRef:
      markUnknownProviderRef('payment', paymentRef, ctx.provider.name)   # someone else's payment
   raced = first of repo.payments.list({ providerRef: paymentRef })     # concurrent delivery
   if raced: return raced
   return repo.payments.put({ id: ids.newId(), customerId: sub.customerId, provider: ctx.provider.name,
                              providerRef: paymentRef, subscriptionId: sub.id, kind: 'subscription',
                              amount/status/period/occurredAt/failure: from remote, cashReceipt: null })
   # Two deliveries racing past both lookups: Postgres `payments (provider, provider_ref)` is unique,
   # so the second insert fails that record; its retry finds the row. Never two rows.
```

### Unmatched providerRef — do not process, fail the record, alert

If no local row matches a webhook's `providerRef` (dashboard-created entity, or a webhook that
raced ahead of our own row creation), the event is **not** processed as a grant/renewal. Instead:

```pseudo
markUnknownProviderRef(kind, providerRef, providerName):
   notifier.send({ type: 'reconcile.mismatch', customerId: null,
                    payload: { kind, providerRef, provider: providerName } })
   throw Error('unknown_provider_ref')
   # process() (see above) catches this: record.status = 'failed', record.error = 'unknown_provider_ref'.
   # processPending() will retry it like any other failed record, up to maxAttempts — this is the
   # existing E1/E5 "unmatched payment -> CS reconcile" path, not a new retry mechanism.
```

```pseudo
handlers['payment.succeeded'] = async (ctx):
   payment = ctx.event.subscriptionRef ? resolveRenewalPayment(ctx, ctx.event.paymentRef, ctx.event.subscriptionRef)
                                       : resolveLocalPayment(ctx, ctx.event.paymentRef)
   if ctx.event.subscriptionRef is not null:
      if lifecycle is not null:
         retryOnVersionConflict(async () =>          # EC:K1
            sub = resolveLocalSubscription(ctx, ctx.event.subscriptionRef)   # re-read every attempt
            lifecycle.onRenewalPaid({ sub, payment, policy, ledger, repo, clock }))
   else if credits is not null:
      n = resolveTopupCredits ? resolveTopupCredits(payment) : null   # EC:B10
      if n is null: throw Error('topup_credits_unresolved')
      credits.topup({ customerId: payment.customerId, payment, credits: n, policy, ledger, clock, repo })
   maybeIssueCashReceipt(payment, ctx.provider)   # EC:K2 — after the goods are granted; see below

handlers['subscription.payment_failed'] = async (ctx):
   if ctx.event.subscriptionRef is null: return
   if lifecycle is null: return
   retryOnVersionConflict(async () =>              # EC:K1
      sub = resolveLocalSubscription(ctx, ctx.event.subscriptionRef)   # re-read every attempt
      lifecycle.dunning.onPaymentFailed({ sub, policy, repo, notifier, clock }))

handlers['subscription.canceled'] = async (ctx):
   # cancellation of an unknown local entity is a harmless no-op, not a reconcile-worthy
   # anomaly (unlike payment/renewal grants) — no unknown_provider_ref check here.
   subs = repo.subscriptions.list({ providerRef: ctx.event.subscriptionRef })
   for sub in subs:
      retryOnVersionConflict(async () =>            # EC:K1
         fresh = repo.subscriptions.get(sub.id) ?? sub   # re-read immediately before the write
         repo.subscriptions.put({ ...fresh, status: 'canceled' }))

handlers['refund.created'] = async (ctx):
   if refund is not null: refund.onExternalRefund({ event: ctx.event, ledger, repo, cs })   # EC:D8

handlers['dispute.opened'] = handlers['dispute.closed'] = async (ctx):
   if cs is not null: cs.dispute({ event: ctx.event, policy, ledger, repo, notifier })       # EC:B11 D9

handlers['unknown'] = async (ctx): pass   # ignored, no-op — still marks processed
```

### [EC:K2 K4 K6 K7] maybeIssueCashReceipt — auto-issue on payment.succeeded

The kit has no source for a KR customer's phone number / 사업자등록번호 (not on `Customer` or
`Payment`) — `resolveCashReceiptIdentity` is an app-supplied resolver (return `null` to opt a
payment out). Called from `payment.succeeded` only, after the credits/lifecycle branch (the
receipt documents what was already granted).

```pseudo
maybeIssueCashReceipt(payment, provider):
   if policy.cashReceipt.mode != 'auto': return
   if payment.cashReceipt is not null: return          # EC:K7 — already issued; redelivery must not double-issue
   if resolveCashReceiptIdentity is null: return
   issuer = provider as CashReceiptIssuer               # duck-type
   if issuer.issueCashReceipt is not a function: return  # provider has no cash-receipt support (Stripe/Polar)

   try:
      identity = resolveCashReceiptIdentity(payment)
      if identity is null: return                        # app opted this payment out
      type = identity.type ?? policy.cashReceipt.defaultType
      receipt = issuer.issueCashReceipt({ paymentRef: payment.providerRef, type,
                                           customerIdentityNumber: identity.customerIdentityNumber })
      fresh = repo.payments.get(payment.id) ?? payment    # re-fetch right before writing (EC:K7)
      repo.payments.put({ ...fresh, cashReceipt: { receiptKey: receipt.receiptKey, issuedAt: clock.now(),
                                                     type: receipt.type ?? type } })
   catch (err):
      # EC:K4 — Toss/PortOne's issueCashReceipt throws PaymentKitError('cash_receipt_unsupported_for_payment_method')
      # for card payments BEFORE calling the provider API (enforced client-side — see toss/portone
      # src, "실측 2026-09-09": the provider itself does not validate this). That's EXPECTED for
      # every card payment once auto mode is on — swallow it quietly, don't notify.
      if err.code == 'cash_receipt_unsupported_for_payment_method': return
      # EC:K6 — any other issuance failure NEVER rolls back payment processing (the payment itself
      # already succeeded, and the webhook record still ends up 'processed'). Record + notify, then
      # continue; onCashReceiptError (if supplied) is called too for app-side escalation.
      notifier.send({ type: 'cs.needs_human', customerId: payment.customerId,
                       payload: { kind: 'cash_receipt_issue_failed', paymentId: payment.id, error: String(err) } })
      onCashReceiptError?.({ payment, error: err })
```

Regression coverage: `ts/test/handlers-cash-receipt.test.ts` · `py/tests/test_handlers_cash_receipt.py`
— issues and records the receipt; a redelivery with an already-issued receipt doesn't double-issue;
an issuance failure still leaves the webhook record `processed` and notifies; `mode='off'` (default)
never calls the provider.

## [EC:E13] getGrantsForCheckout — frontend polling helper

```pseudo
input: { checkoutIdOrPaymentRef, repo, ledger }
output: { ready: bool, customerId?: str, entries?: LedgerEntry[] }

# success_url is UX-only (EC:E13) — the payment may not be webhook-processed yet
# when the browser lands back. Frontend polls this until ready=true.
payments = repo.payments.list({ providerRef: checkoutIdOrPaymentRef })
if payments is empty: return { ready: false }
payment = payments[0]
if payment.status != 'succeeded': return { ready: false }
allEntries = ledger.entries(payment.customerId, { since: payment.occurredAt })
grantEntries = [e for e in allEntries if e.reference.paymentId == payment.id]
return { ready: true, customerId: payment.customerId, entries: grantEntries }
```

## [EC:L5] correlationId propagation — receive → process → ledger entry / audit log

One id, minted once per webhook delivery, threaded through every ledger append, provider call, and
log line that delivery causes — without touching the `PaymentProvider` interface or the
lifecycle/credits/refund/cs packages' own call signatures (those are owned by other agents; this
package only controls the `receive`/`process`/`defaultHandlers` layer and the 4 provider packages).

```pseudo
mintCorrelationId(providerEventId) -> str:
  return 'corr_' + providerEventId   # deterministic — a redelivery of the same event mints the same id

receive(input) -> ReceiveResult:
  ... (EC:E4 E5, unchanged)
  correlationId = mintCorrelationId(event.id)
  record = { ...WebhookEventRecord fields..., correlationId }
  repo.webhookEvents.put(record)
  if input.logger: input.logger.log({ event: 'webhook.received', correlationId, ... })
  return { status: 200, eventId: event.id, duplicated: false }

process(input) -> void:
  record = repo.webhookEvents.get(input.eventId)
  correlationId = record.correlationId ?? mintCorrelationId(record.id)   # defensive fallback for pre-existing rows
  if input.logger: input.logger.log({ event: 'webhook.processing', correlationId, ... })
  rawProvider = input.providers[record.provider]
  # EC:L5 — duck-typed, NOT part of PaymentProvider: providers without it are used unchanged.
  provider = typeof rawProvider.withCorrelationId == 'function'
    ? rawProvider.withCorrelationId(correlationId)
    : rawProvider
  event = provider.verifyWebhook(...)   # EC:E3 re-verify
  handler = input.handlers[event.type] ?? input.handlers['unknown']
  if handler: handler({ event, provider, repo: input.repo, clock: input.clock, correlationId })
  ... record.status = 'processed'; if input.logger: log('webhook.processed', correlationId, ...)
  # on exception: record.status = 'failed'; if input.logger: log('webhook.failed', correlationId, ...)
```

- **Ledger threading, without touching lifecycle/credits/refund/cs.** `defaultHandlers()`'s
  `onPaymentSucceeded`/`onRefundCreated`/`onDispute` wrap the `ledger` dep they hand to
  lifecycle/credits/refund/cs with `withCorrelationId(ledger, ctx.correlationId)` — a decorator
  (`correlation.ts`/`correlation.py`, this package) that intercepts `.append()`/`.consume()` and
  merges `correlationId` into the entry's `reference`/`meta` **only if the caller didn't already set
  one**. lifecycle/credits/refund/cs never see or touch `correlationId` — every `ledger.append()`
  they make during this handler invocation is tagged transparently.
- **Provider threading, without touching `PaymentProvider`.** Each of the 4 providers
  (`packages/providers/{stripe,polar,toss,portone}`) additionally implements a duck-typed
  `withCorrelationId(id) -> PaymentProvider` (not declared on the shared interface) that returns a
  scoped clone whose internal `request()`/logging uses `id` instead of the per-call
  idempotencyKey-derived default. `process()` calls it when present (checked via
  `typeof provider.withCorrelationId === 'function'`); a provider that doesn't implement it is used
  as-is, unchanged from before this change.
- **Audit log threading.** `receive`/`process`/`processPending` gained an optional `logger` param
  (backward compatible — every existing caller that omits it gets no logging, exactly as before).
  When given, `webhook.received`/`webhook.processing`/`webhook.processed`/`webhook.failed` events
  all carry the same `correlationId`. `PostgresLogger` (schema-postgres) already promotes any
  `LogEntry.correlationId`/`fields.correlationId` to the `audit_log.correlation_id` column —
  unmodified, pre-existing behavior; see spec/schema-postgres.pseudo.md [EC:L1-L5].
- **Remaining gap (documented in `packages/core/spec/core.pseudo.md` "계약 변경 제안"):**
  lifecycle/refund/credits/cs's OWN internal `PaymentProvider` calls (e.g. `refund.execute`'s
  `provider.refund()`) don't receive this delivery's correlationId — those call sites live in
  packages this one doesn't own.
- Proven end to end (ts `test/correlation-id.test.ts`, py `tests/test_correlation_id.py`): one
  minted id shows up on the `WebhookEventRecord`, on both the `webhook.received` and
  `webhook.processing`/`webhook.processed` log lines, and on the `LedgerEntry.reference` a fake
  `lifecycle.onRenewalPaid` wrote — using `CollectingLogger`/`InMemoryLedger`, no real Postgres
  needed for this specific proof (the `correlationId` → `audit_log.correlation_id` column mapping
  is proven separately, in schema-postgres, against a real database).

### Refund completion through default handlers (Step 1)

Default handlers route `refund.created`, `refund.failed`, and `refund.pending` into the
injected refund adapter with the normalized provider refund reference intact.
Toss and PortOne use the optional `RefundLookupProvider.getRefund({paymentRef, refundRef})`
/ `get_refund(payment_ref=..., refund_ref=...)` capability to read the actual cancellation
before acting. The lookup must match the exact cancellation identifier. A missing payment
reference can be resolved through an existing refund record scoped to the same provider.
Missing lookup support or absent authoritative cancellation produces a failed webhook record
and a reconciliation notification; it never releases the hold based on an unsigned notification.
Stripe and Polar singular refund events use verified signatures and status-specific normalization;
aggregate refund notifications lacking a singular refund reference are not settlement evidence.

## [EC:E17] Re-verify at process() time, judge freshness at receipt

```pseudo
receive():  event = provider.verifyWebhook({ headers, rawBody })            # signature + freshness (wall clock)
process():  event = provider.verifyWebhook({ headers, rawBody, receivedAt: record.receivedAt })
            # signature is checked again (a stored body altered after receipt fails); the timestamp
            # age check is skipped (Stripe tolerance 0 / None, Standard Webhooks age check off).
            # Google push-token exp and Apple certificate validity are judged at receivedAt.
            # record.receivedAt comes from the injected Clock, which need not be wall time, so it is
            # never compared with a provider's wall-clock signature timestamp.
```

Every retry path (unknown_provider_ref waiting for a local row, E16 races, K1 version conflicts,
transient DB errors) retries through processPending, often minutes or hours later; judging
freshness at `now` would turn each of them into a permanent failure. Python passes `received_at`
only to adapters whose `verify_webhook` accepts it, so adapters written before this keep working
(they check against now, as before).

## [EC:A27] subscription.updated — sync entering and leaving paused / incomplete

```pseudo
handlers['subscription.updated'] = async (ctx):
   if no subscriptionRef or provider has no native subscriptions: return
   local = repo.subscriptions.list({ providerRef })[0]; if none: return   # unknown: no-op
   remote = provider.getSubscription(providerRef)                          # EC:E3 re-fetch
   entering = remote.status in (paused, incomplete) and remote.status != local.status
   leaving  = local.status in (paused, incomplete) and remote.status in (active, trialing)
   if entering or leaving:
      retryOnVersionConflict: put { ...fresh, status: remote.status, currentPeriod, cancelAtPeriodEnd }
```

Other transitions (past_due via dunning, renewal, cancel) keep their own handlers, so local grace
state is never overwritten here.


## [EC:E19] 충전 지급은 결제사가 확인한 성공 결제만

```pseudo
handlers['payment.succeeded'] (subscriptionRef 없음, 일회성 충전):
   payment = resolveLocalPayment(...)          # 결제사에서 다시 조회한 status 포함
   if payment.status != 'succeeded':
      raise PaymentKitError('topup_payment_not_succeeded')   # 기록 실패, 다음 전달·재시도가 다시 확인
   n = resolveTopupCredits(payment); credits.topup(...)
```

Toss (서명 없음): 수신 시점에 허용목록이 비어 있으면 거부(fail closed), `DEPOSIT_CALLBACK` 은 `secret`
이 없으면 거부, 있으면 결제의 secret 과 상수 시간 비교(E18). 생성 코드는 `TOSS_WEBHOOK_ALLOWED_IPS` 를
`allowedWebhookIps` 로 넘기고 `handleWebhook` 에 소켓 주소(`remoteAddress`)를 넘긴다.


## [EC:E20] 서명 비밀값 교체 중 재검증

```pseudo
verifyWebhook({ headers, rawBody, receivedAt }):
   for secret in [webhookSecret, ...previousWebhookSecrets]:   # 현재 값 먼저
      if signature(rawBody, secret) matches: return event      # receivedAt 이 있으면 나이 검사 없음(E17)
   raise WebhookSignatureError
```

교체 절차: 새 값을 `*_WEBHOOK_SECRET`, 옛 값을 `*_WEBHOOK_PREVIOUS_SECRETS` 에 두고, 옛 값으로 서명된 저장
행이 다 처리된 뒤 옛 값을 지운다.
