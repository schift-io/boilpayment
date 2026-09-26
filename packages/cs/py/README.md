# schift-payment-kit-cs

Customer-support tooling for a subscription/credits business: case lifecycle (open/escalate/
resolve/reject), auto-reconciliation against provider state, balance checks, manual re-grants,
assisted refunds, dispute handling, churn recording, a case timeline/evidence builder for
chargeback disputes, and license/usage metering for the CS add-on itself.

## Install

```
pip install schift-payment-kit-cs
```

## Usage

```python
from schift_payment_kit_cs import open_case, OpenCaseInput, reconcile, ReconcileInput, regrant, RegrantInput, RegrantPlan

case = await open_case(OpenCaseInput(
    customer_id="cust_1", kind="billing_dispute", reference_id="pay_123",
    policy=policy, repo=repo, clock=clock, ids=ids,
))

# Compares ledger/repo state against each provider and opens cases for mismatches:
mismatches = await reconcile(ReconcileInput(providers=providers, ledger=ledger, repo=repo, policy=policy, clock=clock, ids=ids, since=since))

await regrant(RegrantInput(
    case=case, ledger=ledger, repo=repo, policy=policy, clock=clock, ids=ids,
    plan=RegrantPlan(pool="promo", amount=500), approved_by="support@acme.com",
))
```

Full module contract: [docs/ARCHITECTURE.md §3.5](https://github.com/schift-io/payment-kit/blob/main/docs/ARCHITECTURE.md).
