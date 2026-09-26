# schift-payment-kit-webhook

Provider-agnostic webhook pipeline: `receive` (verify signature, dedupe, persist), `process` /
`process_pending` (dispatch to handlers with retry), `default_handlers` (wires lifecycle / credits /
refund / cs together), and an HTTP adapter (`create_handler`).

## Install

```
pip install schift-payment-kit-webhook
```

## Usage

```python
from schift_payment_kit_webhook import receive, process, default_handlers

handlers = default_handlers(policy=policy, ledger=ledger, repo=repo, notifier=notifier, clock=clock, ids=ids)

result = await receive(provider=stripe_provider, headers=headers, raw_body=raw_body, repo=repo, clock=clock)
if result.status == 200 and result.event_id:
    await process(event_id=result.event_id, providers={"stripe": stripe_provider}, handlers=handlers, repo=repo, clock=clock)
```

Note: `receive`, `process`, `process_pending`, and `default_handlers` take flat keyword arguments in
Python (not a dataclass input) — see
[docs/ARCHITECTURE.md §3.5](https://github.com/schift-io/payment-kit/blob/main/docs/ARCHITECTURE.md) for the
adapter needed between `default_handlers`' flat-kwarg Protocols and the dataclass-input
lifecycle/credits/refund functions.
