# boilpayment guide

`npx boilpayment init` asks how you sell (subscription, one-time top-up, usage), which providers you
use (Stripe, Polar, Toss, PortOne) and your refund/dunning/credit rules. It writes into your
project:

| File | What it is |
|---|---|
| `paykit/index.ts` or `paykit/index.py` | `createPaymentKit(config, deps)`: your app calls the functions on the kit it returns |
| `paykit/migrations/*.sql` | The Postgres schema (`npx boilpayment migrate` applies it) |
| `paykit.config.json` | Your answers. Edit it, then run `npx boilpayment check` |
| `POLICY.md` | Your rules written out as sentences |
| `INTEGRATION.md` | The integration steps for the providers you picked |
| `.env.example` | The secrets each provider needs |

The kit owns money state: payments, the credit ledger, subscriptions, refunds, usage and support
cases, all in your Postgres. Your app owns users, login and UI. You pass the logged-in customer id
into every call; never take it from a request body.

TypeScript names are camelCase on an object (`kit.registerCompletedCheckout`). Python names are
snake_case keys on a dict (`kit["register_completed_checkout"]`) with keyword arguments.

## 1. Create the kit

TypeScript: the generated code is ESM, so your `package.json` needs `"type": "module"` (or run it
through a bundler that handles ESM).

```ts
import { SystemClock, UuidIdGen } from 'boilpayment-sdk/core';
import { createPool, createPostgresRepo, PostgresLedgerStore } from 'boilpayment-sdk/postgres';
import { createPaymentKit } from './paykit/index.js';
import config from './paykit.config.json' with { type: 'json' };

const pool = createPool(process.env.DATABASE_URL!);
const kit = createPaymentKit(config, {
  repo: createPostgresRepo(pool), ledger: new PostgresLedgerStore(pool),
  clock: new SystemClock(), ids: new UuidIdGen(), env: process.env,
});
await kit.initialize();   // fails if the database is behind this build; stores the configured plans
```

Python:

```python
import os
from boilpayment.core import Deps, SystemClock, UuidIdGen
from boilpayment.postgres import PostgresRepo, PostgresLedgerStore
from paykit.index import create_payment_kit

repo, ledger = PostgresRepo(os.environ["DATABASE_URL"]), PostgresLedgerStore(os.environ["DATABASE_URL"])
kit = create_payment_kit(config, Deps(repo=repo, ledger=ledger, clock=SystemClock(), ids=UuidIdGen(),
                                      notifier=None, logger=None, providers={}, policy=None), dict(os.environ))
await kit["initialize"]()
```

The Python kit does not hand back `deps`; keep your own `repo` and `ledger`.

### Link provider price IDs (Stripe, Polar)

Stripe and Polar charge a price or product that exists in their dashboard. The kit reads its ID from
the plan's row in your database, per plan and currency. Link it once, after the first
`initialize()` has stored your plans:

```sql
update plan_prices set provider_price_refs = '{"stripe": "price_1Q..."}'   -- or {"polar": "<product id>"}
 where plan_id = 'pro' and currency = 'USD';
```

`initialize()` keeps these IDs on every later boot. Toss and PortOne charge the amount in the plan
directly and need nothing here. Without an ID, `checkout` fails with `missing_provider_price_ref`.

Customers live in the kit's repo. Create the row when your user signs up, with the provider's
customer id:

```ts
await kit.deps.repo.customers.put({ id: userId, email, status: 'active', createdAt: new Date(),
  providerRefs: [{ provider: 'stripe', ref: stripeCustomerId }] });
```

## 2. One payment, end to end

```
checkout ──► provider payment page ──► registerCompletedCheckout ──► webhook ──► credits granted
                                                                          │
                                  consume / record usage ◄────────────────┘
                                             │
                          refund / cancel / downgrade (credits revoked by your rules)
```

1. **`checkout`** stores the price and what the purchase grants *at this moment*, then returns
   `{ id, url, providerRef }`. Send the user to `url` (Stripe, Polar) or open the provider's widget
   with `providerRef` (Toss, PortOne). Keep `id` with the purchase attempt.
2. **`registerCompletedCheckout`**, from a trusted server callback after the provider confirms,
   checks the real payment against the checkout (owner, amount, currency) and records it. It does
   not grant anything. `paymentRef` is the provider's id for the payment:

   | Provider | `paymentRef` | Where you get it |
   |---|---|---|
   | Stripe, one-time | PaymentIntent id (`pi_...`) | the Checkout Session's `payment_intent` after it completes |
   | Stripe, subscription | first Invoice id (`in_...`) | the Checkout Session's `invoice`; also pass `subscriptionRef` (`sub_...`) |
   | Polar | Order id | the order created by the checkout (`order.paid` webhook or the Orders API) |
   | Toss | `paymentKey` | the widget's success callback; call `kit.deps.providers.toss.confirmPayment` first |
   | PortOne | the checkout's `providerRef` | you pass it to the PortOne browser SDK as `paymentId` |

3. **`handleWebhook`** grants. Credits are granted when the provider's webhook for that payment
   arrives, using the terms stored at checkout, even if you changed the plan since. A duplicate or
   late webhook grants nothing more. If the webhook never arrives, `cron.reconcile` or
   `support.recoverMissingGrant` grants from the same stored terms.
4. Your app spends with **`consume`** (credits) or **`record`** + **`checkQuota`** (usage).
5. Refunds, cancellation and downgrades revoke credits according to your policy.

Toss and PortOne subscriptions are charged by the kit itself (`startSubscription`, then
`cron.schedulerTick`). Stripe and Polar subscriptions are charged by the provider and arrive as
webhooks.

### Discounts (Stripe and Polar)

Let the customer enter a provider-managed code, or preset one code when you create the checkout.
Use only one mode at a time. Stripe maps these fields to `allow_promotion_codes` or
`discounts: [{ promotion_code }]`; Polar maps them to `allow_discount_codes` or `discount_id`.

```ts
const checkout = await kit.checkout({
  customerId: userId, planId: 'pro', provider: 'stripe', currency: 'USD',
  requestId: crypto.randomUUID(), successUrl, cancelUrl,
  allowDiscountCodes: true,
  // presetDiscountCode: 'promo_...', // use instead of allowDiscountCodes
});
await kit.registerCompletedCheckout({
  customerId: userId, checkoutId: checkout.id, paymentRef: paymentIntentId,
});
```

```python
checkout = await kit["checkout"](
    customer_id=user_id, plan_id="pro", provider="polar", currency="USD",
    request_id=request_id, success_url=success_url, cancel_url=cancel_url,
    allow_discount_codes=True,
    # preset_discount_code="discount_...",  # use instead of allow_discount_codes
)
await kit["register_completed_checkout"](
    customer_id=user_id, checkout_id=checkout.id, payment_ref=order_id,
)
```

Registration accepts a lower payment only when the provider proves all three facts: its subtotal
equals the captured sale price, a provider discount is present, and `subtotal - discount` equals
the amount paid. Otherwise it throws `checkout_evidence_mismatch`. The payment records the amount
actually paid, while the grant keeps the plan quantity. Subscription renewals resolve the plan by
the provider price reference, so discounted renewals and the first full-price renewal after a
repeating discount all grant that same quantity.

Refunds also use the amount actually paid. Used credits are valued at `paid / granted` with the
same exact-integer calculation as an undiscounted refund, and the result never exceeds the paid
amount. An exhausted code is refused by Stripe or Polar before payment; the kit writes no payment
or grant for that refused checkout.

### Payment links (Stripe and Polar)

Create the link in the provider dashboard, then add the existing kit customer before showing it.
The optional affiliate travels in the same encoded reference.

```ts
const url = kit.buildPaymentLinkUrl({
  provider: 'stripe',
  linkUrl: 'https://buy.stripe.com/example',
  customerId: userId,
  affiliateId: 'partner-42', // optional
});
```

```python
url = kit["build_payment_link_url"](
    provider="polar",
    link_url="https://buy.polar.sh/polar_cl_example",
    customer_id=user_id,
    affiliate_id="partner-42",  # optional
)
```

Stripe receives `client_reference_id`; Polar receives `reference_id`. The helper preserves other
query parameters and emits a kit-encoded value that matches Stripe's
`[A-Za-z0-9_-]{1,200}` limit. Empty or oversized references throw `PaymentKitError` instead of
producing a URL that Stripe would silently strip.

On `checkout.session.completed` with `payment_link` (Stripe), or `order.paid` whose metadata has
`reference_id` (Polar), `handleWebhook` decodes the reference, finds the existing customer, resolves
the plan from the provider price reference and grants once under the current plan terms. This works
for one-time and subscription plans. A missing, invalid or unknown-customer reference records the
payment, grants nothing and opens one `needs_human` case. Webhook replays do not duplicate the
payment, case or grant.

### Affiliate tracking

Neither provider has native affiliate accounting. Pass `affiliateId` / `affiliate_id` to
`checkout`, or to the payment-link helper above. The kit stores it on the payment and appends one
commission accrual after the payment grants. Configure either a rate or a fixed minor-unit amount:

```json
{
  "affiliate": {
    "commission": { "type": "rate", "rate": 0.15 },
    "renewals": "first_only"
  }
}
```

`affiliate.commission` may instead be `{ "type": "fixed", "amountMinor": 500 }`.
`affiliate.renewals` is `first_only` (the default) or `include`. With `include`, renewals of a
subscription that started with an affiliate also accrue commission. A dependency function overrides
the configured commission and returns the commission in minor units:

```ts
const kit = createPaymentKit(config, {
  repo, ledger, clock, ids, env: process.env,
  affiliateCommission: (payment) => Math.min(500, payment.amount.amountMinor),
});

const rows = await kit.affiliate.list({ affiliateId: 'partner-42' });
const usdMinor = await kit.affiliate.sum({ affiliateId: 'partner-42', currency: 'USD' });
const totalsByCurrency = await kit.affiliate.sum({ affiliateId: 'partner-42' });
```

```python
deps = Deps(
    repo=repo, ledger=ledger, clock=SystemClock(), ids=UuidIdGen(),
    notifier=None, logger=None, providers={}, policy=None,
    affiliate_commission=lambda payment: min(500, payment.amount.amount_minor),
)
kit = create_payment_kit(config, deps, dict(os.environ))

rows = await kit["affiliate"]["list"](affiliate_id="partner-42")
usd_minor = await kit["affiliate"]["sum"](
    affiliate_id="partner-42", currency="USD"
)
totals_by_currency = await kit["affiliate"]["sum"](
    affiliate_id="partner-42"
)
```

Commission rows are append-only and idempotent per payment. A refund appends a reversal equal to
`accrual * refunded / paid`, rounded toward the affiliate receiving less; it never edits the
accrual. `affiliate.list` accepts the affiliate id and optional payment id and kind (`accrual` or
`reversal`). `affiliate.sum` returns one minor-unit integer when a currency is supplied, otherwise
a currency-to-minor-unit map. Payouts are outside the kit's scope.

### Payment webhook before checkout registration

If a success webhook arrives before `registerCompletedCheckout`, the kit records the payment but
holds the grant. Registering later releases exactly one grant from the checkout snapshot captured at
sale time. Repeating either operation does not grant twice.

```ts
await kit.handleWebhook(rawBody, headers, { provider: 'stripe' });
await kit.registerCompletedCheckout({
  customerId: userId, checkoutId, paymentRef: paymentIntentId,
});
await kit.cron.reconcile(new Date(Date.now() - 24 * 60 * 60 * 1000));
```

```python
from datetime import datetime, timedelta, timezone

await kit["handle_webhook"](raw_body, headers, provider="polar")
await kit["register_completed_checkout"](
    customer_id=user_id, checkout_id=checkout_id, payment_ref=order_id,
)
await kit["cron"]["reconcile"](
    datetime.now(timezone.utc) - timedelta(hours=24)
)
```

Set `checkout.registrationHoldHours` in `paykit.config.json` to control how long reconciliation
waits; the default is `24`:

```json
{ "checkout": { "registrationHoldHours": 24 } }
```

If registration still has not happened after that window,
`cron.reconcile(since)` opens one `needs_human` case and does not grant. The `since` argument still
defines the reconciliation scan's lower time bound.

## 3. Reference

Every call is idempotent on the key shown: calling it again with the same key returns the first
result and changes nothing. Errors are `PaymentKitError` with a `code`.

### Buying

| Call | Input | Returns |
|---|---|---|
| `checkout` | `customerId, planId, provider, currency, requestId, successUrl, cancelUrl, allowDiscountCodes?, presetDiscountCode?, affiliateId?` | `{ id, url, providerRef }`. Key: `customerId + requestId` |
| `registerCompletedCheckout` | `customerId, checkoutId, paymentRef, subscriptionRef?` | the recorded `Payment`. Key: `checkoutId` |
| `buildPaymentLinkUrl` | `provider, linkUrl, customerId, affiliateId?` | a Stripe or Polar link carrying the encoded customer and optional affiliate |
| `startSubscription` (Toss, PortOne) | `customerId, planId, currency, billingKey, requestId, customerRef?, provider?` | `{ sub, payment }`. Charges the first period, then activates. Key: `requestId` |
| `handleWebhook` | `rawBody` (string, unparsed), `headers`, `{ provider?, remoteAddress? }` | `{ status, eventId, duplicated }`. Answer the provider with HTTP `status` and no body |

`handleWebhook` needs `provider` when more than one is configured. Toss webhooks carry no
signature, so the kit accepts them only from Toss's published addresses: pass the socket's address
as `remoteAddress`, never a header value.

Errors: `customer_frozen` / `customer_banned` (the customer has an open or lost dispute),
`checkout_evidence_missing` (no checkout with that id), `use_start_subscription` (a Toss/PortOne
subscription plan sent through checkout).

### Spending

| Call | Input | Returns |
|---|---|---|
| `consume` | `customerId, amount, idempotencyKey, reference?, reason?` | `{ ok, entries, duplicated }`. Throws `insufficient_balance` when the balance is short; nothing is taken |
| `record` | `event: { customerId, meter, quantity, occurredAt, idempotencyKey, meta? }, sub` | `{ event, duplicated }` |
| `checkQuota` | `customerId, meter, quantity, sub, includedQuantity?, idempotencyKey?` | `{ allow, overage, remaining, reason, notify }` |

`consume` refuses a customer who is frozen or banned, and a subscription that is `paused` or
`incomplete`. With `dunning.usageDuringGrace: 'block'` it also refuses while a renewal is unpaid.
Credits are taken in the order your policy sets (`credits.consumeOrder`).

### Changing a subscription

Load the subscription and the target plan from the repo, then:

```ts
const sub = await kit.deps.repo.subscriptions.get(subscriptionId);
const newPlan = await kit.deps.repo.plans.get('pro');
await kit.upgrade({ sub, newPlan });
```

| Call | Input | Returns |
|---|---|---|
| `upgrade` | `sub, newPlan, idempotencyKey?` | `{ sub, grant, creditDelta }`. Prorated now or at the next period, per policy |
| `downgrade` | `sub, newPlan, idempotencyKey?` | `{ sub, clawback }`. The credit surplus is revoked now or kept, per policy |
| `cancel` | `sub, churnReason?, churnText?` | `{ sub, churn, revoked }`. Now or at period end, per policy |
| `reactivate` | `sub` | `{ sub }`. Undoes an end-of-period cancel while the period is still running |

Default keys are the subscription, the target plan and the current period, so a double click does
one change. `upgrade` throws `upgrade_payment_pending` while an earlier upgrade's payment is unpaid.

### Refunds and support

| Call | Input | Returns |
|---|---|---|
| `support.requestRefund` | `customerId, paymentId, requestId?, requestedAmount?` | a support case. Your rules decide the amount; `requestedAmount` can lower it, never raise it |
| `support.recoverMissingGrant` | `customerId, paymentId` | a support case. Grants what the stored purchase terms say, once |
| `refund` | `payment, sub?, requestedAmount?` | `{ decision, execute(provider) }`. The lower-level form: inspect `decision`, then call `execute` |
| `resolveHeldAttempt` | `paymentId, decision: 'settle' \| 'void' \| 'close', actor, note?` | `{ payment, sub }`. For a renewal charge the kit could not confirm |
| `resumeParked` | `subscriptionId, actor` | the subscription. For one parked after too many missed periods |

The amount follows your refund rules in `POLICY.md`. With the defaults, a refund within 7 days is
the full price minus the value of credits already spent (a 9,900 KRW purchase of 1,000 credits with
10 spent refunds 9,801 and revokes the remaining 990).

A request outside your rules does not fail: it leaves a case in `rejected` or `needs_human`, and
`needs_human` sends a `cs.needs_human` notification. Refunds made in the provider's dashboard
arrive as webhooks and revoke credits the same way.

`boilpayment-sdk/cs` has the tools for a person handling a case: `timeline` + `explain` (what
happened to a payment, in order), `regrant`, `dispute`, `exportCustomer`.

### Cron

Nothing fails when these are missing; the work just never happens.

| Call (Python key) | Every | Only when | Without it |
|---|---|---|---|
| `cron.schedulerTick()` (`scheduler_tick`) | 5–15 min | Toss/PortOne subscriptions | Renewals are never charged |
| `cron.dunningSweep()` (`dunning_sweep`) | 1 h | subscriptions | Grace periods never end |
| `cron.closePeriods()` (`close_periods`) | 1 day | usage | Closed usage periods are never billed or rechecked |
| `cron.expireDue()` (`expire_due`) | 1 day | credits | Expiry is never written to the ledger (balances already ignore expired credits) |
| `cron.flushOutbox()` (`flush_outbox`) | 5 min | always | Usage reports and notifications queue up |
| `cron.reconcile(since)` (`reconcile`) | 1 day | credits | A payment whose webhook was lost is never granted |

`INTEGRATION.md` in your project lists only the ones your configuration needs.

## 4. Notifications

The kit sends `payment.failed`, `grace.started`, `grace.ending`, `credits.expiring`,
`refund.created`, `reconcile.mismatch` and `cs.needs_human` through the adapters you picked (SMTP,
Resend, Slack), or through `deps.notifier` if you pass your own `{ send(notification) }`.
`checkQuota` returns `notify: 'usage.soft_cap'` instead of sending it; send it yourself if you want it.

## 5. What the kit does not do

- Accounts, login, your pricing page or the payment UI.
- Apple and Google in-app purchases.

## 6. Upgrading

Keep the CLI and the SDK at the same version. After upgrading, run `npx boilpayment migrate` and
`npx boilpayment check` before serving traffic; `kit.initialize()` refuses to start against an
older schema. Upgrading to 0.3.0 requires migrations `0015_grace_credit_expiry.sql` and
`0016_affiliate_commissions.sql`. There is no upgrade path from 0.1.0.
