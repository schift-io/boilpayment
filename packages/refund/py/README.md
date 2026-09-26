# boilpayment-refund

Refund decisioning and execution: policy-driven `evaluate` (no-questions window, proration,
credit vs. cash, overuse handling) followed by `execute` against a provider, plus
`on_external_refund` to reconcile a refund initiated outside the kit (e.g. in the provider dashboard).

## Install

```
pip install boilpayment-refund
```

## Usage

```python
from boilpayment_refund import evaluate, EvaluateInput, execute, ExecuteInput

decision = await evaluate(EvaluateInput(payment=payment, sub=sub, policy=policy, ledger=ledger, repo=repo, clock=clock))

if decision.approved:
    refund = await execute(ExecuteInput(decision=decision, provider=provider, ledger=ledger, repo=repo, clock=clock, ids=ids))
```

Full module contract: [docs/ARCHITECTURE.md §3.5](https://github.com/schift-io/boilpayment/blob/main/docs/ARCHITECTURE.md).
