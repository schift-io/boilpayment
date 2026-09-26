# @schift/payment-kit-core

Core types, `Policy` (the single object that drives every edge-case decision across the kit),
dependency-injection interfaces (`Ledger`, `Repo`, `Clock`, `Notifier`, `Provider`), in-memory
reference implementations of those interfaces, and shared helpers (money, period math,
operation-level idempotency). Every other `@schift/payment-kit-*` package depends on this one.

## Install

```
npm install @schift/payment-kit-core
```

## Usage

```ts
import { resolvePolicy, InMemoryLedger, InMemoryRepo, SystemClock, UuidIdGen } from '@schift/payment-kit-core';

// Policy = your billing rules (proration, dunning, refund window, credit rollover, ...).
// resolvePolicy(patch) deep-merges your overrides onto DEFAULT_POLICY.
const policy = resolvePolicy({ dunning: { graceDays: 3 } });

// Reference in-memory implementations of the DI interfaces — useful for tests and examples.
// A real app swaps these for @schift/payment-kit-schema-postgres (or its own Repo/Ledger).
const ledger = new InMemoryLedger();
const repo = new InMemoryRepo();
const clock = new SystemClock();
const ids = new UuidIdGen();

// Every other module function takes `{ ..., policy, ledger, repo, clock, ids }` as its input.
```

Full contract: [docs/ARCHITECTURE.md](https://github.com/schift-io/payment-kit/blob/main/docs/ARCHITECTURE.md) ·
[docs/EDGE_CASES.md](https://github.com/schift-io/payment-kit/blob/main/docs/EDGE_CASES.md).
