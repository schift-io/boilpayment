# schift-payment-kit-notify

`Notifier` implementations (an object with an async `send(notification)`) for dunning/expiry/case
emails and alerts: SMTP, Slack incoming webhooks, and Resend, plus `composite` to fan out to
several at once and `with_outbox` to buffer sends for at-least-once delivery.

## Install

```
pip install schift-payment-kit-notify
```

## Usage

```python
from schift_payment_kit_notify import smtp, composite, slack
from schift_payment_kit_core import Notification

notifier = composite([
    smtp(host="smtp.example.com", port=587, user=user, password=pw, from_="billing@acme.com", to="ops@acme.com"),
    slack(webhook_url=os.environ["SLACK_WEBHOOK_URL"]),
])

# Passed into lifecycle.dunning.* / credits.notify_expiring as the `notifier` dependency:
await notifier.send(Notification(type="dunning.grace_started", customer_id="cust_1", payload={}))
```

Full module contract: [docs/ARCHITECTURE.md §3.5](https://github.com/schift-io/payment-kit/blob/main/docs/ARCHITECTURE.md).
