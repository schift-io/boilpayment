# @schift/payment-kit-lifecycle

Subscription lifecycle: upgrade/downgrade with proration, cancel, trial conversion, renewal,
reactivation, dunning (`lifecycle.dunning.*`), and the polling scheduler for self-billing
providers (`lifecycle.scheduler.*`). Built on `@schift/payment-kit-core` and
`@schift/payment-kit-credits`.

## Install

```
npm install @schift/payment-kit-lifecycle @schift/payment-kit-core @schift/payment-kit-credits
```

## Usage

```ts
import { upgrade, cancel, dunning } from '@schift/payment-kit-lifecycle';

const { sub, grant, creditDelta } = await upgrade({
  sub, newPlan, policy, provider, ledger, repo, clock, ids,
});

const { sub: cancelled, churn, revoked } = await cancel({
  sub, policy, provider, ledger, repo, clock, churnReason: 'too_expensive',
});

// Dunning, driven off webhook/scheduler events:
await dunning.onPaymentFailed({ sub, policy, repo, notifier, clock });
```

Full module contract: [docs/ARCHITECTURE.md §3.5](https://github.com/schift-io/payment-kit/blob/main/docs/ARCHITECTURE.md).
