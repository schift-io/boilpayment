// [EC:E17] process() re-verifies the stored body long after receipt. Freshness is judged at the
// receipt time it passes (`receivedAt`); the signature is still checked on every call.
import { describe, it, expect } from 'vitest';
import { WebhookSignatureError } from 'boilpayment-core';
import { StripeProvider } from '../src/index.js';
import { signStripePayload } from './helpers/webhookSig.js';

const secret = 'whsec_testsecret1234567890';
const provider = () => new StripeProvider({ secretKey: 'sk_test_dummy', webhookSecret: secret });
const body = (t: number) => JSON.stringify({ id: 'evt_e17', object: 'event', type: 'invoice.paid', created: t,
  data: { object: { id: 'in_e17', object: 'invoice', customer: 'cus_1', subscription: 'sub_1', amount_paid: 5000, amount_due: 5000, currency: 'krw', status: 'paid', created: t, lines: { data: [{ period: { start: t, end: t + 86400 } }] } } } });

describe('[EC:E17] StripeProvider.verifyWebhook receivedAt', () => {
  const tenMinAgo = Math.floor(Date.now() / 1000) - 600;
  const raw = body(tenMinAgo);
  const headers = { 'stripe-signature': signStripePayload(raw, secret, tenMinAgo) };
  it('[EC:E17] a signature fresh at receipt still verifies 10 minutes later', async () => {
    const e = await provider().verifyWebhook({ headers, rawBody: raw, receivedAt: new Date(tenMinAgo * 1000) });
    expect(e.paymentRef).toBe('in_e17');
  });
  it('[EC:E17] without receivedAt the old timestamp is refused (receive-time freshness)', async () => {
    await expect(provider().verifyWebhook({ headers, rawBody: raw })).rejects.toBeInstanceOf(WebhookSignatureError);
  });
  it('[EC:E17] a tampered stored body is refused even with receivedAt', async () => {
    await expect(provider().verifyWebhook({ headers, rawBody: raw.replace('5000', '1'), receivedAt: new Date(tenMinAgo * 1000) })).rejects.toBeInstanceOf(WebhookSignatureError);
  });
  it('[EC:E17] a timestamp already stale at receipt stays refused', async () => {
    const t = tenMinAgo - 3600;
    const old = body(t);
    await expect(provider().verifyWebhook({ headers: { 'stripe-signature': signStripePayload(old, secret, t) }, rawBody: old, receivedAt: new Date(tenMinAgo * 1000) })).rejects.toBeInstanceOf(WebhookSignatureError);
  });
});
