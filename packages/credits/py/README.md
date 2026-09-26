# boilpayment-credits

Credit-pool ledger operations on top of `boilpayment-core`'s append-only `Ledger`:
grant on period start, consume against a policy-defined pool order, rollover on renewal,
clawback, expiry, and top-ups. Every function is pure DI — pass in your `Ledger`/`Clock`/`Policy`.

## Install

```
pip install boilpayment-credits
```

## Usage

```python
from boilpayment_credits import consume, ConsumeCreditsInput, grant_for_period, GrantForPeriodInput
from boilpayment_core import InMemoryLedger, SystemClock, resolve_policy

ledger = InMemoryLedger()
clock = SystemClock()
policy = resolve_policy()

await grant_for_period(GrantForPeriodInput(
    sub=sub, plan=plan, period=period, payment=payment, policy=policy, ledger=ledger, clock=clock,
))

result = await consume(ConsumeCreditsInput(
    customer_id="cust_1",
    amount=10,
    policy=policy, ledger=ledger, clock=clock,
    idempotency_key="usage-event-42",
))
```

Full module contract: [docs/ARCHITECTURE.md §3.5](https://github.com/schift-io/boilpayment/blob/main/docs/ARCHITECTURE.md).
