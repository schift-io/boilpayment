# boilpayment-polar

Polar implementation of `boilpayment-core`'s `PaymentProvider` protocol: checkout, native
subscriptions, refunds, Standard Webhooks verification, and normalizers from Polar's REST API
responses to the kit's `Payment`/`Subscription`/`Refund` types.

## Install

```
pip install boilpayment-polar
```

## Usage

```python
from boilpayment_polar import PolarProvider
from boilpayment_core import CreateCheckoutInput

provider = PolarProvider(
    access_token=os.environ["POLAR_ACCESS_TOKEN"],
    webhook_secret=os.environ["POLAR_WEBHOOK_SECRET"],
    server="sandbox",
)

checkout = await provider.create_checkout(CreateCheckoutInput(
    customer_ref="cust_123", plan=plan, price=price, mode="subscription",
    success_url="https://app.example.com/success", cancel_url="https://app.example.com/cancel",
    idempotency_key="checkout-1",
))
```

`PolarProvider` is passed as the `provider` dependency to `boilpayment-lifecycle`,
`boilpayment-refund`, `boilpayment-usage`, and `boilpayment-webhook`.
