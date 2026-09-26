# boilpayment

Single-install facade for boilpayment. Depends on all 13 `boilpayment-*`
distributions pinned to the exact version published alongside it (`==0.1.0`, not a range — a
mismatched internal version can never happen) and re-exports every one of them as a submodule, so
a project only installs and imports **one** distribution instead of thirteen.

## Install

```
pip install boilpayment
```

## Usage

Pick your module by submodule:

```python
from boilpayment.core import resolve_policy, InMemoryLedger, InMemoryRepo, SystemClock, UuidIdGen
from boilpayment.lifecycle import upgrade, downgrade, cancel, reactivate
from boilpayment.credits import consume, topup
from boilpayment.refund import evaluate, execute
from boilpayment.usage import record, check
from boilpayment.webhook import receive, process, default_handlers
from boilpayment.notify import resend, smtp, slack
from boilpayment.cs import open_case, escalate
from boilpayment.postgres import PostgresRepo, PostgresLedgerStore, migrate
from boilpayment.stripe import StripeProvider
from boilpayment.toss import TossProvider
from boilpayment.portone import PortoneProvider
from boilpayment.polar import PolarProvider
```

Every submodule above (`.core`, `.credits`, `.lifecycle`, `.refund`, `.usage`, `.webhook`,
`.notify`, `.cs`, `.postgres`, `.stripe`, `.toss`, `.portone`, `.polar`) is a **full, unfiltered**
re-export of the corresponding `boilpayment-*` distribution — nothing is renamed or
dropped, and each has its own explicit `__all__` mirroring the source distribution's public
surface.

The package root (`from boilpayment import ...`, no submodule) is narrower — see below.

## Root export & name collisions

`boilpayment` (the bare root import) re-exports the **full** surface of
`boilpayment_core` (types, `Policy`, `Clock`/`IdGen`, period/money helpers, idempotency
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
    `to_normalized_event` — defined by **both** `boilpayment_stripe` and
    `boilpayment_polar`, with different signatures.
  - `CashReceiptType`, `CashReceiptStatus`, `CashReceipt` — defined by **both**
    `boilpayment_toss` and `boilpayment_portone`, with different shapes.

  Re-exporting any two providers at the same root would silently shadow one implementation with
  the other depending on import order. Import providers from their own submodule.
- **`.refund`'s own `proration_ratio`** (and `days_between`/`apply_rounding`/
  `weighted_avg_unit_price`) — `proration_ratio` is a **real** collision with
  `boilpayment_core`'s own `proration_ratio` (already re-exported at the root via the core
  surface). The root always resolves to core's version; refund's copy is only reachable via
  `boilpayment.refund`.
- **`.notify`, `.cs`, `.postgres`** — add-on/infra modules most projects don't touch.
- **The rest of `.lifecycle`** (`convert_trial`, `retry_on_version_conflict`, the `dunning`,
  `scheduler`, `period` submodules), **`.credits`** (`grant_for_period`, `rollover_on_renewal`,
  `clawback`, `expire_due`, `notify_expiring`), **`.usage`** (`close_period`, `flush_outbox`),
  **`.webhook`** (`process_pending`, http helpers, correlation-id helpers) — no collision, just
  kept off the root to keep it short. Pull these from their submodule.

Full contract: [docs/ARCHITECTURE.md](https://github.com/schift-io/boilpayment/blob/main/docs/ARCHITECTURE.md) ·
[docs/EDGE_CASES.md](https://github.com/schift-io/boilpayment/blob/main/docs/EDGE_CASES.md).
