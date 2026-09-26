# boilpayment-toss

Toss Payments implementation of `boilpayment-core`'s `PaymentProvider` interface. Toss
has no native subscriptions or webhook signing — this provider bills via billing keys, restricts
webhook delivery to an IP allowlist, and normalizes Toss's status/webhook shapes into the kit's
`Payment`/`Refund` types.

## Install

```
npm install boilpayment-toss boilpayment-core
```

## Usage

```ts
import { TossProvider } from 'boilpayment-toss';

const provider = new TossProvider({
  secretKey: process.env.TOSS_SECRET_KEY!,
  clientKey: process.env.TOSS_CLIENT_KEY,
});

const checkout = await provider.createCheckout({
  customerRef: 'cust_123', plan, price, mode: 'subscription',
  successUrl: 'https://app.example.com/success', cancelUrl: 'https://app.example.com/cancel',
  idempotencyKey: 'checkout-1',
});
```

`TossProvider` is passed as the `provider` dependency to `boilpayment-lifecycle`,
`boilpayment-refund`, `boilpayment-usage`, and `boilpayment-webhook`.
Toss self-schedules renewals — pair with `lifecycle.scheduler.tick`.
