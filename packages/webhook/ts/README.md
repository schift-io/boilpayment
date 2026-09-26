# boilpayment-webhook

Provider-agnostic webhook pipeline: `receive` (verify signature, dedupe, persist), `process` /
`processPending` (dispatch to handlers with retry), `defaultHandlers` (wires lifecycle / credits /
refund / cs together), and a Node/Fetch HTTP adapter.

## Install

```
npm install boilpayment-webhook boilpayment-core
```

## Usage

```ts
import { receive, process, defaultHandlers, createNodeHandler } from 'boilpayment-webhook';

const handlers = defaultHandlers({ policy, ledger, repo, notifier, clock, ids });

// createNodeHandler only does the receive (verify + persist + 200/400) step — process the
// persisted event afterwards, e.g. from a queue worker or right after receive returns.
const handler = createNodeHandler({ provider: stripeProvider, repo, clock });
const result = await receive({ provider: stripeProvider, headers, rawBody, repo, clock });
if (result.status === 200 && result.eventId) {
  await process({ eventId: result.eventId, providers: { stripe: stripeProvider }, handlers, repo, clock });
}
```

Full module contract: [docs/ARCHITECTURE.md §3.5](https://github.com/schift-io/boilpayment/blob/main/docs/ARCHITECTURE.md).
