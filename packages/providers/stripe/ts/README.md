# boilpayment-stripe

Stripe implementation of `boilpayment-core`'s `PaymentProvider` interface: checkout
sessions, subscription changes with proration, refunds, webhook verification, and normalizers
from Stripe's API objects to the kit's `Payment`/`Subscription`/`Refund` types.

## Install

```
npm install boilpayment-stripe boilpayment-core
```

## Usage

```ts
import { StripeProvider } from 'boilpayment-stripe';

const provider = new StripeProvider({
  secretKey: process.env.STRIPE_SECRET_KEY!,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
});

const checkout = await provider.createCheckout({
  customerRef: 'cus_123', plan, price, mode: 'subscription',
  successUrl: 'https://app.example.com/success', cancelUrl: 'https://app.example.com/cancel',
  idempotencyKey: 'checkout-1',
});
```

`StripeProvider` is passed as the `provider` dependency to `boilpayment-lifecycle`,
`boilpayment-refund`, `boilpayment-usage`, and `boilpayment-webhook`.
