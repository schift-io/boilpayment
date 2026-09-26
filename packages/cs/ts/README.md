# @schift/payment-kit-cs

Customer-support tooling for a subscription/credits business: case lifecycle (open/escalate/
resolve/reject), auto-reconciliation against provider state, balance checks, manual re-grants,
assisted refunds, dispute handling, churn recording, a case timeline/evidence builder for
chargeback disputes, and license/usage metering for the CS add-on itself.

## Install

```
npm install @schift/payment-kit-cs @schift/payment-kit-core @schift/payment-kit-refund
```

## Usage

```ts
import { openCase, reconcile, regrant } from '@schift/payment-kit-cs';

const case_ = await openCase({
  customerId: 'cust_1', kind: 'billing_dispute', referenceId: 'pay_123',
  policy, repo, clock, ids,
});

// Compares ledger/repo state against each provider and opens cases for mismatches:
const mismatches = await reconcile({ providers, ledger, repo, policy, clock, ids, since });

await regrant({
  case: case_, ledger, repo, policy, clock, ids,
  plan: { pool: 'promo', amount: 500 }, approvedBy: 'support@acme.com',
});
```

Full module contract: [docs/ARCHITECTURE.md §3.5](https://github.com/schift-io/payment-kit/blob/main/docs/ARCHITECTURE.md).
