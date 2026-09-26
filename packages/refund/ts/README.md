# @schift/payment-kit-refund

Refund decisioning and execution: policy-driven `evaluate` (no-questions window, proration,
credit vs. cash, overuse handling) followed by `execute` against a provider, plus
`onExternalRefund` to reconcile a refund initiated outside the kit (e.g. in the provider dashboard).

## Install

```
npm install @schift/payment-kit-refund @schift/payment-kit-core
```

## Usage

```ts
import { evaluate, execute } from '@schift/payment-kit-refund';

const decision = await evaluate({ payment, sub, policy, ledger, repo, clock });

if (decision.approved) {
  const refund = await execute({ decision, provider, ledger, repo, clock, ids });
}
```

Full module contract: [docs/ARCHITECTURE.md §3.5](https://github.com/schift-io/payment-kit/blob/main/docs/ARCHITECTURE.md).
