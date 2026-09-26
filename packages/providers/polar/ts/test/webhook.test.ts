// Phase 6 regression tests — Standard Webhooks signature verification.
// Signing helper mirrors ts/examples/smoke.ts signStandardWebhook exactly.
import { createHmac } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { PolarProvider, verifyStandardWebhookSignature } from '../src/index.js';
import { WebhookSignatureError } from 'boilpayment-core';

const WEBHOOK_SECRET = 'whsec_c2VjcmV0a2V5Zm9ycG9sYXJ0ZXN0';

function signStandardWebhook(id: string, timestamp: string, body: string, secret: string): string {
  const secretRaw = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  const key = Buffer.from(secretRaw, 'base64');
  const signedContent = `${id}.${timestamp}.${body}`;
  const sig = createHmac('sha256', key).update(signedContent).digest('base64');
  return `v1,${sig}`;
}

// 5-minute Standard Webhooks tolerance was added to verifyStandardWebhookSignature (2026-09-09,
// mirroring PortoneProvider) — signature-validity tests below use a fresh timestamp so they keep
// testing HMAC matching, not staleness (which has its own dedicated test further down).
function freshTimestamp(): string {
  return String(Math.floor(Date.now() / 1000));
}

const ORDER_PAID_BODY = JSON.stringify({
  type: 'order.paid',
  timestamp: '2024-01-01T00:00:00.000Z',
  data: {
    id: 'order_test_1',
    customer_id: 'cust_test_1',
    subscription_id: 'sub_test_1',
    total_amount: 5000,
    currency: 'krw',
    status: 'paid',
    paid: true,
    created_at: '2024-01-01T00:00:00.000Z',
  },
});

describe('[EC:webhookSignature][EC:E4] verifyStandardWebhookSignature', () => {
  it('[EC:webhookSignature] valid signature passes without throwing', () => {
    const id = 'msg_test_1';
    const timestamp = freshTimestamp();
    const sig = signStandardWebhook(id, timestamp, ORDER_PAID_BODY, WEBHOOK_SECRET);
    expect(() =>
      verifyStandardWebhookSignature({
        headers: { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': sig },
        rawBody: ORDER_PAID_BODY,
        secret: WEBHOOK_SECRET,
      }),
    ).not.toThrow();
  });

  it('[EC:E4] tampered body -> WebhookSignatureError (signature no longer matches)', () => {
    const id = 'msg_test_1';
    const timestamp = freshTimestamp();
    const sig = signStandardWebhook(id, timestamp, ORDER_PAID_BODY, WEBHOOK_SECRET);
    const tamperedBody = ORDER_PAID_BODY.replace('5000', '999999');
    expect(() =>
      verifyStandardWebhookSignature({
        headers: { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': sig },
        rawBody: tamperedBody,
        secret: WEBHOOK_SECRET,
      }),
    ).toThrow(WebhookSignatureError);
  });

  it('[EC:E4] wrong secret -> WebhookSignatureError', () => {
    const id = 'msg_test_1';
    const timestamp = freshTimestamp();
    const sig = signStandardWebhook(id, timestamp, ORDER_PAID_BODY, WEBHOOK_SECRET);
    expect(() =>
      verifyStandardWebhookSignature({
        headers: { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': sig },
        rawBody: ORDER_PAID_BODY,
        secret: 'whsec_ZGlmZmVyZW50c2VjcmV0a2V5',
      }),
    ).toThrow(WebhookSignatureError);
  });

  it('[EC:E4] garbage signature -> WebhookSignatureError', () => {
    expect(() =>
      verifyStandardWebhookSignature({
        headers: { 'webhook-id': 'msg_test_1', 'webhook-timestamp': freshTimestamp(), 'webhook-signature': 'v1,deadbeef' },
        rawBody: ORDER_PAID_BODY,
        secret: WEBHOOK_SECRET,
      }),
    ).toThrow(WebhookSignatureError);
  });

  it('[EC:E4] missing webhook-id/webhook-timestamp/webhook-signature headers -> WebhookSignatureError', () => {
    expect(() => verifyStandardWebhookSignature({ headers: {}, rawBody: ORDER_PAID_BODY, secret: WEBHOOK_SECRET })).toThrow(WebhookSignatureError);
  });

  it('[EC:E4] header lookup accepts fully-uppercase header names (impl checks exact, lowercase, and uppercase variants only — not arbitrary/title casing)', () => {
    const id = 'msg_test_1';
    const timestamp = freshTimestamp();
    const sig = signStandardWebhook(id, timestamp, ORDER_PAID_BODY, WEBHOOK_SECRET);
    expect(() =>
      verifyStandardWebhookSignature({
        headers: { 'WEBHOOK-ID': id, 'WEBHOOK-TIMESTAMP': timestamp, 'WEBHOOK-SIGNATURE': sig },
        rawBody: ORDER_PAID_BODY,
        secret: WEBHOOK_SECRET,
      }),
    ).not.toThrow();
  });

  it('[EC:webhookSignature] multiple v1 candidates in signature header — matches if any candidate is valid', () => {
    const id = 'msg_test_1';
    const timestamp = freshTimestamp();
    const sig = signStandardWebhook(id, timestamp, ORDER_PAID_BODY, WEBHOOK_SECRET);
    expect(() =>
      verifyStandardWebhookSignature({
        headers: { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,bogus ${sig}` },
        rawBody: ORDER_PAID_BODY,
        secret: WEBHOOK_SECRET,
      }),
    ).not.toThrow();
  });

  it('[EC:webhookSignature] timestamp older than 5 minutes -> WebhookSignatureError even with a valid signature', () => {
    const id = 'msg_test_1';
    const timestamp = '1704067200'; // 2024-01-01 — far outside the 5-minute tolerance
    const sig = signStandardWebhook(id, timestamp, ORDER_PAID_BODY, WEBHOOK_SECRET);
    expect(() =>
      verifyStandardWebhookSignature({
        headers: { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': sig },
        rawBody: ORDER_PAID_BODY,
        secret: WEBHOOK_SECRET,
      }),
    ).toThrow(WebhookSignatureError);
  });

  it('[EC:webhookSignature] non-numeric timestamp -> WebhookSignatureError', () => {
    const id = 'msg_test_1';
    const sig = signStandardWebhook(id, 'not-a-number', ORDER_PAID_BODY, WEBHOOK_SECRET);
    expect(() =>
      verifyStandardWebhookSignature({
        headers: { 'webhook-id': id, 'webhook-timestamp': 'not-a-number', 'webhook-signature': sig },
        rawBody: ORDER_PAID_BODY,
        secret: WEBHOOK_SECRET,
      }),
    ).toThrow(WebhookSignatureError);
  });
});

describe('[EC:E4] PolarProvider.verifyWebhook — end-to-end through the class', () => {
  const provider = new PolarProvider({ accessToken: 'polar_at_dummy', webhookSecret: WEBHOOK_SECRET, server: 'sandbox' });

  it('[EC:E4] valid signature -> returns NormalizedEvent mapped from order.paid', async () => {
    const id = 'msg_test_1';
    const timestamp = freshTimestamp();
    const sig = signStandardWebhook(id, timestamp, ORDER_PAID_BODY, WEBHOOK_SECRET);
    const ev = await provider.verifyWebhook({
      headers: { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': sig },
      rawBody: ORDER_PAID_BODY,
    });
    expect(ev.type).toBe('payment.succeeded');
    expect(ev.paymentRef).toBe('order_test_1');
    expect(ev.provider).toBe('polar');
  });

  it('[EC:E4] tampered body -> WebhookSignatureError propagates through verifyWebhook', async () => {
    const id = 'msg_test_1';
    const timestamp = freshTimestamp();
    const sig = signStandardWebhook(id, timestamp, ORDER_PAID_BODY, WEBHOOK_SECRET);
    await expect(
      provider.verifyWebhook({
        headers: { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': sig },
        rawBody: ORDER_PAID_BODY.replace('5000', '1'),
      }),
    ).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  it('[EC:E4] valid signature but invalid JSON body -> WebhookSignatureError (not a generic parse error)', async () => {
    const rawBody = 'not json';
    const id = 'msg_test_2';
    const timestamp = freshTimestamp();
    const sig = signStandardWebhook(id, timestamp, rawBody, WEBHOOK_SECRET);
    await expect(
      provider.verifyWebhook({
        headers: { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': sig },
        rawBody,
      }),
    ).rejects.toBeInstanceOf(WebhookSignatureError);
  });
});

it('signed refund.updated deliveries keep separate delivery IDs and one refund reference', async () => {
  const provider = new PolarProvider({ accessToken: 'polar_at_dummy', webhookSecret: WEBHOOK_SECRET, server: 'sandbox' });
  const timestamp = freshTimestamp();
  const deliveries = [];
  for (const [id, status] of [['msg_pending', 'pending'], ['msg_succeeded', 'succeeded']]) {
    const rawBody = JSON.stringify({ type: 'refund.updated', timestamp: '2026-01-01T00:00:00Z', data: { id: 'refund_same', order_id: 'order_1', amount: 250, currency: 'usd', status } });
    const headers = { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': signStandardWebhook(id, timestamp, rawBody, WEBHOOK_SECRET) };
    const normalized = await provider.verifyWebhook({ headers, rawBody });
    expect((await provider.verifyWebhook({ headers, rawBody })).id).toBe(id);
    deliveries.push(normalized);
  }
  expect(deliveries.map((event) => event.id)).toEqual(['msg_pending', 'msg_succeeded']);
  expect(deliveries.map((event) => event.refundRef)).toEqual(['refund_same', 'refund_same']);
  expect(deliveries.map((event) => event.type)).toEqual(['refund.pending', 'refund.created']);
});
