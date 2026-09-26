// EC:E16 end to end: a Stripe subscription the kit already knows renews on Stripe's side. The
// renewal arrives as a signed `invoice.paid` for an invoice we have never seen. Real StripeProvider
// against stripe-mock, real webhook receive/process, real lifecycle.onRenewalPaid, real ledger.
// Run: stripe-mock -http-port 12111 &  then  apps/cli/node_modules/.bin/tsx examples/e2e/native-renewal-stripe-mock.ts
import assert from 'node:assert/strict';
import Stripe from '../../packages/providers/stripe/ts/node_modules/stripe/esm/stripe.esm.node.js';
import { CollectingNotifier, DEFAULT_POLICY, FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen } from '../../packages/core/ts/dist/index.js';
import type { Plan, Subscription } from '../../packages/core/ts/dist/index.js';
import { StripeProvider } from '../../packages/providers/stripe/ts/dist/index.js';
import * as lifecycle from '../../packages/lifecycle/ts/dist/index.js';
import { defaultHandlers, process as processWebhook, receive } from '../../packages/webhook/ts/dist/index.js';

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
async function deliver(eventId: string) {
  const rawBody = JSON.stringify({ id: eventId, object: 'event', type: 'invoice.paid', created: Math.floor(clock.now().getTime() / 1000), data: { object: invoice }, api_version: '2025-03-31', livemode: false, pending_webhooks: 1, request: null });
  const sig = Stripe.webhooks.generateTestHeaderString({ payload: rawBody, secret: SECRET });
  const r = await receive({ provider, headers: { 'stripe-signature': sig }, rawBody, repo, clock });
  await processWebhook({ eventId: r.eventId!, providers: { stripe: provider }, handlers, repo, clock });
  return repo.webhookEvents.get(r.eventId!);
}

const first = await deliver('evt_renewal_1');
const again = await deliver('evt_renewal_1_redelivered');
const payments = await repo.payments.list({ providerRef: invoice.id } as never);
const grants = (await ledger.entries('cust_1', { kind: 'grant' })).filter((e) => e.reference.paymentId === payments[0]?.id);
const balance = await ledger.balance('cust_1', 'paid', clock.now());
const out = { first: [first?.status, first?.error], again: [again?.status, again?.error], paymentRows: payments.length, payment: payments.map((p) => ({ customerId: p.customerId, subscriptionId: p.subscriptionId, kind: p.kind, status: p.status })), grants: grants.map((g) => g.amount), balance: balance.available };
console.log(JSON.stringify(out));
assert.deepEqual(out.first, ['processed', null]);
assert.equal(out.paymentRows, 1, 'redelivery must not add a row');
assert.deepEqual(out.grants, [100]);
assert.equal(out.balance, 100);
console.log('NATIVE RENEWAL ROUND TRIP OK');
