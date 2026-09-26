# @schift/payment-kit-notify

`Notifier` implementations (`Notifier.send(notification)`) for dunning/expiry/case emails and
alerts: SMTP (via nodemailer), Slack incoming webhooks, and Resend, plus `composite` to fan out
to several at once and `withOutbox` to buffer sends for at-least-once delivery.

## Install

```
npm install @schift/payment-kit-notify @schift/payment-kit-core
```

## Usage

```ts
import { smtp, composite, slack } from '@schift/payment-kit-notify';

const notifier = composite([
  smtp({ host: 'smtp.example.com', port: 587, auth: { user, pass }, from: 'billing@acme.com', to: 'ops@acme.com' }),
  slack({ webhookUrl: process.env.SLACK_WEBHOOK_URL! }),
]);

// Passed into lifecycle.dunning.* / credits.notifyExpiring as the `notifier` dependency:
await notifier.send({ type: 'dunning.grace_started', customerId: 'cust_1', payload: {} });
```

Full module contract: [docs/ARCHITECTURE.md §3.5](https://github.com/schift-io/payment-kit/blob/main/docs/ARCHITECTURE.md).
