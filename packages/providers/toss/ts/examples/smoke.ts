// Smoke test — real code path through TossProvider, with a tiny in-file fetch stub
// standing in for api.tosspayments.com (no real PG calls, no live keys).
// Run: node_modules/.bin/tsx packages/providers/toss/ts/examples/smoke.ts
import { WebhookSignatureError } from '@schift/payment-kit-core';
import { TossProvider, normalizeTossPayment, normalizeTossFailure, mapTossWebhook } from '../src/index.js';

// ── Fixture JSON, copied from docs.tosspayments.com example responses ────────

// docs.tosspayments.com/reference/using-api/webhook-events example body:
const WEBHOOK_FIXTURE = {
  eventType: 'PAYMENT_STATUS_CHANGED',
  createdAt: '2022-05-12T00:00:00.000',
  data: { paymentKey: 'B3EvL1cKz9p-kO6XPNpfF', status: 'DONE', orderId: 'YOWWcpZSDCZ8WJC5x7mkl' },
};

// Representative Toss Payment object shape per docs.tosspayments.com/reference (GET /v1/payments/{paymentKey}).
const PAYMENT_FIXTURE_DONE = {
  paymentKey: 'B3EvL1cKz9p-kO6XPNpfF',
  orderId: 'YOWWcpZSDCZ8WJC5x7mkl',
  status: 'DONE',
  totalAmount: 15000,
  currency: 'KRW',
  method: '카드',
  approvedAt: '2022-05-12T00:00:05+09:00',
  requestedAt: '2022-05-12T00:00:00+09:00',
};

const PAYMENT_FIXTURE_ABORTED = {
  paymentKey: 'ABORTED_KEY',
  orderId: 'ord_aborted',
  status: 'ABORTED',
  totalAmount: 5000,
  currency: 'KRW',
  method: '카드',
  requestedAt: '2022-05-12T00:10:00+09:00',
  failure: { code: 'REJECT_CARD_COMPANY', message: '카드사에서 승인을 거절했습니다.' },
};

const PAYMENT_FIXTURE_VIRTUAL_ACCOUNT_CANCEL = {
  paymentKey: 'VA_KEY',
  orderId: 'ord_va',
  status: 'PARTIAL_CANCELED',
  totalAmount: 20000,
  currency: 'KRW',
  method: '가상계좌',
  approvedAt: '2022-05-12T00:00:00+09:00',
  cancels: [{ transactionKey: 'txn_1', cancelAmount: 5000, canceledAt: '2022-05-13T00:00:00+09:00' }],
};

// ── tiny fetch stub ───────────────────────────────────────────────────────────

function fakeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

let lastCall: { url: string; init?: RequestInit } | null = null;
const fetchStub: typeof fetch = async (url, init) => {
  lastCall = { url: String(url), init };
  const path = String(url).replace('https://api.tosspayments.com', '');
  if (path === '/v1/payments/confirm') return fakeResponse(PAYMENT_FIXTURE_DONE);
  if (path.startsWith('/v1/payments/VA_KEY') && init?.method === 'GET') return fakeResponse(PAYMENT_FIXTURE_VIRTUAL_ACCOUNT_CANCEL);
  if (path.startsWith('/v1/payments/VA_KEY/cancel')) return fakeResponse(PAYMENT_FIXTURE_VIRTUAL_ACCOUNT_CANCEL);
  throw new Error(`fakeFetch: unhandled path ${path}`);
};

async function main() {
  // ── (1) construct provider ──
  const provider = new TossProvider({ secretKey: 'test_sk_dummy', allowedWebhookIps: ['203.0.113.10'] }, fetchStub);
  console.log('capabilities:', JSON.stringify(provider.capabilities()));

  // ── confirmPayment exercises the fetch stub once ──
  const confirmed = await provider.confirmPayment({ paymentKey: PAYMENT_FIXTURE_DONE.paymentKey, orderId: PAYMENT_FIXTURE_DONE.orderId, amount: 15000 });
  console.log('confirmPayment ->', JSON.stringify({ id: confirmed.id, status: confirmed.status, amount: confirmed.amount }));

  // ── refund on a virtual-account payment without refundReceiveAccount must throw (EC:D13) ──
  try {
    await provider.refund({ paymentRef: 'VA_KEY', amount: { amountMinor: 5000, currency: 'KRW' }, reason: 'customer request', idempotencyKey: 'revoke:1' });
    console.log('UNEXPECTED: refund without refundReceiveAccount did not throw');
  } catch (e: any) {
    console.log('refund without refundReceiveAccount ->', e.code, e.message);
  }
  // ── refund with refundReceiveAccount succeeds and exercises the cancel path ──
  const refund = await provider.refund({
    paymentRef: 'VA_KEY',
    amount: { amountMinor: 5000, currency: 'KRW' },
    reason: 'customer request',
    idempotencyKey: 'revoke:2',
    extra: { refundReceiveAccount: { bank: '004', accountNumber: '123456789', holderName: '홍길동' } },
  });
  console.log('refund ->', JSON.stringify({ id: refund.id, amount: refund.amount, status: refund.status }));

  // ── (3) Toss verifyWebhook: allowed ip vs disallowed ip ──
  const rawBody = JSON.stringify(WEBHOOK_FIXTURE);
  const allowedEvent = await provider.verifyWebhook({ headers: { 'x-paykit-remote-ip': '203.0.113.10' }, rawBody });
  console.log('verifyWebhook (allowed ip) ->', JSON.stringify(allowedEvent));
  try {
    await provider.verifyWebhook({ headers: { 'x-paykit-remote-ip': '198.51.100.1' }, rawBody });
    console.log('UNEXPECTED: disallowed ip did not throw');
  } catch (e) {
    console.log('verifyWebhook (disallowed ip) -> threw', e instanceof WebhookSignatureError ? 'WebhookSignatureError' : e);
  }

  // ── (4) pure normalizers against fixture JSON ──
  console.log('normalizeTossPayment(DONE) ->', JSON.stringify(normalizeTossPayment(PAYMENT_FIXTURE_DONE)));
  console.log('normalizeTossPayment(ABORTED) ->', JSON.stringify(normalizeTossPayment(PAYMENT_FIXTURE_ABORTED)));
  console.log('normalizeTossFailure ->', JSON.stringify(normalizeTossFailure(PAYMENT_FIXTURE_ABORTED.failure)));
  console.log('mapTossWebhook ->', JSON.stringify(mapTossWebhook(WEBHOOK_FIXTURE)));

  console.log('last fetch call path:', lastCall?.url);
  console.log('OK');
}

main().catch((e) => {
  console.error('SMOKE FAILED:', e);
  process.exit(1);
});
