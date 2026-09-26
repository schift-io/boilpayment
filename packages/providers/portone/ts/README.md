# @schift/payment-kit-portone

PortOne V2 implementation of `@schift/payment-kit-core`'s `PaymentProvider` interface: checkout,
billing-key issuance/charging, PortOne's own renewal scheduling (or self-scheduling), cash
receipts, Standard Webhooks verification, and normalizers to the kit's `Payment`/`Subscription`/
`Refund` types. Endpoints verified against PortOne's V2 OpenAPI spec.

## Install

```
npm install @schift/payment-kit-portone @schift/payment-kit-core
```

## Usage

```ts
import { PortoneProvider } from '@schift/payment-kit-portone';

const provider = new PortoneProvider({
  apiSecret: process.env.PORTONE_API_SECRET!,
  storeId: process.env.PORTONE_STORE_ID!,
  webhookSecret: process.env.PORTONE_WEBHOOK_SECRET!,
});

const checkout = await provider.createCheckout({
  customerRef: 'cust_123', plan, price, mode: 'subscription',
  successUrl: 'https://app.example.com/success', cancelUrl: 'https://app.example.com/cancel',
  idempotencyKey: 'checkout-1',
});
```

`PortoneProvider` is passed as the `provider` dependency to `@schift/payment-kit-lifecycle`,
`@schift/payment-kit-refund`, `@schift/payment-kit-usage`, and `@schift/payment-kit-webhook`.
