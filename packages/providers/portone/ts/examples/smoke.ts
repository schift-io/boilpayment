// Smoke test — real code path through PortoneProvider, with a tiny in-file fetch stub
// standing in for api.portone.io (no real PG calls, no live keys).
// Run: node_modules/.bin/tsx packages/providers/portone/ts/examples/smoke.ts
import { createHmac } from 'node:crypto';
import { WebhookSignatureError } from '@schift/payment-kit-core';
import { PortoneProvider, normalizePortonePayment, normalizePortoneFailure, mapPortoneWebhook } from '../src/index.js';

const WEBHOOK_SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'; // dummy Standard Webhooks test secret (Svix format)

// ── Fixture JSON, shaped per developers.portone.io/api/rest-v2 example responses ──

const WEBHOOK_BODY_FIXTURE = {
  type: 'Transaction.Cancelled',
  timestamp: '2024-04-25T10:00:00.000Z',
  data: {
    paymentId: 'example-payment-id',
    storeId: 'store-ae356798-3d20-4969-b739-14c6b0e1a667',
    transactionId: '55451513-9763-4a7a-bb43-78a4c65be843',
    cancellationId: '0cdd91e9-4e7c-44a3-a72e-1a6511826c2b',
  },
};

const PAYMENT_FIXTURE_PAID = {
  id: 'example-payment-id',
  status: 'PAID',
  amount: { total: 15000, taxFree: 0, vat: 1364 },
  currency: 'KRW',
  customer: { id: 'cus_abc' },
  paidAt: '2026-09-01T00:00:05.000Z',
  requestedAt: '2026-09-01T00:00:00.000Z',
};

const PAYMENT_FIXTURE_FAILED = {
  id: 'example-payment-failed',
  status: 'FAILED',
  amount: { total: 8000 },
  currency: 'KRW',
  customer: { id: 'cus_abc' },
  requestedAt: '2026-09-01T00:10:00.000Z',
  failure: { pgCode: 'INSUFFICIENT_BALANCE', pgMessage: '잔액이 부족합니다.' },
};

// ── Standard Webhooks signer (mirrors what PortOne does server-side) ─────────

function signStandardWebhook(secret: string, id: string, timestamp: string, body: string): string {
  const secretB64 = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  const key = Buffer.from(secretB64, 'base64');
  const signedContent = `${id}.${timestamp}.${body}`;
  const sig = createHmac('sha256', key).update(signedContent).digest('base64');
  return `v1,${sig}`;
}

// ── tiny fetch stub ───────────────────────────────────────────────────────────

function fakeResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

let lastCall: string | null = null;
const fetchStub: typeof fetch = async (url) => {
  lastCall = String(url);
  const path = lastCall.replace('https://api.portone.io', '');
  if (path.startsWith('/payments/example-payment-id') && !path.includes('/cancel')) return fakeResponse(PAYMENT_FIXTURE_PAID);
  if (path.startsWith('/payments/example-payment-id/cancel')) {
    return fakeResponse({ cancellation: { id: 'cxl_1', totalAmount: 5000, cancelledAt: '2026-09-02T00:00:00.000Z' } });
  }
  throw new Error(`fakeFetch: unhandled path ${path}`);
};

async function main() {
  // ── (1) construct provider ──
  const provider = new PortoneProvider({ apiSecret: 'test_sk_dummy', storeId: 'store_dummy', webhookSecret: WEBHOOK_SECRET }, fetchStub);
  console.log('capabilities:', JSON.stringify(provider.capabilities()));

  // ── confirmPayment exercises the fetch stub once, verifies amount ──
  const confirmed = await provider.confirmPayment('example-payment-id', { amountMinor: 15000, currency: 'KRW' });
  console.log('confirmPayment ->', JSON.stringify({ id: confirmed.id, status: confirmed.status, amount: confirmed.amount }));
  try {
    await provider.confirmPayment('example-payment-id', { amountMinor: 999, currency: 'KRW' });
    console.log('UNEXPECTED: amount mismatch did not throw');
  } catch (e: any) {
    console.log('confirmPayment amount mismatch ->', e.code, e.message);
  }

  // ── refund exercises the cancel path ──
  const refund = await provider.refund({ paymentRef: 'example-payment-id', amount: { amountMinor: 5000, currency: 'KRW' }, reason: 'customer request', idempotencyKey: 'revoke:1' });
  console.log('refund ->', JSON.stringify({ id: refund.id, amount: refund.amount, status: refund.status }));

  // ── (2) sign a Standard Webhooks payload ourselves and verify ──
  const rawBody = JSON.stringify(WEBHOOK_BODY_FIXTURE);
  const id = 'msg_2aXpZoWFrKlmCfxbRSjBRXP2C6H';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signStandardWebhook(WEBHOOK_SECRET, id, timestamp, rawBody);
  const event = await provider.verifyWebhook({ headers: { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': signature }, rawBody });
  console.log('verifyWebhook (valid signature) ->', JSON.stringify(event));

  // ── tamper the body -> must throw WebhookSignatureError ──
  const tamperedBody = JSON.stringify({ ...WEBHOOK_BODY_FIXTURE, data: { ...WEBHOOK_BODY_FIXTURE.data, paymentId: 'attacker-controlled' } });
  try {
    await provider.verifyWebhook({ headers: { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': signature }, rawBody: tamperedBody });
    console.log('UNEXPECTED: tampered body did not throw');
  } catch (e) {
    console.log('verifyWebhook (tampered body) -> threw', e instanceof WebhookSignatureError ? 'WebhookSignatureError' : e);
  }

  // ── (4) pure normalizers against fixture JSON ──
  console.log('normalizePortonePayment(PAID) ->', JSON.stringify(normalizePortonePayment(PAYMENT_FIXTURE_PAID)));
  console.log('normalizePortonePayment(FAILED) ->', JSON.stringify(normalizePortonePayment(PAYMENT_FIXTURE_FAILED)));
  console.log('normalizePortoneFailure ->', JSON.stringify(normalizePortoneFailure(PAYMENT_FIXTURE_FAILED.failure)));
  console.log('mapPortoneWebhook ->', JSON.stringify(mapPortoneWebhook(WEBHOOK_BODY_FIXTURE)));

  console.log('last fetch call path:', lastCall);
  console.log('OK');
}

main().catch((e) => {
  console.error('SMOKE FAILED:', e);
  process.exit(1);
});
