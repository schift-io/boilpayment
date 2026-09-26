// [EC:E17] process() re-verifies the stored body long after receipt. Freshness (Standard Webhooks
// 5-minute tolerance) is judged at the receipt time passed as receivedAt; the HMAC is always checked.
import { createHmac } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { WebhookSignatureError } from 'boilpayment-core';
import { PortoneProvider } from '../src/index.js';

const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const BODY = JSON.stringify({ type: 'Transaction.Paid', timestamp: '2024-04-25T10:00:00.000Z', data: { paymentId: 'pay_e17' } });
function sign(id: string, ts: string, body: string): string {
  const key = Buffer.from(SECRET.slice('whsec_'.length), 'base64');
  return 'v1,' + createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
}
const provider = () => new PortoneProvider({ apiSecret: 'test_sk_dummy', storeId: 'store_dummy', webhookSecret: SECRET }, (async () => { throw new Error('no fetch'); }) as typeof fetch);

describe('[EC:E17] PortoneProvider.verifyWebhook receivedAt', () => {
  const t = Math.floor(Date.now() / 1000) - 600;
  const id = 'msg_e17';
  const headers = { 'webhook-id': id, 'webhook-timestamp': String(t), 'webhook-signature': sign(id, String(t), BODY) };
  it('[EC:E17] a re-verify 10 minutes later checks the signature only and passes', async () => {
    const e = await provider().verifyWebhook({ headers, rawBody: BODY, receivedAt: new Date(t * 1000) });
    expect(e.id).toBeTruthy();
  });
  it('[EC:E17] without receivedAt the old timestamp is refused', async () => {
    await expect(provider().verifyWebhook({ headers, rawBody: BODY })).rejects.toBeInstanceOf(WebhookSignatureError);
  });
  it('[EC:E17] a tampered stored body is refused even with receivedAt', async () => {
    await expect(provider().verifyWebhook({ headers, rawBody: BODY.replace('5000', '1').replace('pay_e17', 'pay_x'), receivedAt: new Date(t * 1000) })).rejects.toBeInstanceOf(WebhookSignatureError);
  });
  it('[EC:E17] a stale timestamp is refused at receipt', async () => {
    const old = String(t - 3600);
    const h = { 'webhook-id': id, 'webhook-timestamp': old, 'webhook-signature': sign(id, old, BODY) };
    await expect(provider().verifyWebhook({ headers: h, rawBody: BODY })).rejects.toBeInstanceOf(WebhookSignatureError); // judged at receipt (wall clock)
  });
});
