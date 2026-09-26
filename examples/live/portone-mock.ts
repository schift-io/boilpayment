import { PaymentKitError, ProviderError, WebhookSignatureError } from '../../packages/core/ts/dist/index.js';
// Drives the real PortOne V2 SDK-free HTTP code paths of PortoneProvider against
// tools/mocks/portone/server.mjs (no keys, no network) — the same role
// examples/live/stripe-mock.ts plays for StripeProvider + stripe-mock.
// Run:  node tools/mocks/portone/server.mjs &   then
//       apps/cli/node_modules/.bin/tsx examples/live/portone-mock.ts
import { createServer } from 'node:http';
import { PortoneProvider } from '../../packages/providers/portone/ts/dist/index.js';
import {
  DEFAULT_POLICY, FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen,
} from '../../packages/core/ts/dist/index.js';
import type { Payment } from '../../packages/core/ts/dist/index.js';
import { defaultHandlers, process as processWebhook, receive } from '../../packages/webhook/ts/dist/index.js';
import { topup } from '../../packages/credits/ts/dist/index.js';

const MOCK_BASE = `http://127.0.0.1:${process.env.PORTONE_MOCK_PORT ?? 12212}`;
const API_SECRET = 'test_dummy_secret';
const STORE_ID = 'store_dummy';
const WEBHOOK_SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';

const out = (k: string, v: unknown) => console.log(`${k}: ${JSON.stringify(v)}`);

async function mockFetch(path: string, method: string, body?: unknown, auth = true): Promise<any> {
  const res = await fetch(MOCK_BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(auth ? {} : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`mock ${method} ${path} -> ${res.status}: ${JSON.stringify(json)}`), { status: res.status, body: json });
  return json;
}

const p = new PortoneProvider({ apiSecret: API_SECRET, storeId: STORE_ID, webhookSecret: WEBHOOK_SECRET, apiBase: MOCK_BASE });

async function main() {
  // ── confirmPayment: match + mismatch (EC:E13/E10) ──
  await mockFetch('/__mock/seed/payment', 'POST', {
    id: 'pay_confirm_1', status: 'PAID', amount: { total: 10000 }, currency: 'KRW', customer: { id: 'cus_1' },
    paidAt: '2026-09-01T00:00:05.000Z', requestedAt: '2026-09-01T00:00:00.000Z',
  });
  const confirmed = await p.confirmPayment('pay_confirm_1', { amountMinor: 10000, currency: 'KRW' });
  out('confirmPayment match', { status: confirmed.status, id: confirmed.id });
  try {
    await p.confirmPayment('pay_confirm_1', { amountMinor: 9999, currency: 'KRW' });
    throw new Error('Expected confirmPayment mismatch rejection');
  } catch (e) {
    if (!(e instanceof PaymentKitError) || !(e.code === 'amount_mismatch')) throw e;
    out('confirmPayment mismatch', (e as Error & { code?: string }).code);
  }

  // ── getPayment: PAID / VIRTUAL_ACCOUNT_ISSUED -> pending / FAILED with pgCode -> E9 ──
  await mockFetch('/__mock/seed/payment', 'POST', {
    id: 'pay_va_1', status: 'VIRTUAL_ACCOUNT_ISSUED', amount: { total: 30000 }, currency: 'KRW', customer: { id: 'cus_1' },
    requestedAt: '2026-09-01T00:00:00.000Z',
  });
  const vaPayment = await p.getPayment('pay_va_1');
  out('getPayment VIRTUAL_ACCOUNT_ISSUED', { status: vaPayment.status }); // must be 'pending', never 'succeeded'

  await mockFetch('/__mock/seed/payment', 'POST', {
    id: 'pay_failed_1', status: 'FAILED', amount: { total: 8000 }, currency: 'KRW', customer: { id: 'cus_1' },
    requestedAt: '2026-09-01T00:10:00.000Z', failedAt: '2026-09-01T00:10:05.000Z',
    failure: { pgCode: 'CARD_DECLINED', pgMessage: 'Insufficient card limit' },
  });
  const failedPayment = await p.getPayment('pay_failed_1');
  out('getPayment FAILED', { status: failedPayment.status, failure: failedPayment.failure });

  // ── issueBillingKey + chargeBillingKey (idempotent repeat) — EC:F ──
  const issued = await p.issueBillingKey({ customer: { id: 'cus_1' }, method: { card: { credential: {} } } });
  out('issueBillingKey', { billingKey: issued.billingKey });
  const orderId = 'order_charge_1';
  const charge1 = await p.chargeBillingKey({ billingKey: issued.billingKey, amount: { amountMinor: 9900, currency: 'KRW' }, orderId, customerRef: 'cus_1', idempotencyKey: 'charge:1' });
  out('chargeBillingKey first', { status: charge1.status, id: charge1.id });
  // EC:A34 — real PortOne answers ALREADY_PAID for a paid paymentId (never a second charge); the
  // adapter turns that into the paid payment, so a retried charge is idempotent.
  const charge2 = await p.chargeBillingKey({ billingKey: issued.billingKey, amount: { amountMinor: 9900, currency: 'KRW' }, orderId, customerRef: 'cus_1', idempotencyKey: 'charge:1-retry' });
  if (charge2.status !== 'succeeded' || charge2.providerRef !== charge1.providerRef) throw new Error('Expected the same paid payment on repeat');
  out('chargeBillingKey idempotent repeat', { status: charge2.status, id: charge2.id });

  // ── schedulePayment + cancelSchedules — EC:F, scheduling='provider' ──
  const scheduleResult: any = await p.schedulePayment({ billingKey: issued.billingKey, amount: { amountMinor: 9900, currency: 'KRW' }, orderId: 'order_sched_1', customerRef: 'cus_1', timeToPay: new Date('2026-10-01T00:00:00.000Z') });
  out('schedulePayment', scheduleResult);
  const cancelScheduleResult = await p.cancelSchedules({ billingKey: issued.billingKey });
  out('cancelSchedules', cancelScheduleResult);

  // ── refund partial (D4) + virtual-account refund without/with refundAccount (D13) ──
  const partial = await p.refund({ paymentRef: orderId, amount: { amountMinor: 4000, currency: 'KRW' }, reason: 'partial refund', idempotencyKey: 'revoke:1' });
  if (partial.status !== 'succeeded' || partial.amount.amountMinor !== 4000 || !partial.providerRef) throw new Error('Expected identified successful refund of 4000');
  out('refund partial', { status: partial.status, amount: partial.amount });

  await mockFetch('/__mock/seed/payment', 'POST', {
    id: 'pay_va_refund_1', status: 'PAID', amount: { total: 20000 }, currency: 'KRW', customer: { id: 'cus_1' },
    method: { type: 'VirtualAccount' }, requestedAt: '2026-09-01T00:00:00.000Z', paidAt: '2026-09-01T00:00:05.000Z',
  });
  try {
    await p.refund({ paymentRef: 'pay_va_refund_1', amount: { amountMinor: 20000, currency: 'KRW' }, reason: 'va refund no account', idempotencyKey: 'revoke:2' });
    throw new Error('Expected refund virtual-account without refundAccount rejection');
  } catch (e) {
    if (!(e instanceof ProviderError) || !(e.failure.providerCode === 'INVALID_REQUEST')) throw e;
    out('refund virtual-account without refundAccount', (e as Error & { failure?: unknown }).failure ?? (e as Error).message);
  }
  const vaRefund = await p.refund({
    paymentRef: 'pay_va_refund_1', amount: { amountMinor: 20000, currency: 'KRW' }, reason: 'va refund with account', idempotencyKey: 'revoke:3',
    extra: { refundAccount: { bank: '004', number: '110-123-456789', holderName: '홍길동' } },
  });
  if (vaRefund.status !== 'succeeded' || vaRefund.amount.amountMinor !== 20000 || !vaRefund.providerRef) throw new Error('Expected identified successful refund of 20000');
  out('refund virtual-account with refundAccount', { status: vaRefund.status, amount: vaRefund.amount });

  // ── listPayments with customer filter (no server-side customer filter exists — client-side match) ──
  await mockFetch('/__mock/seed/payment', 'POST', { id: 'pay_other_cust', status: 'PAID', amount: { total: 1000 }, currency: 'KRW', customer: { id: 'cus_OTHER' }, requestedAt: '2026-09-01T00:00:00.000Z' });
  const listed = await p.listPayments({ customerRef: 'cus_1', since: new Date('2026-01-01T00:00:00Z') });
  out('listPayments customer filter', { count: listed.length, allMatchCustomer: listed.every((pay) => pay.customerId === 'cus_1') });

  // ── verifyWebhook: valid / tampered body / stale timestamp — EC:E4 ──
  const signValid: any = await mockFetch('/__mock/sign', 'POST', { type: 'Transaction.Paid', data: { paymentId: orderId }, secret: WEBHOOK_SECRET });
  const validEvent = await p.verifyWebhook({ headers: signValid.headers, rawBody: signValid.body });
  out('verifyWebhook valid', { type: validEvent.type, paymentRef: validEvent.paymentRef });

  const signTamper: any = await mockFetch('/__mock/sign', 'POST', { type: 'Transaction.Paid', data: { paymentId: orderId }, secret: WEBHOOK_SECRET });
  const tamperedBody = signTamper.body.replace('"paymentId"', '"paymentId2"');
  try {
    await p.verifyWebhook({ headers: signTamper.headers, rawBody: tamperedBody });
    throw new Error('Expected verifyWebhook tampered rejection');
  } catch (e) {
    if (!(e instanceof WebhookSignatureError) || !(true)) throw e;
    out('verifyWebhook tampered', (e as Error).constructor.name);
  }

  const signStale: any = await mockFetch('/__mock/sign', 'POST', { type: 'Transaction.Paid', data: { paymentId: orderId }, secret: WEBHOOK_SECRET, staleSeconds: 600 });
  try {
    await p.verifyWebhook({ headers: signStale.headers, rawBody: signStale.body });
    throw new Error('Expected verifyWebhook stale rejection');
  } catch (e) {
    if (!(e instanceof WebhookSignatureError) || !(true)) throw e;
    out('verifyWebhook stale', (e as Error).constructor.name);
  }

  // ── provider-scheduled renewal round trip: mock pushes a real signed Transaction.Paid
  // webhook to a tiny local listener; webhook.receive/process (with defaultHandlers wired to
  // the real credits.topup) grants credits from it. PortOne's normalized webhook never
  // carries subscriptionRef (PortOne has no native subscription — see spec's "계약 변경
  // 제안"), so this always flows through the credits.topup one-time-payment path, not
  // lifecycle.onRenewalPaid; resolveTopupCredits below stands in for "the app resolves how
  // many credits this renewal charge buys" (EC:B10). ──
  const clock = new FixedClock(new Date('2026-09-01T00:00:00Z'));
  const repo = new InMemoryRepo();
  const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
  const ids = new SequentialIdGen('id_');

  const renewalPayment: Payment = {
    id: 'local_pay_1', customerId: 'cus_1', provider: 'portone', providerRef: orderId, subscriptionId: null,
    amount: { amountMinor: 9900, currency: 'KRW' }, status: 'pending', kind: 'subscription', period: null,
    occurredAt: clock.now(), failure: null, cashReceipt: null,
  };
  await repo.payments.put(renewalPayment);

  const listener = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
    res.writeHead(200).end('{}');
    listener.emit('captured', { headers, rawBody });
  });
  const captured = new Promise<{ headers: Record<string, string>; rawBody: string }>((resolve) => {
    listener.once('captured', resolve);
  });
  await new Promise<void>((resolve) => listener.listen(12213, '127.0.0.1', resolve));

  await mockFetch('/__mock/webhook', 'POST', { url: 'http://127.0.0.1:12213/webhook', secret: WEBHOOK_SECRET, type: 'Transaction.Paid', data: { paymentId: orderId } });
  const delivery = await captured;
  listener.close();

  const received = await receive({ provider: p, headers: delivery.headers, rawBody: delivery.rawBody, repo, clock });
  out('renewal webhook receive', { status: received.status, duplicated: received.duplicated });

  const handlers = defaultHandlers({
    policy: DEFAULT_POLICY, ledger, repo, notifier: { async send() {} }, clock, ids,
    credits: { topup },
    resolveTopupCredits: async () => 100,
  });
  await processWebhook({ eventId: received.eventId!, providers: { portone: p }, handlers, repo, clock });
  const record = await repo.webhookEvents.get(received.eventId!);
  const balance = await ledger.balance('cus_1', 'paid', clock.now());
  out('renewal processed', { recordStatus: record?.status, error: record?.error });
  out('credits balance after renewal', balance);

  console.log('\nPORTONE-MOCK ROUND TRIP OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
