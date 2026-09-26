# boilpayment-credits

Credit-pool ledger operations on top of `boilpayment-core`'s append-only `Ledger`:
grant on period start, consume against a policy-defined pool order, rollover on renewal,
clawback, expiry, and top-ups. Every function is pure DI — pass in your `Ledger`/`Clock`/`Policy`.

## Install

```
npm install boilpayment-credits boilpayment-core
```

## Usage

```ts
import { consume, grantForPeriod } from 'boilpayment-credits';
import { InMemoryLedger, SystemClock, resolvePolicy } from 'boilpayment-core';

const ledger = new InMemoryLedger();
const clock = new SystemClock();
const policy = resolvePolicy();

await grantForPeriod({ sub, plan, period, payment, policy, ledger, clock });

const result = await consume({
  customerId: 'cust_1',
  amount: 10,
  policy, ledger, clock,
  idempotencyKey: 'usage-event-42',
});
```

Full module contract: [docs/ARCHITECTURE.md §3.5](https://github.com/schift-io/boilpayment/blob/main/docs/ARCHITECTURE.md).
