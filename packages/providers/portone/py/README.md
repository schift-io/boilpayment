# boilpayment-portone

PortOne V2 implementation of `boilpayment-core`'s `PaymentProvider` protocol: checkout,
billing-key issuance/charging, PortOne's own renewal scheduling (or self-scheduling), cash
receipts, Standard Webhooks verification, and normalizers to the kit's `Payment`/`Subscription`/
`Refund` types. Endpoints verified against PortOne's V2 OpenAPI spec.

## Install

```
pip install boilpayment-portone
```

## Usage

```python
from boilpayment_portone import PortoneProvider, PortoneProviderConfig
from boilpayment_core import CreateCheckoutInput

provider = PortoneProvider(PortoneProviderConfig(
    api_secret=os.environ["PORTONE_API_SECRET"],
    store_id=os.environ["PORTONE_STORE_ID"],
    webhook_secret=os.environ["PORTONE_WEBHOOK_SECRET"],
))

checkout = await provider.create_checkout(CreateCheckoutInput(
    customer_ref="cust_123", plan=plan, price=price, mode="subscription",
    success_url="https://app.example.com/success", cancel_url="https://app.example.com/cancel",
    idempotency_key="checkout-1",
))
```

`PortoneProvider` is passed as the `provider` dependency to `boilpayment-lifecycle`,
`boilpayment-refund`, `boilpayment-usage`, and `boilpayment-webhook`.
