# usage — spec (source of truth)

Public API: `record`, `check`, `closePeriod`, `flushOutbox`.
Mirrors `docs/ARCHITECTURE.md` §3.5 `usage.*`, extended per `docs/ARCHITECTURE.md`.

Design note (updated 2026-09-09, per team-lead): `record()` needs "the
previous period's start" for late-report attribution (EC:C2). `core` exposes
`periodContaining(anchorStart, interval, now, anchorDay, tz, monthEndAnchor)`
— the period containing `now`, walked **forward** from `anchorStart`. When an
optional `plan` is passed to `record()` (so we know `plan.interval`), we use
`sub.createdAt` as `anchorStart` and call
`periodContaining(sub.createdAt, plan.interval, event.occurredAt, sub.anchorDay, policy.period.timezone, policy.period.monthEndAnchor)`
to get the exact period containing `occurredAt`. `sub.createdAt` is used
(not `sub.currentPeriod.start`) because `periodContaining` cannot look
*backward* from its anchor — for a late report, `occurredAt` is before
`currentPeriod.start`, so the anchor must already precede it, and
`sub.createdAt` is the only instant on `Subscription` guaranteed to. This
assumes periods have been contiguous at a fixed interval since creation
(true absent an anchor-resetting upgrade/downgrade — acceptable for a late-
report attribution decision, not a billing calculation).

When `plan` is omitted (record() doesn't always have one at the call site),
we keep the earlier approximation:
`previousPeriodStart = currentPeriod.start - (currentPeriod.end - currentPeriod.start)`,
which is exact for fixed-length periods and reasonable across month-length
boundaries for the same reason (EC:C2 only cares about "is this event late").

---

## [EC:C3] timestamps UTC

```pseudo
# All Clock.now() and stored timestamps (occurredAt, receivedAt, periodStart,
# nextAttemptAt) are UTC datetimes (tz-aware in py: datetime.UTC; Date in ts,
# always constructed/compared in UTC — never localized before storage).
# Localization for display is out of scope for this package.
```

## [EC:C2] usage.record — period attribution incl. late reports

```pseudo
input: {
  event: { customerId, meter, quantity, occurredAt, idempotencyKey, meta? },
  sub,            # Subscription — sub.currentPeriod used for attribution
  policy, repo, clock, ids,
  provider?,      # optional PaymentProvider — for EC:C4 outbox enqueue
  plan?,          # optional Plan — enables exact previous-period attribution, see design note above
}
output: { event: UsageEvent, duplicated: bool }

idempotency_key = event.idempotencyKey

steps:
  1. existing = repo.usageEvents.list({ customerId, idempotencyKey: idempotency_key })   # EC:B20 per customer
     if existing non-empty: return { event: existing[0], duplicated: true }   # EC:B12-style dedupe applied to usage
  2. receivedAt = clock.now()
  3. periodStart = sub.currentPeriod.start
     if event.occurredAt < sub.currentPeriod.start:
        lateHours = (receivedAt - sub.currentPeriod.start) in hours
        if lateHours <= policy.usage.lateReportWindowHours:
           if plan is not null and plan.interval is not null:
              periodStart = periodContaining(sub.createdAt, plan.interval, event.occurredAt,
                                              sub.anchorDay, policy.period.timezone, policy.period.monthEndAnchor).start
           else:
              periodStart = sub.currentPeriod.start - (sub.currentPeriod.end - sub.currentPeriod.start)  # approximation, see design note
        else:
           periodStart = sub.currentPeriod.start   # window passed: attribute to current
  4. row = UsageEvent{
       id: ids.newId(), customerId: event.customerId, meter: event.meter,
       quantity: event.quantity, occurredAt: event.occurredAt, receivedAt,
       periodStart, idempotencyKey: idempotency_key, meta: event.meta ?? null,  # EC:C7
     }
  5. saved = repo.usageEvents.put(row)
  6. if provider is not null and provider.capabilities().meters:            # EC:C4
        repo.outbox.put(OutboxItem{
          id: ids.newId(), kind: 'usage.report',
          payload: { eventId: saved.id, customerId: saved.customerId, meter: saved.meter,
                     quantity: saved.quantity, occurredAt: saved.occurredAt, provider: sub.provider },
          status: 'pending', attempts: 0, nextAttemptAt: clock.now(), createdAt: clock.now(),
        })
  7. return { event: saved, duplicated: false }
```

## [EC:C7] meta stored

```pseudo
# event.meta (requestId/ip/userAgent/anything the app passes) is stored verbatim
# on UsageEvent.meta — read back later by cs.* for usage disputes ("I never used it").
```

## [EC:C1] [EC:C5] [EC:C6] [EC:A14] [EC:C8] usage.check — overage decision

```pseudo
input: {
  customerId, meter, quantity, sub, policy, repo, ledger, clock,
  ids?, idempotencyKey?, includedQuantity?,   # includedQuantity overrides policy.usage.includedQuantity (e.g. from Plan.usageIncluded)
}
output: { allow: bool, overage: int, reason: str, remaining: int, notify?: 'usage.soft_cap' }

included = includedQuantity ?? policy.usage.includedQuantity          # EC:C5

# EC:A14 / EC:C6 — grace period gating happens before quota math
if sub.status == 'past_due':
   if policy.dunning.usageDuringGrace == 'block':
      return { allow: false, overage: 0, reason: 'grace_block', remaining: 0 }
   # 'allow_existing_only' falls through to quota math below (no new overage allowed,
   # but usage within already-included quota still works) — same math as hard_block.
   # 'allow' — no extra restriction, falls through unchanged.

# EC:C8 — credit-conversion hybrid replaces quota math entirely
if policy.usage.creditConversion is not null:
   conv = policy.usage.creditConversion
   creditAmount = quantity * conv.creditsPerUnit
   key = idempotencyKey ?? ('usage:check:' + customerId + ':' + meter + ':' + clock.now().isoformat())
   result = ledger.consume({
     customerId, poolOrder: ['paid', 'promo', 'trial'], amount: creditAmount,
     idempotencyKey: key, meta: { reason: 'usage:' + meter }, now: clock.now(),
     negativeBalance: policy.credits.negativeBalance, negativeFloor: policy.credits.negativeFloor,
   })
   if result.ok:
      return { allow: true, overage: 0, reason: 'credit_conversion', remaining: -result.shortfall }
   else:
      return { allow: false, overage: 0, reason: 'credit_conversion_insufficient', remaining: 0 }

# EC:C1 — quota + overage mode
periodUsage = sum(quantity for e in repo.usageEvents.list({ customerId, meter })
                   if e.periodStart == sub.currentPeriod.start)
projected = periodUsage + quantity
overage = max(0, projected - included)
remaining = max(0, included - periodUsage)

blockGrace = sub.status == 'past_due' and policy.dunning.usageDuringGrace == 'allow_existing_only'

if overage == 0:
   return { allow: true, overage: 0, reason: 'within_included', remaining: remaining - quantity }

# projected exceeds included quantity
switch policy.usage.overage:
  'hard_block':
     return { allow: false, overage, reason: 'hard_block', remaining }
  'soft_cap_notify':
     if blockGrace: return { allow: false, overage, reason: 'grace_block_overage', remaining }
     return { allow: true, overage, reason: 'soft_cap_notify', remaining, notify: 'usage.soft_cap' }
  'bill_overage':
     if blockGrace: return { allow: false, overage, reason: 'grace_block_overage', remaining }
     return { allow: true, overage, reason: 'bill_overage', remaining }
```

## [EC:C10] usage.reserve / commit / release — budget for long-running work

A reservation is two ledger rows keyed by (customer, job): `hold` (−amount, `expiresAt` = now + TTL,
source `usage`, key `usage:reserve:{c}:{job}`) and later one `release` (+amount, key
`usage:reserve:release:{c}:{job}`, reason `reservation:committed:{n}` | `released` | `expired`).
Holds count against `balance().available` in every store.

```pseudo
reserve({customerId, jobId, amount>0, policy, ledger, clock}):
  ledger.transaction(customerId):                  # per-customer lock -> racing reserves serialize
    if hold(customerId, jobId) exists: return {ok, reservation, duplicated: true}
    release every held reservation of customerId with expiresAt <= now   (reason expired)
    available = ledger.balance(customerId, all pools, now).available
    if available < amount: return {ok: false, reason: 'insufficient', need: amount, available}
    append hold(-amount, expiresAt = now + policy.usage.reservationTtlMinutes)
commit({..., jobId, amount 0..reserved}):
  ledger.transaction(customerId):
    r = reservation; none -> error reservation_not_found
    r committed -> duplicated; r released/expired -> error reservation_closed
    r.expiresAt <= now -> release(expired); error reservation_expired
    amount > r.amount -> error reservation_exceeded
    amount > 0: ledger.consume(amount, key usage:reserve:commit:{c}:{job})   # charge first
                not ok -> error reservation_commit_short (hold stays; caller may release)
    append release(+r.amount, reason committed:{amount})
release({..., jobId}): held -> append release(reason released); otherwise duplicated
sweepReservations({repo, ledger, clock}): for each customer, in its transaction, expire due holds
```

`check` is unchanged. A direct `ledger.consume` draws from grant buckets and does not look at holds;
gate work through `reserve` (or `balance().available`) so reservations are respected.

## [EC:C9] usage.closePeriod — aggregate + overage bill

```pseudo
input: { sub, policy, repo, provider?, clock, ids, currency? }
output: { total: int, overage: int, overageAmount: Money | null }

events = repo.usageEvents.list({ customerId: sub.customerId })
periodEvents = [e for e in events if e.periodStart == sub.currentPeriod.start]
total = sum(e.quantity for e in periodEvents)
overage = max(0, total - policy.usage.includedQuantity)

overageAmount = null
if overage > 0 and policy.usage.overage == 'bill_overage' and policy.usage.overageUnitPriceMinor is not null:
   overageAmount = Money{ amountMinor: overage * policy.usage.overageUnitPriceMinor, currency: resolveBillingCurrency(currency, repo.plans.get(sub.planId)) }

# best-effort persistence — Repo (core §3.4) has no `usagePeriods` table; if a
# concrete Repo implementation exposes one (duck-typed) we use it, else we just return.
if hasattr(repo, 'usagePeriods'):
   repo.usagePeriods.put({ subscriptionId: sub.id, periodStart: sub.currentPeriod.start,
                            total, overage, closedAt: clock.now() })

return { total, overage, overageAmount }
```

## [EC:C2][EC:C9] resettlePeriod — bill usage that arrived after the period closed

```pseudo
# closePeriod() computes a total at close time. record() keeps attributing to that period for
# late_report_window_hours afterwards (C2), so without this the late usage is never invoiced.
input: sub, periodStart (a CLOSED period), policy, repo, clock, settledTotal?, currency?

settledTotal = settledTotal
               ?? repo.usagePeriods.list({subscriptionId: sub.id, periodStart})[0].total   # duck-typed
               ?? raise "settledTotal is required ..."

total    = sum(e.quantity for e in repo.usageEvents.list({customerId}) if e.periodStart == periodStart)
newlyReported     = max(0, total - settledTotal)
included          = policy.usage.includedQuantity
additionalOverage = max(0, total - included) - max(0, settledTotal - included)   # only the part that
                                                                                 # crosses the quota
additionalOverageAmount = additionalOverage * policy.usage.overageUnitPriceMinor
                          if additionalOverage > 0 and policy.usage.overage == 'bill_overage' else None

periodEnd  = sub.currentPeriod.end if periodStart == sub.currentPeriod.start else sub.currentPeriod.start
windowOpen = clock.now() < periodEnd + policy.usage.lateReportWindowHours     # informational: after
                                                                              # this, record() can no
                                                                              # longer land here
if newlyReported > 0 and repo.usagePeriods: repo.usagePeriods.put({... total ...})   # -> replay is a no-op
return {total, settledTotal, newlyReported, additionalOverage, additionalOverageAmount, windowOpen}
```

The caller (a cron, outside this package) charges `additionalOverageAmount` through the provider.

## [EC:C4] usage.flushOutbox — provider meter reporting retry

```pseudo
input: { repo, providers, clock, maxAttempts = 8 }
output: { sent: int, failed: int, retried: int }

pending = repo.outbox.list({ kind: 'usage.report', status: 'pending' })
now = clock.now()
for item in pending:
   if item.nextAttemptAt > now: continue
   provider = providers[item.payload.provider]
   if provider is null: continue    # no provider configured for this event — leave pending

   # resolve provider-side customer ref (updated 2026-09-09, per team-lead — closes the caveat
   # this section used to flag): the outbox payload only ever carries the internal customerId, so
   # look up the provider ref via the customer's repo row.
   customer = repo.customers.get(item.payload.customerId)
   providerRef = first(r.ref for r in (customer.providerRefs if customer else [])
                        if r.provider == item.payload.provider)
   if providerRef is null:
      # terminal, not transient — retrying won't link this customer to the provider by itself.
      item.attempts += 1
      item.status = 'failed'
      item.payload = { ...item.payload, error: 'no_provider_ref' }  # OutboxItem has no dedicated error field
      repo.outbox.put(item)
      failed += 1
      continue

   item.attempts += 1               # counts every attempt, success or failure
   try:
      provider.reportUsage({
        meter: item.payload.meter, customerRef: providerRef,
        quantity: item.payload.quantity, occurredAt: item.payload.occurredAt,
        idempotencyKey: item.payload.eventId,
      })
      item.status = 'sent'; repo.outbox.put(item); sent += 1
   except Exception as e:
      if item.attempts >= maxAttempts:
         item.status = 'failed'
      else:
         item.status = 'pending'
         item.nextAttemptAt = now + backoff(item.attempts)   # exponential: 2^attempts minutes, capped at 60min
      repo.outbox.put(item)
      failed += 1 if item.status == 'failed' else 0
      retried += 1 if item.status == 'pending' else 0
```

### Billing currency and credit conversion rules

Both closePeriod and resettlePeriod use the selected billing currency, or infer it only when the plan has exactly one currency. Missing or ambiguous currency raises `billing_currency_required` before saving settlement totals. There is no default USD currency. Multi-currency plans require the caller to supply the selected currency.

Credit-conversion usage consumes pools in `policy.credits.consumeOrder`, matching credits.consume: expiring_first = paid/promo/trial; promo_first_then_expiring = promo/trial/paid; paid_first = paid/trial/promo.

## Durable `settlePeriod` and `settleDuePeriods`

`settlePeriod({sub, period, policy, repo, ledger, provider, clock, currency?})`
returns `{status, total, chargedAmount, payment}`. Python uses the corresponding
snake_case function and fields. `settleDuePeriods` accepts `policy`, `repo`,
`ledger`, `providers`, and `clock`, and returns entries containing subscription ID,
original period, and settlement result. Generated cron must call this service;
`closePeriod` and `resettlePeriod` alone only compute amounts.

- Before the exact period end: `not_due`, no provider mutation.
- No billable delta: `unchanged`.
- Billing-key route: supports non-native, non-metered providers with a linked
  provider customer. A customer-scoped transaction commits the immutable request,
  pending payment, operation, and five-minute `usage.charge` retry lease. The
  provider call runs **outside** that transaction. A separate transaction saves
  its payment outcome and advances the paid checkpoint only for `succeeded`.
- Lost responses propagate while the committed request remains `in_progress`.
  Calls during its lease return `pending`; after the lease, retry the original
  amount and idempotency key, or query a known provider payment reference. Late
  usage cannot replace this request. Once resolved, only the unpaid delta is billed.
- A declined payment returns `failed` on subsequent cron calls; it is not renamed
  successful or silently charged under a fresh key. Pending/action-required or
  otherwise unresolved responses remain `pending`.
- Native metered route: persist missing reports with stable event IDs and flush
  the existing outbox. Return `awaiting_provider_billing` only after report
  acceptance, or `report_pending` / `report_failed`. These states do **not** prove
  an invoice was created or paid. Native provider meter/rate/included-quantity
  configuration must match the seller's rules. Never also charge a billing key
  for events already routed through provider meters.
- Customer usage with multiple subscriptions is ambiguous because UsageEvent
  has no subscription ID; reject it at the public settlement boundary.
- The supplied end must match the original payment/subscription period. Historical
  settlement requires a persisted original subscription invoice or prior settlement
  snapshot; never guess its period from a subsequently changed plan. Derive currency
  from that original payment, and reject conflicting selections.

The service owns its transaction boundaries. Callers must not wrap the complete
service in an outer database transaction. Provider idempotency and its retention
contract remain required for retrying an unknown remote outcome. Real PostgreSQL
regressions verify committed intent survives a lost response and that late usage
creates only a separate delta after the original request resolves.

## [EC:C11] 끝났거나 권한 없는 구독은 이용·예약 불가

```pseudo
hasNoEntitlement(status) = status in ('paused', 'incomplete', 'canceled', 'expired')
check(sub, ...):   if hasNoEntitlement(sub.status): return { allow: false, reason: 'subscription_inactive' }
reserve(..., sub?): if sub and hasNoEntitlement(sub.status): return { ok: false, reason: 'subscription_inactive' }   # hold 전
```

`record` 와 `credits.consume` 은 막지 않는다: 이미 일어난 사용량 기록과, 구독과 무관한 충전 크레딧 사용.

## [EC:A75] 초과 청구의 customerKey 와 구독별 격리
customerRef = sub.billingCustomerRef || customer.providerRefs[provider]
settleDuePeriods: 구독마다 try; 오류는 모아 두고 전부 돈 뒤 usage_settlement_errors({errors, results})
첫 청구가 성공한 적 없는 닫힌 가입(incomplete/expired)은 사용량 주인 후보가 아님

## [EC:A83] 미확정·거절된 초과 청구는 매 실행 오류
settleDuePeriods: result.status in (pending, failed) -> errors 에 overage_charge_<status> (실행마다)
