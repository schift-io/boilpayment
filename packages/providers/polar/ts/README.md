# @schift/payment-kit-polar

Polar implementation of `@schift/payment-kit-core`'s `PaymentProvider` interface: checkout,
native subscriptions, refunds, Standard Webhooks verification, and normalizers from Polar's REST
API responses to the kit's `Payment`/`Subscription`/`Refund` types.

## Install

```
npm install @schift/payment-kit-polar @schift/payment-kit-core
```

## Usage

```ts
import { PolarProvider } from '@schift/payment-kit-polar';

const provider = new PolarProvider({
  accessToken: process.env.POLAR_ACCESS_TOKEN!,
  webhookSecret: process.env.POLAR_WEBHOOK_SECRET!,
  server: 'sandbox',
});

const checkout = await provider.createCheckout({
  customerRef: 'cust_123', plan, price, mode: 'subscription',
  successUrl: 'https://app.example.com/success', cancelUrl: 'https://app.example.com/cancel',
  idempotencyKey: 'checkout-1',
});
```

`PolarProvider` is passed as the `provider` dependency to `@schift/payment-kit-lifecycle`,
`@schift/payment-kit-refund`, `@schift/payment-kit-usage`, and `@schift/payment-kit-webhook`.
