// EC:E16 + EC:A25 end to end: a Stripe subscription the kit already knows renews on Stripe's side.
// The renewal arrives as a signed `invoice.paid` for an invoice we have never seen. Real
// StripeProvider against stripe-mock, real webhook receive/process/processPending, real
// lifecycle.onRenewalPaid, real ledger.
//
// stripe-mock's invoice fixture is a `draft`, which the kit reads as `pending`: EC:A25 refuses to
// grant for it and the webhook record fails. stripe-mock cannot move the invoice to paid, so the
// second phase wraps the same real provider and reports the fetched invoice as `succeeded`, the
// way Stripe does once the charge settles; the stored record's retry then grants once.
// Run: stripe-mock -http-port 12111 &  then  apps/cli/node_modules/.bin/tsx examples/e2e/native-renewal-stripe-mock.ts
import assert from 'node:assert/strict';
import Stripe from '../../packages/providers/stripe/ts/node_modules/stripe/esm/stripe.esm.node.js';
import { CollectingNotifier, DEFAULT_POLICY, FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen } from '../../packages/core/ts/dist/index.js';
import type { Plan, Subscription } from '../../packages/core/ts/dist/index.js';
import { StripeProvider } from '../../packages/providers/stripe/ts/dist/index.js';
import * as lifecycle from '../../packages/lifecycle/ts/dist/index.js';
import { defaultHandlers, process as processWebhook, processPending, receive } from '../../packages/webhook/ts/dist/index.js';

const SECRET = 'whsec_test';
const provider = new StripeProvider({ secretKey: 'sk_test_123', webhookSecret: SECRET, apiBase: { host: '127.0.0.1', port: Number(process.env.STRIPE_MOCK_PORT ?? 12111), protocol: 'http' } });

// What Stripe would send: the invoice as it exists on Stripe.
const remote = await provider.getPayment('in_123');
const invoice = remote.raw as Stripe.Invoice;
const stripeSubRef = remote.subscriptionId;
assert.ok(stripeSubRef, 'stripe-mock invoice fixture has a subscription');

const repo = new InMemoryRepo();
const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
const remoteSub = await provider.getSubscription(stripeSubRef!);
// stripe-mock's fixtures are static and not coherent in time (the invoice period is zero-length in
// 2024, the subscription period ends before it starts), so the clock sits just inside the invoice
// period the grant is tied to; the balance is read there.
const clock = new FixedClock(new Date(remote.period!.end.getTime() - 1_000));
const plan: Plan = { id: 'plan_pro', name: 'Pro', interval: 'month', creditsPerPeriod: 100, usageIncluded: 0, trialDays: 0, prices: [{ currency: invoice.currency.toUpperCase(), amountMinor: remote.amount.amountMinor, providerPriceRefs: { stripe: 'price_123' } }] };
await repo.plans.put(plan);
await repo.customers.put({ id: 'cust_1', email: 'a@b.c', providerRefs: [{ provider: 'stripe', ref: String(invoice.customer) }], status: 'active', createdAt: clock.now() });
// The subscription the kit created at checkout; its previous period ended where the renewal starts.
const sub: Subscription = { ...remoteSub, id: 'sub_local', customerId: 'cust_1', planId: plan.id, providerRef: stripeSubRef, version: 0 };
await repo.subscriptions.put(sub);

const handlers = defaultHandlers({ policy: DEFAULT_POLICY, ledger, repo, notifier: new CollectingNotifier(), clock, ids: new SequentialIdGen('pay_'), lifecycle });
async function deliver(eventId: string, via: StripeProvider = provider) {
  const rawBody = JSON.stringify({ id: eventId, object: 'event', type: 'invoice.paid', created: Math.floor(clock.now().getTime() / 1000), data: { object: invoice }, api_version: '2025-03-31', livemode: false, pending_webhooks: 1, request: null });
  const sig = Stripe.webhooks.generateTestHeaderString({ payload: rawBody, secret: SECRET });
  const r = await receive({ provider: via, headers: { 'stripe-signature': sig }, rawBody, repo, clock });
  await processWebhook({ eventId: r.eventId!, providers: { stripe: via }, handlers, repo, clock });
  return repo.webhookEvents.get(r.eventId!);
}

async function snapshot() {
  const payments = await repo.payments.list({ providerRef: invoice.id } as never);
  const grants = (await ledger.entries('cust_1', { kind: 'grant' })).filter((e) => e.reference.paymentId === payments[0]?.id);
  const balance = await ledger.balance('cust_1', 'paid', clock.now());
  return { paymentRows: payments.length, paymentStatus: payments.map((p) => p.status), grants: grants.map((g) => g.amount), balance: balance.available };
}

// Phase 1 — the draft invoice: recorded, not granted, the record fails for a later retry.
assert.equal(remote.status, 'pending', 'stripe-mock invoice fixture reads as pending');
const draft = await deliver('evt_renewal_1');
const afterDraft = await snapshot();
console.log(JSON.stringify({ phase: 'draft', record: [draft?.status, draft?.error], ...afterDraft }));
assert.equal(draft?.status, 'failed');
assert.match(String(draft?.error), /not succeeded/);
assert.deepEqual(afterDraft.grants, []);
assert.equal(afterDraft.balance, 0);

// Phase 2 — Stripe settles the charge: the same real provider now reports the invoice as paid.
// process() scopes the provider per delivery with withCorrelationId(), which returns a fresh
// clone, so the settled view is applied to every clone too.
function settled(p: StripeProvider): StripeProvider {
  const realGetPayment = p.getPayment.bind(p);
  const realScope = p.withCorrelationId.bind(p);
  return Object.assign(Object.create(p), {
    getPayment: async (ref: string) => ({ ...(await realGetPayment(ref)), status: 'succeeded' as const }),
    withCorrelationId: (id: string) => settled(realScope(id)),
  });
}
const paidProvider = settled(provider);
const retried = await processPending({ repo, providers: { stripe: paidProvider }, handlers, clock });
const redelivered = await deliver('evt_renewal_1_redelivered', paidProvider);
const out = { phase: 'paid', retried, redelivered: [redelivered?.status, redelivered?.error], ...(await snapshot()) };
console.log(JSON.stringify(out));
assert.deepEqual(retried, { processed: 1, failed: 0 });
assert.deepEqual(out.redelivered, ['processed', null]);
assert.equal(out.paymentRows, 1, 'retry and redelivery must not add a row');
assert.deepEqual(out.grants, [100], 'granted exactly once, after the payment succeeded');
assert.equal(out.balance, 100);
console.log('NATIVE RENEWAL ROUND TRIP OK');
