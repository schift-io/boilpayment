# boilpayment-lifecycle

Subscription lifecycle: upgrade/downgrade with proration, cancel, trial conversion, renewal,
reactivation, dunning (`lifecycle.dunning.*`), and the polling scheduler for self-billing
providers (`lifecycle.scheduler.*`). Built on `boilpayment-core` and
`boilpayment-credits`.

## Install

```
npm install boilpayment-lifecycle boilpayment-core boilpayment-credits
```

## Usage

```ts
import { upgrade, cancel, dunning } from 'boilpayment-lifecycle';

const { sub, grant, creditDelta } = await upgrade({
  sub, newPlan, policy, provider, ledger, repo, clock, ids,
});

const { sub: cancelled, churn, revoked } = await cancel({
  sub, policy, provider, ledger, repo, clock, churnReason: 'too_expensive',
});

// Dunning, driven off webhook/scheduler events:
await dunning.onPaymentFailed({ sub, policy, repo, notifier, clock });
```

Full module contract: [docs/ARCHITECTURE.md §3.5](https://github.com/schift-io/boilpayment/blob/main/docs/ARCHITECTURE.md).
