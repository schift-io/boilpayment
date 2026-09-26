// Phase 6 regression tests — [EC:E4] verifyWebhook (Standard Webhooks / Svix-compatible scheme).
import { createHmac } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { WebhookSignatureError } from '@schift/payment-kit-core';
import { PortoneProvider } from '../src/index.js';

const WEBHOOK_SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';

function signStandardWebhook(secret: string, id: string, timestamp: string, body: string): string {
  const secretB64 = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  const key = Buffer.from(secretB64, 'base64');
  const signedContent = `${id}.${timestamp}.${body}`;
  const sig = createHmac('sha256', key).update(signedContent).digest('base64');
  return `v1,${sig}`;
}

function makeProvider(webhookSecret = WEBHOOK_SECRET) {
  const neverCalledFetch = (async () => {
    throw new Error('fetch should not be called by verifyWebhook');
  }) as typeof fetch;
  return new PortoneProvider({ apiSecret: 'test_sk_dummy', storeId: 'store_dummy', webhookSecret }, neverCalledFetch);
}

const BODY = JSON.stringify({
  type: 'Transaction.Paid',
  timestamp: '2024-04-25T10:00:00.000Z',
  data: { paymentId: 'example-payment-id' },
});

describe('[EC:E4] PortoneProvider.verifyWebhook', () => {
  it('[EC:E4] valid Standard Webhooks signature verifies and returns a NormalizedEvent with webhook-id as event.id', async () => {
    const provider = makeProvider();
    const id = 'msg_2aXpZoWFrKlmCfxbRSjBRXP2C6H';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signStandardWebhook(WEBHOOK_SECRET, id, timestamp, BODY);
    const event = await provider.verifyWebhook({ headers: { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': signature }, rawBody: BODY });
    expect(event.id).toBe(id);
    expect(event.type).toBe('payment.succeeded');
    expect(event.paymentRef).toBe('example-payment-id');
  });

  it('[EC:E4] tampered body -> WebhookSignatureError', async () => {
    const provider = makeProvider();
    const id = 'msg_tampered';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signStandardWebhook(WEBHOOK_SECRET, id, timestamp, BODY);
    const tampered = JSON.stringify({ type: 'Transaction.Paid', timestamp: '2024-04-25T10:00:00.000Z', data: { paymentId: 'attacker-controlled' } });
    await expect(provider.verifyWebhook({ headers: { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': signature }, rawBody: tampered })).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  it('[EC:E4] wrong secret -> WebhookSignatureError', async () => {
    const provider = makeProvider();
    const id = 'msg_wrong_secret';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signStandardWebhook('whsec_' + Buffer.from('a-totally-different-32-byte-key').toString('base64'), id, timestamp, BODY);
    await expect(provider.verifyWebhook({ headers: { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': signature }, rawBody: BODY })).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  it('[EC:E4] missing webhook-signature header -> WebhookSignatureError', async () => {
    const provider = makeProvider();
    const id = 'msg_missing_sig';
    const timestamp = String(Math.floor(Date.now() / 1000));
    await expect(provider.verifyWebhook({ headers: { 'webhook-id': id, 'webhook-timestamp': timestamp }, rawBody: BODY })).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  it('[EC:E4] missing webhook-id header -> WebhookSignatureError', async () => {
    const provider = makeProvider();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signStandardWebhook(WEBHOOK_SECRET, 'irrelevant', timestamp, BODY);
    await expect(provider.verifyWebhook({ headers: { 'webhook-timestamp': timestamp, 'webhook-signature': signature }, rawBody: BODY })).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  it('[EC:E4] stale timestamp beyond the 5-minute tolerance -> WebhookSignatureError', async () => {
    const provider = makeProvider();
    const id = 'msg_stale';
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 301);
    const signature = signStandardWebhook(WEBHOOK_SECRET, id, staleTimestamp, BODY);
    await expect(provider.verifyWebhook({ headers: { 'webhook-id': id, 'webhook-timestamp': staleTimestamp, 'webhook-signature': signature }, rawBody: BODY })).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  it('[EC:E4] timestamp within tolerance (299s old) still verifies', async () => {
    const provider = makeProvider();
    const id = 'msg_barely_fresh';
    const timestamp = String(Math.floor(Date.now() / 1000) - 299);
    const signature = signStandardWebhook(WEBHOOK_SECRET, id, timestamp, BODY);
    const event = await provider.verifyWebhook({ headers: { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': signature }, rawBody: BODY });
    expect(event.type).toBe('payment.succeeded');
  });

  it('[EC:E4] svix-* header aliases are accepted in place of webhook-* headers', async () => {
    const provider = makeProvider();
    const id = 'msg_svix_alias';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signStandardWebhook(WEBHOOK_SECRET, id, timestamp, BODY);
    const event = await provider.verifyWebhook({ headers: { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': signature }, rawBody: BODY });
    expect(event.id).toBe(id);
  });
});
