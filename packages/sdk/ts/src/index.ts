// @schift/payment-kit-sdk — root export.
//
// Deliberately narrow (see README.md "Root export & name collisions" for the full rationale and
// the two real name collisions this avoids). What's here:
//   1. The full surface of @schift/payment-kit-core (types, Policy, Clock/IdGen, period/money
//      helpers, idempotency helpers, in-memory reference implementations, logging) — this is what
//      every other module's function signatures are built from, so it's safe and expected to be
//      fully available at the root.
//   2. A curated set of the most-used entry points from the five core operation modules
//      (lifecycle, credits, refund, usage, webhook), so `import { upgrade, consume, evaluate,
//      record, receive } from '@schift/payment-kit-sdk'` covers the common path without picking a
//      subpath.
//
// NOT re-exported here — use the dedicated subpath instead:
//   - `/stripe`, `/toss`, `/portone`, `/polar` — the four provider adapters export several
//     same-named functions/types with DIFFERENT shapes (`normalizeFailure`, `normalizeSubscription`,
//     `normalizeRefund`, `mapEventType`, `toNormalizedEvent` collide between stripe/polar;
//     `CashReceiptType`, `CashReceiptStatus`, `CashReceipt` collide between toss/portone). Bundling
//     any two of them at the root would silently shadow one implementation with the other.
//   - `/notify`, `/cs`, `/postgres` — add-on/infra modules, not every project uses them.
//   - `/refund`'s own `prorationRatio` (and `daysBetween`/`applyRounding`/`weightedAvgUnitPrice`) —
//     `prorationRatio` is a REAL collision with core's own `prorationRatio` (re-exported via #1
//     above); refund's copy is available at `/refund` only, so `import ... from
//     '@schift/payment-kit-sdk'` always gets core's version unambiguously.
//   - the rest of `/lifecycle` (`downgrade`/`convertTrial`/`retryOnVersionConflict`/the `dunning`,
//     `scheduler`, `period` namespaces), `/credits` (`grantForPeriod`/`rolloverOnRenewal`/
//     `clawback`/`expireDue`/`notifyExpiring`), `/usage` (`closePeriod`/`resettlePeriod`/
//     `flushOutbox`), `/webhook` (`processPending`/`defaultHandlers`/http helpers/correlation ids)
//     — deeper wiring, no collisions, just kept off the root to keep it a short list. Pull them
//     from their subpath.

export * from '@schift/payment-kit-core';

export { upgrade, downgrade, cancel, reactivate } from '@schift/payment-kit-lifecycle';
export { consume, topup } from '@schift/payment-kit-credits';
export { evaluate, execute, onExternalRefund } from '@schift/payment-kit-refund';
export { record, check } from '@schift/payment-kit-usage';
export { receive, process, defaultHandlers } from '@schift/payment-kit-webhook';
