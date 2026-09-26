# @schift/payment-kit-usage

Usage-based billing: record metered events (with late-report and duplicate handling), check a
customer against their included quantity / overage policy, close a billing period, and flush
the outbox of usage records to the provider.

## Install

```
npm install @schift/payment-kit-usage @schift/payment-kit-core
```

## Usage

```ts
import { record, check } from '@schift/payment-kit-usage';

await record({ event, sub, policy, repo, clock, ids });

const { allow, overage, remaining } = await check({
  customerId: 'cust_1', meter: 'api_calls', quantity: 1,
  sub, policy, repo, ledger, clock,
});
```

Full module contract: [docs/ARCHITECTURE.md §3.5](https://github.com/schift-io/payment-kit/blob/main/docs/ARCHITECTURE.md).
