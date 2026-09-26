// Drives the real Polar REST code paths of PolarProvider against tools/mocks/polar/server.mjs
// (no keys, no network to polar.sh). Then does a renewal round trip through the real
// webhook/lifecycle/credits packages so an order.paid webhook the mock produces actually grants
// credits in the core in-memory ledger.
//
// Run:
//   POLAR_MOCK_PORT=12213 node tools/mocks/polar/server.mjs &
//   apps/cli/node_modules/.bin/tsx examples/live/polar-mock.ts
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import {
  CollectingNotifier, DEFAULT_POLICY, InMemoryLedger, InMemoryRepo, Payment, Plan,
  SequentialIdGen, Subscription, SystemClock, WebhookSignatureError, PaymentKitError,
} from '../../packages/core/ts/dist/index.js';
import { PolarProvider } from '../../packages/providers/polar/ts/dist/index.js';
import { defaultHandlers, process as processWebhook, receive } from '../../packages/webhook/ts/dist/index.js';
import type { LifecycleDeps } from '../../packages/webhook/ts/dist/index.js';
import { dunning, onRenewalPaid } from '../../packages/lifecycle/ts/dist/index.js';

const MOCK_PORT = Number(process.env.POLAR_MOCK_PORT || 12213);
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
const WEBHOOK_SECRET = 'whsec_cG9sYXJtb2NrdGVzdHNlY3JldGtleQ=='; // arbitrary valid base64 payload

const out = (k: string, v: unknown) => console.log(`${k}: ${JSON.stringify(v)}`);

function signStandardWebhook(id: string, timestamp: string, body: string, secret: string): string {
  const secretRaw = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  const key = Buffer.from(secretRaw, 'base64');
  const sig = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return `v1,${sig}`;
}

async function main() {
  const p = new PolarProvider({ accessToken: 'polar_oat_test_x', webhookSecret: WEBHOOK_SECRET, apiBase: MOCK_BASE });

  out('capabilities', p.capabilities());

  // ── customer + subscription checkout (prod_sub_basic) ──────────────────────
  const custA = await p.createCustomer({ email: 'a@example.com' }); out('createCustomer A', custA);
  const ckA = await p.createCheckout({
    customerRef: custA.ref,
    plan: { id: 'plan_basic', name: 'Basic', interval: 'month', creditsPerPeriod: 1000, usageIncluded: 0, trialDays: 0, prices: [] } as unknown as Plan,
    price: { currency: 'USD', amountMinor: 2900, providerPriceRefs: { polar: 'prod_sub_basic' } } as any,
    mode: 'subscription',
    successUrl: 'https://x/success',
    cancelUrl: 'https://x/cancel',
    idempotencyKey: 'checkout:a:1',
  });
  out('createCheckout subscription', { id: ckA.id, hasUrl: !!ckA.url });

  const paymentsA = await p.listPayments({ customerRef: custA.ref, since: new Date(0) });
  const orderA = paymentsA.find((pay) => pay.subscriptionId);
  if (!orderA || !orderA.subscriptionId) throw new Error('mock did not synthesize a subscription order for checkout A');
  out('listPayments A -> subscription order', { paymentRef: orderA.providerRef, subscriptionRef: orderA.subscriptionId, kind: orderA.kind, status: orderA.status });

  const payA = await p.getPayment(orderA.providerRef); out('getPayment A', { status: payA.status, kind: payA.kind, amount: payA.amount });

  const subA1 = await p.getSubscription(orderA.subscriptionId); out('getSubscription A', { status: subA1.status, anchorDay: subA1.anchorDay, periodStart: subA1.currentPeriod.start });

  // EC:A1 — resetAnchor has no Polar equivalent and must be silently ignored (see spec "계약 메모")
  const chA = await p.changeSubscription(orderA.subscriptionId, { newPriceRef: 'prod_sub_pro', proration: 'immediate', resetAnchor: true });
  out('changeSubscription (immediate, resetAnchor:true)', { status: chA.status, periodStart: chA.currentPeriod.start });
  if (chA.currentPeriod.start.getTime() !== subA1.currentPeriod.start.getTime()) {
    throw new Error('ASSERTION FAILED: resetAnchor=true must be ignored — currentPeriod.start changed');
  }
  out('assert resetAnchor ignored', 'OK — currentPeriod.start unchanged');

  const cxA1 = await p.cancelSubscription(orderA.subscriptionId, { atPeriodEnd: true });
  out('cancelSubscription atPeriodEnd=true', { status: cxA1.status, cancelAtPeriodEnd: cxA1.cancelAtPeriodEnd });

  const cxA2 = await p.cancelSubscription(orderA.subscriptionId, { atPeriodEnd: false });
  out('cancelSubscription atPeriodEnd=false (immediate)', { status: cxA2.status });

  // ── one-time checkout (prod_onetime_pack) — refund test ────────────────────
  const custB = await p.createCustomer({ email: 'b@example.com' }); out('createCustomer B', custB);
  const ckB = await p.createCheckout({
    customerRef: custB.ref,
    plan: { id: 'plan_topup', name: 'Topup', interval: 'month', creditsPerPeriod: 0, usageIncluded: 0, trialDays: 0, prices: [] } as unknown as Plan,
    price: { currency: 'USD', amountMinor: 999, providerPriceRefs: { polar: 'prod_onetime_pack' } } as any,
    mode: 'one_time',
    successUrl: 'https://x/success',
    cancelUrl: 'https://x/cancel',
    idempotencyKey: 'checkout:b:1',
  });
  out('createCheckout one_time', { id: ckB.id, hasUrl: !!ckB.url });

  const paymentsB = await p.listPayments({ customerRef: custB.ref, since: new Date(0) });
  const orderB = paymentsB[0];
  out('listPayments B -> topup order', { paymentRef: orderB.providerRef, kind: orderB.kind, status: orderB.status, amount: orderB.amount });
  if (orderB.kind !== 'topup') throw new Error('ASSERTION FAILED: one_time order should normalize to kind=topup');

  const caps = p.capabilities();
  const refundAmount = caps.partialRefund ? Math.floor(orderB.amount.amountMinor / 2) : orderB.amount.amountMinor;
  const rf = await p.refund({ paymentRef: orderB.providerRef, amount: { amountMinor: refundAmount, currency: orderB.amount.currency }, reason: 'requested_by_customer', idempotencyKey: 'refund:b:1' });
  if (rf.status !== 'succeeded' || rf.amount.amountMinor !== refundAmount || !rf.providerRef) throw new Error('Expected identified successful refund of refundAmount');
  out('refund (partial per capabilities)', { status: rf.status, amount: rf.amount, providerRef: rf.providerRef });

  // ── reportUsage — idempotent by identifier (EC:C4) ──────────────────────────
  const usageKey = 'usage:b:1';
  await p.reportUsage({ meter: 'api_calls', customerRef: custB.ref, quantity: 3, occurredAt: new Date(), idempotencyKey: usageKey });
  out('reportUsage (first)', 'ok');
  // raw verification call (not through the typed provider — reportUsage() returns void) to prove
  // the mock's events.ingest dedupes by external_id, matching spec's "C4: externalId 로 ... 중복 수집 방지"
  const dedupRes = await fetch(`${MOCK_BASE}/v1/events/ingest`, {
    method: 'POST',
    headers: { Authorization: 'Bearer polar_oat_test_x', 'Content-Type': 'application/json' },
    body: JSON.stringify({ events: [{ name: 'api_calls', customer_id: custB.ref, timestamp: new Date().toISOString(), external_id: usageKey, metadata: { value: 3 } }] }),
  }).then((r) => r.json());
  out('reportUsage dedup check (raw, same external_id)', dedupRes);
  if (dedupRes.duplicates !== 1) throw new Error('ASSERTION FAILED: repeated external_id must be reported as a duplicate');

  // ── unsupported chargeBillingKey (native subscriptions provider) ───────────
  try {
    await p.chargeBillingKey();
    throw new Error('Expected unsupported billing-key rejection');
  } catch (e) {
    if (!(e instanceof PaymentKitError) || e.code !== 'unsupported') throw e;
    out('chargeBillingKey', (e as Error & { code?: string }).code);
  }

  // ── verifyWebhook: valid / tampered / stale timestamp (EC:E4, EC:webhookSignature) ──
  const body = JSON.stringify({ type: 'order.paid', timestamp: new Date().toISOString(), data: { id: 'order_verify_test', customer_id: custB.ref, total_amount: 1000, currency: 'usd', status: 'paid', paid: true, created_at: new Date().toISOString() } });
  {
    const id = 'msg_verify_1';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sig = signStandardWebhook(id, timestamp, body, WEBHOOK_SECRET);
    const ev = await p.verifyWebhook({ headers: { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': sig }, rawBody: body });
    out('verifyWebhook valid', { type: ev.type, paymentRef: ev.paymentRef });
  }
  {
    const id = 'msg_verify_2';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sig = signStandardWebhook(id, timestamp, body, WEBHOOK_SECRET);
    try {
      await p.verifyWebhook({ headers: { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': sig }, rawBody: body.replace('1000', '999999') });
      throw new Error('ASSERTION FAILED: tampered body must fail verification');
    } catch (e) {
      if (!(e instanceof WebhookSignatureError)) throw e;
      out('verifyWebhook tampered', e instanceof WebhookSignatureError ? 'rejected: WebhookSignatureError' : `unexpected: ${e}`);
    }
  }
  {
    const id = 'msg_verify_3';
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 3600); // 1h old
    const sig = signStandardWebhook(id, staleTimestamp, body, WEBHOOK_SECRET);
    try {
      await p.verifyWebhook({ headers: { 'webhook-id': id, 'webhook-timestamp': staleTimestamp, 'webhook-signature': sig }, rawBody: body });
      throw new Error('ASSERTION FAILED: stale timestamp must fail verification');
    } catch (e) {
      if (!(e instanceof WebhookSignatureError)) throw e;
      out('verifyWebhook stale timestamp', e instanceof WebhookSignatureError ? 'rejected: WebhookSignatureError' : `unexpected: ${e}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Renewal round trip: mock-produced order.paid webhook -> real webhook.receive/
  // process -> real lifecycle.onRenewalPaid -> real credits grant -> ledger balance.
  // ══════════════════════════════════════════════════════════════════════════
  const clock = new SystemClock();
  const repo = new InMemoryRepo();
  const ledger = new InMemoryLedger();
  const ids = new SequentialIdGen('id_');
  const notifier = new CollectingNotifier();
  const policy = DEFAULT_POLICY;

  const custC = await p.createCustomer({ email: 'c@example.com' }); out('createCustomer C (renewal)', custC);
  const ckC = await p.createCheckout({
    customerRef: custC.ref,
    plan: { id: 'plan_basic', name: 'Basic', interval: 'month', creditsPerPeriod: 1000, usageIncluded: 0, trialDays: 0, prices: [] } as unknown as Plan,
    price: { currency: 'USD', amountMinor: 2900, providerPriceRefs: { polar: 'prod_sub_basic' } } as any,
    mode: 'subscription',
    successUrl: 'https://x/success',
    cancelUrl: 'https://x/cancel',
    idempotencyKey: 'checkout:c:1',
  });
  out('createCheckout C (renewal)', { id: ckC.id });

  const paymentsC = await p.listPayments({ customerRef: custC.ref, since: new Date(0) });
  const orderC = paymentsC.find((pay) => pay.subscriptionId)!;
  const subC = await p.getSubscription(orderC.subscriptionId!);
  out('checkoutC synthesized', { orderRef: orderC.providerRef, subscriptionRef: orderC.subscriptionId, periodStart: subC.currentPeriod.start, periodEnd: subC.currentPeriod.end });

  const plan: Plan = { id: 'plan_basic', name: 'Basic', interval: 'month', creditsPerPeriod: 1000, usageIncluded: 0, trialDays: 0, prices: [{ currency: 'USD', amountMinor: 2900, providerPriceRefs: { polar: 'prod_sub_basic' } }] };
  await repo.plans.put(plan);

  const localCustomerId = 'cust_local_c';
  const localSub: Subscription = {
    id: 'sub_local_c', customerId: localCustomerId, planId: plan.id, provider: 'polar', providerRef: orderC.subscriptionId!,
    status: 'active', currentPeriod: subC.currentPeriod, anchorDay: subC.anchorDay, cancelAtPeriodEnd: false,
    graceUntil: null, billingKey: null, scheduledPlanId: null, createdAt: clock.now(), version: 0,
  };
  await repo.subscriptions.put(localSub);
  const localPayment: Payment = {
    id: 'pay_local_c', customerId: localCustomerId, provider: 'polar', providerRef: orderC.providerRef, subscriptionId: localSub.id,
    amount: orderC.amount, status: 'pending', kind: 'subscription', period: subC.currentPeriod, occurredAt: clock.now(), failure: null, cashReceipt: null,
  };
  await repo.payments.put(localPayment);

  // tiny listener to catch the mock's webhook delivery
  const captured = await new Promise<{ headers: Record<string, string>; rawBody: string }>((resolve, reject) => {
    const srv = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
        srv.close();
        resolve({ headers, rawBody: Buffer.concat(chunks).toString('utf8') });
      });
    });
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', async () => {
      const addr = srv.address();
      const listenerUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/webhook`;
      const deliverRes = await fetch(`${MOCK_BASE}/__mock/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: listenerUrl, secret: WEBHOOK_SECRET, type: 'order.paid', id: orderC.providerRef }),
      }).then((r) => r.json());
      out('__mock/webhook trigger', deliverRes);
    });
  });
  out('webhook received by local listener', { headerKeys: Object.keys(captured.headers).filter((k) => k.startsWith('webhook-')) });

  const receiveResult = await receive({ provider: p, headers: captured.headers, rawBody: captured.rawBody, repo, clock });
  out('webhook.receive', receiveResult);

  const lifecycle: LifecycleDeps = {
    onRenewalPaid: (input) => onRenewalPaid(input),
    dunning: { onPaymentFailed: (input) => dunning.onPaymentFailed(input) },
  };
  const handlers = defaultHandlers({ policy, ledger, repo, notifier, clock, ids, lifecycle });
  await processWebhook({ eventId: receiveResult.eventId!, providers: { polar: p }, handlers, repo, clock });

  const record = await repo.webhookEvents.get(receiveResult.eventId!);
  out('webhook.process record', { status: record?.status, error: record?.error });
  if (record?.status !== 'processed') throw new Error(`ASSERTION FAILED: webhook record should be 'processed', got ${record?.status} (${record?.error})`);

  const balance = await ledger.balance(localCustomerId, undefined, clock.now());
  out('ledger balance after order.paid webhook', { available: balance.available });
  if (balance.available !== plan.creditsPerPeriod) {
    throw new Error(`ASSERTION FAILED: expected balance.available=${plan.creditsPerPeriod}, got ${balance.available}`);
  }
  out('assert credits granted from mock-produced webhook', 'OK');

  console.log('POLAR-MOCK ROUND TRIP OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
