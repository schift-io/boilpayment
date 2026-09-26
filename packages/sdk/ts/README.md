# @schift/payment-kit-sdk

Single-install facade for Schift Payment Kit. Depends on all 13 `@schift/payment-kit-*` packages
at the exact version published alongside it (no `^` range — a mismatched internal version can
never happen) and re-exports every one of them under a subpath, so a project only installs and
imports **one** package instead of thirteen.

## Install

```
npm install @schift/payment-kit-sdk
```

## Usage

Pick your module by subpath:

```ts
import { resolvePolicy, InMemoryLedger, InMemoryRepo, SystemClock, UuidIdGen } from '@schift/payment-kit-sdk/core';
import { upgrade, downgrade, cancel, reactivate } from '@schift/payment-kit-sdk/lifecycle';
import { consume, topup } from '@schift/payment-kit-sdk/credits';
import { evaluate, execute } from '@schift/payment-kit-sdk/refund';
import { record, check } from '@schift/payment-kit-sdk/usage';
import { receive, process, defaultHandlers } from '@schift/payment-kit-sdk/webhook';
import { resend, smtp, slack } from '@schift/payment-kit-sdk/notify';
import { openCase, escalate } from '@schift/payment-kit-sdk/cs';
import { PostgresRepo, PostgresLedgerStore, migrate } from '@schift/payment-kit-sdk/postgres';
import { StripeProvider } from '@schift/payment-kit-sdk/stripe';
import { TossProvider } from '@schift/payment-kit-sdk/toss';
import { PortoneProvider } from '@schift/payment-kit-sdk/portone';
import { PolarProvider } from '@schift/payment-kit-sdk/polar';
```

Every subpath above (`/core`, `/credits`, `/lifecycle`, `/refund`, `/usage`, `/webhook`,
`/notify`, `/cs`, `/postgres`, `/stripe`, `/toss`, `/portone`, `/polar`) is a **full, unfiltered**
re-export of the corresponding `@schift/payment-kit-*` package — nothing is renamed or dropped.

The package root (`import ... from '@schift/payment-kit-sdk'`, no subpath) is narrower — see
below.

## Root export & name collisions

`@schift/payment-kit-sdk` (the bare root import) re-exports the **full** surface of
`@schift/payment-kit-core` (types, `Policy`, `Clock`/`IdGen`, period/money helpers, idempotency
helpers, in-memory reference implementations, logging) plus a curated set of the most-used entry
points from the five core operation modules:

| from | names |
|---|---|
| lifecycle | `upgrade`, `downgrade`, `cancel`, `reactivate` |
| credits | `consume`, `topup` |
| refund | `evaluate`, `execute`, `onExternalRefund` |
| usage | `record`, `check` |
| webhook | `receive`, `process`, `defaultHandlers` |

**Not** re-exported at the root — every one of these is a deliberate exclusion, not an oversight:

- **The four provider adapters** (`/stripe`, `/toss`, `/portone`, `/polar`) — they export several
  same-named symbols with genuinely different shapes:
  - `normalizeFailure`, `normalizeSubscription`, `normalizeRefund`, `mapEventType`,
    `toNormalizedEvent` — defined by **both** `@schift/payment-kit-stripe` and
    `@schift/payment-kit-polar`, with different signatures.
  - `CashReceiptType`, `CashReceiptStatus`, `CashReceipt` — defined by **both**
    `@schift/payment-kit-toss` and `@schift/payment-kit-portone`, with different shapes.

  Re-exporting any two providers at the same root would silently shadow one implementation with
  the other depending on export order. Import providers from their own subpath.
- **`/refund`'s own `prorationRatio`** (and `daysBetween`/`applyRounding`/`weightedAvgUnitPrice`) —
  `prorationRatio` is a **real** collision with `@schift/payment-kit-core`'s own `prorationRatio`
  (already re-exported at the root via the core surface). The root always resolves to core's
  version; refund's copy is only reachable via `@schift/payment-kit-sdk/refund`.
- **`/notify`, `/cs`, `/postgres`** — add-on/infra modules most projects don't touch.
- **The rest of `/lifecycle`** (`convertTrial`, `retryOnVersionConflict`, the `dunning`,
  `scheduler`, `period` namespaces), **`/credits`** (`grantForPeriod`, `rolloverOnRenewal`,
  `clawback`, `expireDue`, `notifyExpiring`), **`/usage`** (`closePeriod`, `resettlePeriod`,
  `flushOutbox`), **`/webhook`** (`processPending`, http helpers, correlation-id helpers) — no
  collision, just kept off the root to keep it short. Pull these from their subpath.

If you need both a provider's normalizer and want to avoid the root/subpath split, import
everything from the specific subpath consistently rather than mixing root + subpath imports of
the same module.

Full contract: [docs/ARCHITECTURE.md](https://github.com/schift-io/payment-kit/blob/main/docs/ARCHITECTURE.md) ·
[docs/EDGE_CASES.md](https://github.com/schift-io/payment-kit/blob/main/docs/EDGE_CASES.md).
