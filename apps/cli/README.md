# boilpayment

CLI wizard for [boilpayment](https://github.com/schift-io/boilpayment): answer a few
questions about your provider (Stripe/Toss/PortOne/Polar) and billing policy, and it generates
composed `boilpayment-sdk` modules, a Postgres migration set, a webhook handler, a
`POLICY.md` describing the decisions you made, and a `.env.example` — in TS or Python.

## Install

```
npx boilpayment init
```

or install it globally:

```
npm install -g boilpayment
boilpayment init
```

## Usage

```
boilpayment init [--yes] [--out <dir>] [--config [file]] \
            [--providers stripe,toss,portone,polar] \
            [--models subscription,topup,usage] \
            [--languages ts,py] [--goods credits,usage_quota] [--cs]
boilpayment check [--out <dir>]     # validate config + (optional) DB connectivity, read-only
boilpayment live [--out <dir>] [--config <file>] [--env <file>] [--dry-run]
boilpayment --help
```

`init` writes `paykit.config.json` plus generated code into `--out` (default: the current
directory); re-running with `--config` only asks the questions your existing config is missing.

`--yes` explicitly accepts the default rules. Refund requests, missing-grant recovery and
dispute handling are included by default; `--cs` only enables optional usage reporting.
Call `initialize()` to verify the schema and seed configured plans, then `checkout()` and
`registerCompletedCheckout()` to retain immutable purchase evidence. Native Stripe/Polar
price/product references must be configured before selling; `check` rejects incomplete drafts.
A hosted AI support service and customer chat widget are not generated.

Programmatic use (scripting the wizard instead of the binary):

```ts
import { runWizard, generateAll } from 'boilpayment';

const config = await runWizard({
  yes: true, existingRaw: null,
  overrides: { providers: ['stripe'] },
});
await generateAll(config, './my-app');
```

Full wizard contract: [docs/ARCHITECTURE.md §6](https://github.com/schift-io/boilpayment/blob/main/docs/ARCHITECTURE.md).
