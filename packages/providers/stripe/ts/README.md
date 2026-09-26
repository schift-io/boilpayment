# @schift/payment-kit-stripe

Stripe implementation of `@schift/payment-kit-core`'s `PaymentProvider` interface: checkout
sessions, subscription changes with proration, refunds, webhook verification, and normalizers
from Stripe's API objects to the kit's `Payment`/`Subscription`/`Refund` types.

## Install

```
npm install @schift/payment-kit-stripe @schift/payment-kit-core
```

## Usage

```ts
import { StripeProvider } from '@schift/payment-kit-stripe';

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

`StripeProvider` is passed as the `provider` dependency to `@schift/payment-kit-lifecycle`,
`@schift/payment-kit-refund`, `@schift/payment-kit-usage`, and `@schift/payment-kit-webhook`.
