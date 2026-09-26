# schift-payment-kit-stripe

Stripe implementation of `schift-payment-kit-core`'s `PaymentProvider` protocol: checkout
sessions, subscription changes with proration, refunds, webhook verification, and normalizers
from Stripe's API objects to the kit's `Payment`/`Subscription`/`Refund` types.

## Install

```
pip install schift-payment-kit-stripe
```

## Usage

```python
from schift_payment_kit_stripe import StripeProvider
from schift_payment_kit_core import CreateCheckoutInput

provider = StripeProvider(
    secret_key=os.environ["STRIPE_SECRET_KEY"],
    webhook_secret=os.environ["STRIPE_WEBHOOK_SECRET"],
)

checkout = await provider.create_checkout(CreateCheckoutInput(
    customer_ref="cus_123", plan=plan, price=price, mode="subscription",
    success_url="https://app.example.com/success", cancel_url="https://app.example.com/cancel",
    idempotency_key="checkout-1",
))
```

`StripeProvider` is passed as the `provider` dependency to `schift-payment-kit-lifecycle`,
`schift-payment-kit-refund`, `schift-payment-kit-usage`, and `schift-payment-kit-webhook`.
