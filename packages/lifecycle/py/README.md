# boilpayment-lifecycle

Subscription lifecycle: upgrade/downgrade with proration, cancel, trial conversion, renewal,
reactivation, dunning (`lifecycle.dunning`), and the polling scheduler for self-billing
providers (`lifecycle.scheduler`). Built on `boilpayment-core` and
`boilpayment-credits`.

## Install

```
pip install boilpayment-lifecycle
```

## Usage

```python
from boilpayment_lifecycle import upgrade, UpgradeInput, cancel, CancelInput, dunning

result = await upgrade(UpgradeInput(
    sub=sub, new_plan=new_plan, policy=policy, provider=provider, ledger=ledger, repo=repo, clock=clock, ids=ids,
))

cancelled = await cancel(CancelInput(
    sub=sub, policy=policy, provider=provider, ledger=ledger, repo=repo, clock=clock, churn_reason="too_expensive",
))

# Dunning, driven off webhook/scheduler events:
await dunning.on_payment_failed(dunning.OnPaymentFailedInput(sub=sub, policy=policy, repo=repo, notifier=notifier, clock=clock))
```

Full module contract: [docs/ARCHITECTURE.md §3.5](https://github.com/schift-io/boilpayment/blob/main/docs/ARCHITECTURE.md).
