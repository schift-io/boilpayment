# boilpayment

Part of [Schift](https://schift.io)'s boil series, alongside [boilauth](https://github.com/schift-io/boilauth).

Payment boilerplate that handles the part after "payment succeeded": failed payments, refunds,
missing grants, pending refunds and usage overage. A wizard asks how you want each edge case
handled, then generates TypeScript or Python code, Postgres migrations and a webhook handler that
run in **your** app against **your** database.

Providers: Stripe, Toss Payments, PortOne V2, Polar. Languages: TypeScript and Python (same
behaviour, checked by parity tests).

```bash
npx boilpayment init
```

## What you get

| Flow | What the kit does |
|---|---|
| Checkout | Saves the plan, price, credit amount and rules at the moment of sale before calling the provider. The same request returns the same checkout. |
| Payment registration | Checks the real provider payment against the checkout (owner, amount, currency) before recording the purchase. |
| Missing grant recovery | `cron.reconcile` finds paid purchases with no grant and grants what was sold, even if the plan changed since. Duplicate or late webhooks grant once. |
| Refunds | `support.requestRefund` looks up the payment, applies your refund rules, calls the provider and updates the ledger. Requests above your automatic limit open a case for a person. |
| Pending refunds | A refund the provider has not settled keeps its credits on hold. The webhook resolves it to succeeded or failed on the original refund record. |
| Unpaid recovery | Dunning, grace periods and retries follow the policy you picked in the wizard. |
| Overage settlement | `cron.closePeriods` charges usage above the included amount once per period, or reports it to the provider's native meter. Retries reuse the same billing key. |
| Case history | `cs.timeline` rebuilds "what happened to this payment" from payments, ledger, webhooks, refunds and cases. |

Every policy key, wizard question and module switch maps to an edge case ID in
[`docs/EDGE_CASES.md`](docs/EDGE_CASES.md).

## 5-minute start

Requires Node 20+, and Postgres for production storage.

```bash
mkdir my-app && cd my-app && npm init -y && npm pkg set type=module
npx boilpayment init              # interactive wizard
# or accept defaults:
npx boilpayment init --yes --providers stripe --languages ts,py
```

The wizard writes:

```
paykit.config.json      your answers (no secrets)
POLICY.md               the rules you chose, in plain language
INTEGRATION.md          wiring guide with the exact function names generated for you
.env.example            provider keys, DATABASE_URL, notification settings
paykit/index.ts|py      createPaymentKit / create_payment_kit
paykit/migrations/*.sql Postgres schema (versioned)
```

Then:

```bash
npm i boilpayment-sdk          # TypeScript: one package, modules by subpath
pip install boilpayment         # Python: one package, modules by submodule
cp .env.example .env                   # fill in sandbox keys
npx boilpayment migrate --dry-run && npx boilpayment migrate
npx boilpayment check                       # read-only: config + schema version
```

## Usage

TypeScript:

```ts
import config from './paykit.config.json' with { type: 'json' };
import { createPaymentKit } from './paykit/index.js';
import { SystemClock, UuidIdGen } from 'boilpayment-sdk/core';
import { createPool, PostgresRepo, PostgresLedgerStore } from 'boilpayment-sdk/postgres';

const pool = createPool(process.env.DATABASE_URL!);
const kit = createPaymentKit(config, {
  env: process.env as any, clock: new SystemClock(), ids: new UuidIdGen(),
  repo: new PostgresRepo(pool), ledger: new PostgresLedgerStore(pool),
});
await kit.initialize();                 // verifies schema, stores configured plans

// checkout needs the customer and their provider customer id in the repo
await kit.deps.repo.customers.put({ id: customerId, email, status: 'active', createdAt: new Date(),
  providerRefs: [{ provider: 'stripe', ref: stripeCustomerId }] });

const checkout = await kit.checkout({
  provider: 'stripe', customerId, planId, currency: 'USD',
  successUrl: 'https://your.app/billing/done', cancelUrl: 'https://your.app/billing',
  requestId: purchaseAttemptId,
});
// after the provider confirms payment, from a trusted server callback:
await kit.registerCompletedCheckout({ customerId, checkoutId: checkout.id, paymentRef });

// webhook: any HTTP server. Pass the RAW body string (not parsed JSON) and the request headers;
// with several providers pass { provider }, for Toss also { remoteAddress } (the socket's IP).
const { status } = await kit.handleWebhook(rawBody, headers);   // answer with HTTP `status`, no body

// refund by rule, recover a missing grant
await kit.support.requestRefund({ customerId, paymentId, requestId });
await kit.support.recoverMissingGrant({ customerId, paymentId });
```

Python:

```python
from boilpayment.core import Deps, SystemClock, UuidIdGen
from boilpayment.postgres import PostgresRepo, PostgresLedgerStore
from paykit.index import create_payment_kit

db = os.environ["DATABASE_URL"]
deps = Deps(clock=SystemClock(), ids=UuidIdGen(), repo=PostgresRepo(db), ledger=PostgresLedgerStore(db),
            notifier=None, providers={}, policy=None)
kit = create_payment_kit(config, deps, env=dict(os.environ))
await kit["initialize"]()
checkout = await kit["checkout"](customer_id=cid, plan_id=plan_id, provider="stripe", currency="USD",
                                 request_id=attempt_id, success_url=ok_url, cancel_url=back_url)
await kit["register_completed_checkout"](customer_id=cid, checkout_id=checkout.id, payment_ref=ref)
result = await kit["handle_webhook"](raw_body, headers)  # raw body str + headers dict; answer with result.status
await kit["support"]["request_refund"](customer_id=cid, payment_id=pid, request_id=req_id)
```

Schedule the crons listed in your generated `INTEGRATION.md` (`dunningSweep`, `expireDue`,
`flushOutbox`, `reconcile`, `closePeriods`).

## Packages

| npm / PyPI | |
|---|---|
| `boilpayment` / — | Wizard CLI (`boilpayment init`, `migrate`, `check`, `live`) |
| `boilpayment-sdk` / `boilpayment` | Single-install facade that re-exports every module below |
| `-core` | Types, `Policy`, interfaces, in-memory ledger and repo |
| `-credits` | Grant, consume, rollover, clawback, expire |
| `-lifecycle` | Upgrade, downgrade, cancel, trial, dunning, self-scheduler |
| `-refund` | Refund evaluation, execution, credit recovery |
| `-usage` | Record, check, period close, overage settlement |
| `-webhook` | Receive, store, process, dispatch |
| `-notify` | SMTP, Resend, Slack |
| `-cs` | Cases, reconcile, regrant, refund assist, disputes, timeline, evidence export |
| `-schema-postgres` | Postgres ledger and repo, migrations, retention |
| `-stripe` / `-toss` / `-portone` / `-polar` | Provider adapters |

The module packages (`-core` … `-polar`) are published separately on npm as `boilpayment-<module>`.
On PyPI everything ships in the one `boilpayment` distribution (same import names:
`boilpayment.core`, `boilpayment_core`, …), built by `scripts/build-pypi-bundle.sh`.

Each package has `spec/*.pseudo.md` (the contract), `ts/` and `py/`.
Architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Develop

```bash
pnpm install && uv sync
pnpm run build
pnpm run test && bash scripts/ci-pytest.sh
bash scripts/parity.sh                  # TS and Python produce the same results
pnpm run test:step1                     # generate a project and run it end to end
pnpm run test:step1:postgres            # same, against a throwaway local Postgres database
bash scripts/live.sh                    # provider adapters over HTTP against local mocks
```

Generated-project scenarios and their assertions: [`docs/STEP1_E2E.md`](docs/STEP1_E2E.md).
Provider verification status: [`docs/PUBLIC_SANDBOX_VERIFICATION.md`](docs/PUBLIC_SANDBOX_VERIFICATION.md).

## Managed support on top

The kit's schema is versioned so hosted services can attach to it. Schift is building a managed
refund and support service on that schema: it takes customer requests, runs them through the same
rules and kit functions, and reports the result back to the customer. Your ledger and payment
execution stay in your app. More at
[schift.io/features/boilpayment](https://schift.io/features/boilpayment).

## License

[MIT](LICENSE)
