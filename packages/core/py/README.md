# boilpayment-core

Core types, `Policy` (the single object that drives every edge-case decision across the kit),
dependency-injection interfaces (`Ledger`, `Repo`, `Clock`, `Notifier`, `Provider`), in-memory
reference implementations of those interfaces, and shared helpers (money, period math,
operation-level idempotency). Every other `boilpayment-*` package depends on this one.

## Install

```
pip install boilpayment-core
```

## Usage

```python
from boilpayment_core import resolve_policy, InMemoryLedger, InMemoryRepo, SystemClock, UuidIdGen

# Policy = your billing rules (proration, dunning, refund window, credit rollover, ...).
# resolve_policy(patch) deep-merges your overrides onto DEFAULT_POLICY.
policy = resolve_policy({"dunning": {"grace_days": 3}})

# Reference in-memory implementations of the DI interfaces — useful for tests and examples.
# A real app swaps these for boilpayment-schema-postgres (or its own Repo/Ledger).
ledger = InMemoryLedger()
repo = InMemoryRepo()
clock = SystemClock()
ids = UuidIdGen()

# Every other module function takes a dataclass input carrying policy/ledger/repo/clock/ids.
```

Full contract: [docs/ARCHITECTURE.md](https://github.com/schift-io/boilpayment/blob/main/docs/ARCHITECTURE.md) ·
[docs/EDGE_CASES.md](https://github.com/schift-io/boilpayment/blob/main/docs/EDGE_CASES.md).
