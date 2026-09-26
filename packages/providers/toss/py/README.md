# boilpayment-toss

Toss Payments implementation of `boilpayment-core`'s `PaymentProvider` protocol. Toss has
no native subscriptions or webhook signing — this provider bills via billing keys, restricts
webhook delivery to an IP allowlist, and normalizes Toss's status/webhook shapes into the kit's
`Payment`/`Refund` types.

## Install

```
pip install boilpayment-toss
```

## Usage

```python
from boilpayment_toss import TossProvider, TossProviderConfig
from boilpayment_core import CreateCheckoutInput

provider = TossProvider(TossProviderConfig(
    secret_key=os.environ["TOSS_SECRET_KEY"],
    client_key=os.environ.get("TOSS_CLIENT_KEY"),
))

checkout = await provider.create_checkout(CreateCheckoutInput(
    customer_ref="cust_123", plan=plan, price=price, mode="subscription",
    success_url="https://app.example.com/success", cancel_url="https://app.example.com/cancel",
    idempotency_key="checkout-1",
))
```

`TossProvider` is passed as the `provider` dependency to `boilpayment-lifecycle`,
`boilpayment-refund`, `boilpayment-usage`, and `boilpayment-webhook`.
Toss self-schedules renewals — pair with `lifecycle.scheduler.tick`.
