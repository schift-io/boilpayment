# schift-payment-kit-usage

Usage-based billing: record metered events (with late-report and duplicate handling), check a
customer against their included quantity / overage policy, close a billing period, and flush
the outbox of usage records to the provider.

## Install

```
pip install schift-payment-kit-usage
```

## Usage

```python
from schift_payment_kit_usage import record, check

await record(event=event, sub=sub, policy=policy, repo=repo, clock=clock, ids=ids)

result = await check(
    customer_id="cust_1", meter="api_calls", quantity=1,
    sub=sub, policy=policy, repo=repo, ledger=ledger, clock=clock,
)
```

Note: `record` and `check` take flat keyword arguments in Python (not a dataclass input) —
see [docs/ARCHITECTURE.md §3.5](https://github.com/schift-io/payment-kit/blob/main/docs/ARCHITECTURE.md).
