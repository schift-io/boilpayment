# E2E round-trip — findings

Produced while building `examples/e2e/round-trip.ts` / `round_trip.py`, wiring every module
together through real code (`InMemoryLedger`/`InMemoryRepo`/`FixedClock` + an in-file fake
`PaymentProvider`). Both scripts run clean, exit 0, and print identical numbers line-for-line
(only the ISO tz suffix differs: `Z` vs `+00:00`). Two of the numbers below are **real bugs**,
not scenario mistakes — reproduced with real code paths, not asserted from reading.

## 1. `refund.evaluate`'s balance checks ignore the injected `Clock` (real bug, both languages)

- `packages/refund/ts/src/evaluate.ts:48` (B8 fallback inside `consumedFromGrants`) and `:176`
  (the B13 shortfall check) both call `ledger.balance(customerId, 'paid')` — **no `now` argument**.
- `packages/refund/py/src/schift_payment_kit_refund/evaluate.py:78` and `:241` — same, `await
  ledger.balance(customer_id, "paid")`.

`InMemoryLedger.balance()` defaults `now` to the real wall clock (`new Date()` /
`datetime.now(timezone.utc)`) when omitted — not the `clock` passed into `evaluate()`. Every
other module that needs "is this grant still valid" threads `clock.now()` through explicitly,
including credits' own `clawback()` (`packages/credits/ts/src/clawback.ts:48`,
`packages/credits/py/src/schift_payment_kit_credits/clawback.py:57`), so this looks like a
localized oversight in `refund`, not a deliberate design choice.

**Measured effect in this run** (step `07_refund`): under `FixedClock` (Jan–Mar 2026), the real
wall clock is ~2026-09, long past every grant's `expiresAt`. `ledger.balance()` (called without
`now`) sees every credit-pool bucket as already-expired and returns a phantom balance of `-220`
(only the unattributed bank-cap "expire" bookkeeping entry from finding #2 survives, since it has
no grant to expire against). The B13 `clamp_and_reduce_refund` branch then computes a ratio
against that negative number:

```
07_refund: ruleId=D1 amountMinor=-2200 creditsToRevoke=-220 needsHuman=false ...
```

A **negative** `creditsToRevoke` then fails `refund.execute`'s `if (decision.creditsToRevoke > 0)`
guard (`packages/refund/ts/src/execute.ts:38`, mirrored in py), so the entire credit-side
hold/revoke/release is silently skipped — the refund becomes money-only, and even the money side
is nonsensical (a refund of `-2200` minor units). The 300-credit grant that should have been
revoked survives untouched into step `09_grace_expired`, where `dunning.on_grace_expired`'s
`revoke_unpaid_period` finds it still fully intact and revokes all 300 of it — driving the final
balance **negative** (`-120`), which a revoke of a still-live grant should never do.

Expected fix (do not apply — out of `refund` package's scope for this task): pass `clock.now()`
into both `ledger.balance(...)` calls in `evaluate.ts`/`evaluate.py`.

## 2. `rolloverOnRenewal`'s bank-cap "expire" entry double-counts against balance (both languages)

`packages/credits/ts/src/rollover.ts` (the `expired > 0` branch, ~line 87) and its py mirror
(`packages/credits/py/src/schift_payment_kit_credits/rollover.py`) write a bookkeeping `expire`
ledger entry for the portion of a previous period's leftover that exceeds `policy.credits.bankCap`.
That entry's `reference` carries no `grantId`, so `InMemoryLedger`'s `unbucketedTotal` treats it as
a **direct balance deduction** — on top of the fact that the grants it's summarizing (e.g. the
period-1 and upgrade grants in this run) *already* independently drop out of `balance()` once
their own `expiresAt <= now`. Net effect: the excess-over-cap amount is subtracted twice.

**Measured effect** (step `06_renewal`): with `bankCap=50` and 270 credits carried into the
renewal (70 remaining on the period-1 grant + 200 on the upgrade grant), the naive expectation
is `300 (new period grant) + min(270, 50) = 350`. Actual measured balance was **130** — i.e.
`350 - 220`, where 220 is exactly the amount that exceeded the bank cap (`270 - 50`), subtracted
a second time via the unattributed `expire` entry.

This may be intentional "audit trail entry that also happens to double as a balance debit" rather
than a bug (EDGE_CASES.md doesn't document the interaction either way) — flagging for the
owner/team-lead to confirm intent rather than assuming and patching credits/rollover.

## 3. Confirmed call-shape drift from `docs/ARCHITECTURE.md` §3.5 (as anticipated by the CLI agent)

All worked around locally in the example scripts (adapters live in `round_trip.py`, nothing in
`packages/*` was touched):

- **TypeScript needs no adapters.** `lifecycle.onRenewalPaid`, `lifecycle.dunning.onPaymentFailed`,
  `refund.evaluate`, `refund.execute` all take a single input object — that's exactly the shape
  `webhook.defaultHandlers`'s `LifecycleDeps` and `cs.refundAssist`'s `RefundEvaluateFn`/
  `RefundExecuteFn` expect. Passed directly.
- **Python does need adapters.** `webhook.default_handlers`'s `LifecycleDeps` Protocol calls its
  dependencies with **flat keyword arguments** (`lifecycle.on_renewal_paid(sub=..., payment=...,
  ...)`), and `cs.refund_assist`'s `RefundEvaluateFn`/`RefundExecuteFn` Protocols do the same
  (`refund_evaluate(payment=..., sub=..., ...)`). But the real `lifecycle.on_renewal_paid`,
  `lifecycle.dunning.on_payment_failed`, `refund.evaluate`, `refund.execute` all take a **single
  dataclass-input** argument (`OnRenewalPaidInput`, `OnPaymentFailedInput`, `EvaluateInput`,
  `ExecuteInput`). Passing the real functions straight into those Protocol slots raises
  `TypeError: on_renewal_paid() got an unexpected keyword argument 'sub'`. Bridged via
  `_LifecycleAdapter` / `_LifecycleDunningAdapter` / `_refund_evaluate_adapter` /
  `_refund_execute_adapter` in `examples/e2e/round_trip.py`.
- `credits.topup`/`credits.grant_for_period` need `sub`/`customerId` + full input shape as
  documented below (§3.5 rewrite) — confirmed correct, used directly.
- `refund.execute`, `cs.regrant`, `cs.reconcile`, `cs.refund_assist` all need `ids: IdGen` —
  confirmed, threaded through via `SequentialIdGen`.
- Python `usage.record`, `usage.check`, `webhook.receive`, `webhook.process`,
  `webhook.default_handlers` are keyword-only functions (no dataclass input); every other py
  function across every module takes a single dataclass input. Confirmed exactly as described,
  used directly with no adapter needed.

## 4. Not exercised, flagged from reading only — `webhook.handlers`'s topup wiring looks broken

`packages/webhook/ts/src/handlers.ts`'s `onPaymentSucceeded` (mirrored in
`packages/webhook/py/src/schift_payment_kit_webhook/handlers.py`'s `on_payment_succeeded`) calls
`credits.topup({ customerId, payment, credits: null, ... })` (py: `credits=None`) when a
`payment.succeeded` event has no `subscriptionRef` (i.e. a bare top-up payment). But the real
`credits.topup`/`topup()` requires `credits: number` (ts) / `credits: int` (py) — it's used
directly as the grant amount (`priceCredits(payment.amount.amountMinor, credits)`,
`amount: credits` on the ledger entry). Passing `null`/`None` would either produce a ledger entry
with `amount: null` (ts, since `credits <= 0` is `false` for `null` but `Math.floor(x/null)` is
`NaN`) or raise (py: `None <= 0` raises `TypeError`). **Not exercised in this scenario** — this
run's topup path goes through `cs.reconcile`/`cs.regrant` (step `08_cs_reconcile`), not the
webhook `payment.succeeded` path, so the actual runtime failure was not observed directly, only
read from source. Worth a second pair of eyes before anyone wires a real top-up-via-webhook flow.

## Not covered

`lifecycle.downgrade`, `lifecycle.cancel`, `lifecycle.convertTrial`/`isTrialEligible`,
`lifecycle.scheduler.tick`, `credits.expireDue`, `usage.closePeriod`/`flushOutbox`,
`cs.dispute`/`churn`/`widget`, `webhook.getGrantsForCheckout` — all read for the §3.5 rewrite
below but not run in this scenario (out of the 9 steps the team-lead specified). Their exported
signatures below are transcribed from source, not exercised end-to-end.

---

## Resolution (2026-09-09, team lead)

| # | Fix | Files | Verified |
|---|---|---|---|
| 1 | `refund.evaluate` now threads `clock.now()` into every `ledger.balance` call (`consumedFromGrants` takes `now`) | refund ts/py `evaluate.ts` / `evaluate.py` | step 07: D1 → 3000 minor / 300 credits, balance 350→50 |
| 2 | `credits.rolloverOnRenewal` no longer writes an unattributed `expire` row for the bank-cap excess (source grants lapse on their own `expiresAt`) | credits ts/py `rollover.ts` / `rollover.py` | step 06: balance 350 (= 300 + min(270, cap 50)) |
| 3 (new) | `refund.execute` attributes revoke rows to the payment's grant buckets (`reference.grantId`, key `revoke:refund:{refundId}:{grantId}`), so dunning A16 / expiry B14 see the grant as consumed | refund ts/py `execute.ts` / `execute.py` | step 09: `revoked_count=0`, balance stays 100 (was −200) |
| 4 (read-only flag) | `webhook.defaultHandlers` one-time top-up branch now requires `resolveTopupCredits(payment)`; unresolved → record fails with `topup_credits_unresolved` instead of passing `null` | webhook ts/py `handlers.ts` / `handlers.py` | typecheck + webhook smokes |

Both `examples/e2e/round-trip.ts` and `round_trip.py` print identical lines after the fixes (tz suffix / bool casing aside).
