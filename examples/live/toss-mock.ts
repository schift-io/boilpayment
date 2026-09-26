import { PaymentKitError, ProviderError, WebhookSignatureError } from '../../packages/core/ts/dist/index.js';
// Drives the real Toss SDK-shaped HTTP code paths of TossProvider against
// tools/mocks/toss/server.mjs (no keys, no network).
// Run: node tools/mocks/toss/server.mjs &  then  apps/cli/node_modules/.bin/tsx examples/live/toss-mock.ts
import { createServer } from 'node:http';
import { TossProvider } from '../../packages/providers/toss/ts/dist/index.js';
import type { Plan } from '../../packages/core/ts/dist/index.js';
import { FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen, resolvePolicy } from '../../packages/core/ts/dist/index.js';
import type { Subscription } from '../../packages/core/ts/dist/index.js';
import { scheduler } from '../../packages/lifecycle/ts/dist/index.js';

const MOCK_BASE = `http://127.0.0.1:${process.env.TOSS_MOCK_PORT ?? 12211}`;

const out = (k: string, v: unknown) => console.log(`${k}: ${JSON.stringify(v)}`);

// mock-only helper endpoints (not part of TossProvider — see tools/mocks/toss/server.mjs)
async function mockAuthorize(body: Record<string, unknown>): Promise<{ paymentKey: string; orderId: string; amount: number }> {
  const res = await fetch(`${MOCK_BASE}/__mock/authorize`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

// Spins up a one-shot local HTTP receiver so a mock-triggered webhook delivery
// is a real HTTP POST (EC:E4 variant — exercises the wire path, not a hand-built object).
function receiveOneWebhook(): Promise<{ port: number; wait: Promise<{ headers: Record<string, string>; rawBody: string }> }> {
  return new Promise((resolveOuter) => {
    let resolveInner!: (v: { headers: Record<string, string>; rawBody: string }) => void;
    const wait = new Promise<{ headers: Record<string, string>; rawBody: string }>((r) => {
      resolveInner = r;
    });
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(',') : (v ?? '');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        server.close();
        resolveInner({ headers, rawBody: Buffer.concat(chunks).toString('utf8') });
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolveOuter({ port, wait });
    });
  });
}

async function triggerMockWebhook(body: Record<string, unknown>): Promise<void> {
  await fetch(`${MOCK_BASE}/__mock/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function main(): Promise<void> {
  const p = new TossProvider({
    secretKey: 'test_sk_mock_123',
    clientKey: 'test_ck_mock_123',
    allowedWebhookIps: ['203.0.113.5'],
    apiBase: MOCK_BASE,
  });

  const plan: Plan = {
    id: 'plan_krw',
    name: 'KRW Plan',
    interval: 'month',
    creditsPerPeriod: 500,
    usageIncluded: 0,
    trialDays: 0,
    prices: [{ currency: 'KRW', amountMinor: 5000 }],
  };

  const c = await p.createCustomer({ email: 'buyer@example.com' });
  out('createCustomer', c);

  const checkout = await p.createCheckout({
    customerRef: c.ref,
    plan,
    price: plan.prices[0],
    mode: 'subscription',
    successUrl: 'https://x/s',
    cancelUrl: 'https://x/c',
    idempotencyKey: 'checkout:1',
  });
  out('createCheckout', { id: checkout.id, hasUrl: !!checkout.url });

  // ── confirmPayment: amount match ────────────────────────────────────────
  const cardPaymentKey = 'pay_card_1';
  await mockAuthorize({ paymentKey: cardPaymentKey, orderId: checkout.providerRef, amount: 5000, method: '카드', customerKey: c.ref });
  const cardPay = await p.confirmPayment({ paymentKey: cardPaymentKey, orderId: checkout.providerRef!, amount: 5000 });
  out('confirmPayment', { status: cardPay.status, kind: cardPay.kind, amount: cardPay.amount });

  // ── confirmPayment: amount mismatch → error ─────────────────────────────
  await mockAuthorize({ paymentKey: 'pay_mismatch_1', orderId: 'ord_mismatch_1', amount: 3000, method: '카드', customerKey: c.ref });
  try {
    await p.confirmPayment({ paymentKey: 'pay_mismatch_1', orderId: 'ord_mismatch_1', amount: 9999 });
    throw new Error('Expected confirmPayment_mismatch rejection');
  } catch (e) {
    if (!(e instanceof ProviderError) || !(e.failure.providerCode === 'INVALID_REQUEST')) throw e;
    const err = e as Error & { code?: string; failure?: { code?: string; providerCode?: string } };
    out('confirmPayment_mismatch', { code: err.code, failureCode: err.failure?.code, providerCode: err.failure?.providerCode });
  }

  // ── confirmPayment / getPayment: virtual account → pending (EC:E8) ─────
  await mockAuthorize({ paymentKey: 'pay_va_1', orderId: 'ord_va_1', amount: 20000, method: '가상계좌', customerKey: c.ref });
  const vaPay = await p.confirmPayment({ paymentKey: 'pay_va_1', orderId: 'ord_va_1', amount: 20000 });
  out('confirmPayment_virtualAccount', { status: vaPay.status, kind: vaPay.kind });
  const vaGet = await p.getPayment('pay_va_1');
  out('getPayment_virtualAccount', { status: vaGet.status });
  const doneGet = await p.getPayment(cardPaymentKey);
  out('getPayment_done', { status: doneGet.status });

  // ── issueBillingKey + chargeBillingKey (idempotent repeat) ──────────────
  const billing = await p.issueBillingKey({ authKey: 'authkey_test_1', customerKey: c.ref });
  out('issueBillingKey', { billingKey: billing.billingKey, customerKey: billing.customerKey });
  const charge1 = await p.chargeBillingKey({ billingKey: billing.billingKey, amount: { amountMinor: 5000, currency: 'KRW' }, orderId: 'order_charge_1', customerRef: c.ref, idempotencyKey: 'charge:1' });
  const charge2 = await p.chargeBillingKey({ billingKey: billing.billingKey, amount: { amountMinor: 5000, currency: 'KRW' }, orderId: 'order_charge_1', customerRef: c.ref, idempotencyKey: 'charge:1' });
  out('chargeBillingKey', { status: charge1.status, idempotentReplaySameId: charge1.id === charge2.id });

  // ── refund: partial (EC:D4) ──────────────────────────────────────────────
  const refundPartial = await p.refund({ paymentRef: cardPay.id, amount: { amountMinor: 1000, currency: 'KRW' }, reason: 'requested_by_customer', idempotencyKey: 'refund:1' });
  if (refundPartial.status !== 'succeeded' || refundPartial.amount.amountMinor !== 1000 || !refundPartial.providerRef) throw new Error('Expected identified successful refund of 1000');
  out('refund_partial', { status: refundPartial.status, amount: refundPartial.amount });

  // ── refund: virtual account missing refundReceiveAccount (EC:D13) ──────
  try {
    await p.refund({ paymentRef: vaPay.id, amount: { amountMinor: 20000, currency: 'KRW' }, reason: 'requested_by_customer', idempotencyKey: 'refund:va:1' });
    throw new Error('Expected refund_va_missing_account rejection');
  } catch (e) {
    if (!(e instanceof PaymentKitError) || !(e.code === 'refund_receive_account_required')) throw e;
    out('refund_va_missing_account', (e as Error & { code?: string }).code);
  }
  const refundVa = await p.refund({
    paymentRef: vaPay.id,
    amount: { amountMinor: 20000, currency: 'KRW' },
    reason: 'requested_by_customer',
    idempotencyKey: 'refund:va:2',
    extra: { refundReceiveAccount: { bank: '신한', accountNumber: '110-1234-5678', holderName: 'Mock Customer' } },
  });
  if (refundVa.status !== 'succeeded' || refundVa.amount.amountMinor !== 20000 || !refundVa.providerRef) throw new Error('Expected identified successful refund of 20000');
  out('refund_va_with_account', { status: refundVa.status, amount: refundVa.amount });

  // ── listPayments (EC:H4, best-effort) ───────────────────────────────────
  const listed = await p.listPayments({ customerRef: c.ref, since: new Date(0) });
  out('listPayments', { count: listed.length });

  // ── verifyWebhook: allowed vs disallowed ip (EC:E4 variant) ─────────────
  const recv1 = await receiveOneWebhook();
  await triggerMockWebhook({ url: `http://127.0.0.1:${recv1.port}/hook`, paymentKey: cardPay.id, status: 'DONE' });
  const delivered1 = await recv1.wait;
  // EC:E18 — the allowlist reads the connection address the app passes, never a header.
  const ev1 = await p.verifyWebhook({ headers: delivered1.headers, rawBody: delivered1.rawBody, remoteAddress: '203.0.113.5' });
  out('verifyWebhook_allowed', { type: ev1.type, paymentRef: ev1.paymentRef });

  const recv2 = await receiveOneWebhook();
  await triggerMockWebhook({ url: `http://127.0.0.1:${recv2.port}/hook`, paymentKey: cardPay.id, status: 'DONE' });
  const delivered2 = await recv2.wait;
  try {
    await p.verifyWebhook({ headers: { ...delivered2.headers, 'x-paykit-remote-ip': '203.0.113.5' }, rawBody: delivered2.rawBody, remoteAddress: '10.0.0.1' });
    throw new Error('Expected verifyWebhook_disallowed rejection');
  } catch (e) {
    if (!(e instanceof WebhookSignatureError) || !(true)) throw e;
    out('verifyWebhook_disallowed', (e as Error & { code?: string }).code);
  }

  // ── self-scheduler round trip (EC:F) — real TossProvider, real HTTP charge ─
  const clock = new FixedClock(new Date('2024-01-01T00:00:00.000Z'));
  const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
  const repo = new InMemoryRepo();
  const ids = new SequentialIdGen('id_');
  const policy = resolvePolicy();

  const schedPlan: Plan = {
    id: 'plan_sched',
    name: 'Scheduled Plan',
    interval: 'month',
    creditsPerPeriod: 500,
    usageIncluded: 0,
    trialDays: 0,
    prices: [{ currency: 'KRW', amountMinor: 5000 }],
  };
  await repo.plans.put(schedPlan);

  const schedCustomerKey = 'cus_sched_1';
  const schedBilling = await p.issueBillingKey({ authKey: 'authkey_sched_1', customerKey: schedCustomerKey });

  const sub: Subscription = {
    id: 'sub_toss_sched_1',
    customerId: schedCustomerKey,
    planId: schedPlan.id,
    provider: 'toss',
    providerRef: '', // Toss has no native subscription object — see spec "계약 변경 제안"
    status: 'active',
    currentPeriod: { start: new Date('2023-12-01T00:00:00.000Z'), end: clock.now() },
    anchorDay: 1,
    cancelAtPeriodEnd: false,
    graceUntil: null,
    billingKey: schedBilling.billingKey,
    scheduledPlanId: null,
    createdAt: new Date('2023-12-01T00:00:00.000Z'), version: 0,
  };
  await repo.subscriptions.put(sub);

  const tickResult = await scheduler.tick({ provider: p, repo, policy, ledger, clock, ids });
  const balance = await ledger.balance(schedCustomerKey, undefined, clock.now());
  out('scheduler_tick', { chargedCount: tickResult.charged.length, failedCount: tickResult.failed.length, balance: balance.available });

  console.log('TOSS-MOCK ROUND TRIP OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
