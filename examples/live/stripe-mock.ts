import { PaymentKitError } from '../../packages/core/ts/dist/index.js';
import { rejects } from 'node:assert/strict';
// Drives the real Stripe SDK code paths of StripeProvider against stripe-mock (no keys, no network).
// Run: stripe-mock -http-port 12111 &  then  apps/cli/node_modules/.bin/tsx examples/live/stripe-mock.ts
import { StripeProvider } from '../../packages/providers/stripe/ts/dist/index.js';
import type { Plan } from '../../packages/core/ts/dist/index.js';

const p = new StripeProvider({ secretKey: 'sk_test_123', webhookSecret: 'whsec_test', apiBase: { host: '127.0.0.1', port: Number(process.env.STRIPE_MOCK_PORT ?? 12111), protocol: 'http' } });
const plan: Plan = { id: 'plan_a', name: 'A', interval: 'month', creditsPerPeriod: 100, usageIncluded: 0, trialDays: 0, prices: [{ currency: 'USD', amountMinor: 1000, providerPriceRefs: { stripe: 'price_123' } }] };
const out = (k: string, v: unknown) => console.log(`${k}: ${JSON.stringify(v)}`);

const c = await p.createCustomer({ email: 'a@b.c' }); out('createCustomer', c);
const ck = await p.createCheckout({ customerRef: c.ref, plan, price: plan.prices[0], mode: 'subscription', successUrl: 'https://x/s', cancelUrl: 'https://x/c', idempotencyKey: 'checkout:1' }); out('createCheckout', { id: ck.id, hasUrl: !!ck.url });
const pay = await p.getPayment('pi_123'); out('getPayment', { status: pay.status, kind: pay.kind, amount: pay.amount });
const inv = await p.getPayment('in_123'); out('getPayment_invoice', { status: inv.status, kind: inv.kind });
const sub = await p.getSubscription('sub_123'); out('getSubscription', { status: sub.status, anchorDay: sub.anchorDay, hasPeriod: !!sub.currentPeriod.start });
const ch = await p.changeSubscription('sub_123', { newPriceRef: 'price_456', proration: 'immediate', resetAnchor: true }); out('changeSubscription', { status: ch.status });
const cx = await p.cancelSubscription('sub_123', { atPeriodEnd: true }); out('cancelSubscription', { status: cx.status, cancelAtPeriodEnd: cx.cancelAtPeriodEnd });
const uc = await p.uncancelSubscription('sub_123'); out('uncancelSubscription', { status: uc.status, cancelAtPeriodEnd: uc.cancelAtPeriodEnd });
const rf = await p.refund({ paymentRef: 'pi_123', amount: { amountMinor: 500, currency: 'USD' }, reason: 'requested_by_customer', idempotencyKey: 'refund:1' }); out('refund', { status: rf.status, amount: rf.amount, providerRef: rf.providerRef });
await p.reportUsage({ meter: 'api_calls', customerRef: c.ref, quantity: 3, occurredAt: new Date(), idempotencyKey: 'u:1' }); out('reportUsage', 'ok');
const lp = await p.listPayments({ customerRef: c.ref, since: new Date(0) }); out('listPayments', { count: lp.length });
await rejects(() => p.chargeBillingKey(), (error: unknown) => error instanceof PaymentKitError && error.code === 'unsupported');
console.log('STRIPE-MOCK ROUND TRIP OK');
