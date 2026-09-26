# schift-payment-kit

Single-install facade for Schift Payment Kit. Depends on all 13 `schift-payment-kit-*`
distributions pinned to the exact version published alongside it (`==0.1.0`, not a range — a
mismatched internal version can never happen) and re-exports every one of them as a submodule, so
a project only installs and imports **one** distribution instead of thirteen.

## Install

```
pip install schift-payment-kit
```

## Usage

Pick your module by submodule:

```python
from schift_payment_kit.core import resolve_policy, InMemoryLedger, InMemoryRepo, SystemClock, UuidIdGen
from schift_payment_kit.lifecycle import upgrade, downgrade, cancel, reactivate
from schift_payment_kit.credits import consume, topup
from schift_payment_kit.refund import evaluate, execute
from schift_payment_kit.usage import record, check
from schift_payment_kit.webhook import receive, process, default_handlers
from schift_payment_kit.notify import resend, smtp, slack
from schift_payment_kit.cs import open_case, escalate
from schift_payment_kit.postgres import PostgresRepo, PostgresLedgerStore, migrate
from schift_payment_kit.stripe import StripeProvider
from schift_payment_kit.toss import TossProvider
from schift_payment_kit.portone import PortoneProvider
from schift_payment_kit.polar import PolarProvider
```

Every submodule above (`.core`, `.credits`, `.lifecycle`, `.refund`, `.usage`, `.webhook`,
`.notify`, `.cs`, `.postgres`, `.stripe`, `.toss`, `.portone`, `.polar`) is a **full, unfiltered**
re-export of the corresponding `schift-payment-kit-*` distribution — nothing is renamed or
dropped, and each has its own explicit `__all__` mirroring the source distribution's public
surface.

The package root (`from schift_payment_kit import ...`, no submodule) is narrower — see below.

## Root export & name collisions

`schift_payment_kit` (the bare root import) re-exports the **full** surface of
`schift_payment_kit_core` (types, `Policy`, `Clock`/`IdGen`, period/money helpers, idempotency
helpers, in-memory reference implementations, logging) plus a curated set of the most-used entry
points from the five core operation modules:

| from | names |
|---|---|
| lifecycle | `upgrade`, `downgrade`, `cancel`, `reactivate` |
| credits | `consume`, `topup` |
| refund | `evaluate`, `execute`, `on_external_refund` |
| usage | `record`, `check` |
| webhook | `receive`, `process`, `default_handlers` |

**Not** re-exported at the root — every one of these is a deliberate exclusion, not an oversight:

- **The four provider adapters** (`.stripe`, `.toss`, `.portone`, `.polar`) — they export several
  same-named symbols with genuinely different shapes:
  - `normalize_failure`, `normalize_subscription`, `normalize_refund`, `map_event_type`,
    `to_normalized_event` — defined by **both** `schift_payment_kit_stripe` and
    `schift_payment_kit_polar`, with different signatures.
  - `CashReceiptType`, `CashReceiptStatus`, `CashReceipt` — defined by **both**
    `schift_payment_kit_toss` and `schift_payment_kit_portone`, with different shapes.

  Re-exporting any two providers at the same root would silently shadow one implementation with
  the other depending on import order. Import providers from their own submodule.
- **`.refund`'s own `proration_ratio`** (and `days_between`/`apply_rounding`/
  `weighted_avg_unit_price`) — `proration_ratio` is a **real** collision with
  `schift_payment_kit_core`'s own `proration_ratio` (already re-exported at the root via the core
  surface). The root always resolves to core's version; refund's copy is only reachable via
  `schift_payment_kit.refund`.
- **`.notify`, `.cs`, `.postgres`** — add-on/infra modules most projects don't touch.
- **The rest of `.lifecycle`** (`convert_trial`, `retry_on_version_conflict`, the `dunning`,
  `scheduler`, `period` submodules), **`.credits`** (`grant_for_period`, `rollover_on_renewal`,
  `clawback`, `expire_due`, `notify_expiring`), **`.usage`** (`close_period`, `flush_outbox`),
  **`.webhook`** (`process_pending`, http helpers, correlation-id helpers) — no collision, just
  kept off the root to keep it short. Pull these from their submodule.

Full contract: [docs/ARCHITECTURE.md](https://github.com/schift-io/payment-kit/blob/main/docs/ARCHITECTURE.md) ·
[docs/EDGE_CASES.md](https://github.com/schift-io/payment-kit/blob/main/docs/EDGE_CASES.md).
