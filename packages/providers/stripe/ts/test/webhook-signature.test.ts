// [EC:E4] verifyWebhook signature verification tests. Signatures are constructed by hand (HMAC-SHA256
// over "{t}.{body}", header "t=...,v1=...") mirroring Stripe's documented scheme — not via the SDK's
// own `webhooks.generateTestHeaderString` test helper — so the test doesn't validate the SDK against
// itself. No network calls: `verifyWebhook` is pure crypto + parsing (packages/providers/stripe/spec/
// stripe.pseudo.md "엔드포인트 매핑" row for verifyWebhook).
import { describe, it, expect } from 'vitest';
import { WebhookSignatureError } from '@schift/payment-kit-core';
import { StripeProvider } from '../src/index.js';
import { signStripePayload } from './helpers/webhookSig.js';

const webhookSecret = 'whsec_testsecret1234567890';

function makeProvider() {
  return new StripeProvider({ secretKey: 'sk_test_dummy', webhookSecret });
}

function invoicePaidPayload(now: number): string {
  return JSON.stringify({
    id: 'evt_test_invoice_paid',
    object: 'event',
    type: 'invoice.paid',
    created: now,
    data: {
      object: {
        id: 'in_test_1',
        object: 'invoice',
        customer: 'cus_test_1',
        subscription: 'sub_test_1',
        amount_paid: 5000,
        amount_due: 5000,
        currency: 'krw',
        status: 'paid',
        created: now,
        lines: { data: [{ period: { start: now, end: now + 30 * 86400 } }] },
      },
    },
  });
}

describe('[EC:E4] StripeProvider.verifyWebhook', () => {
  it('[EC:E4] valid signature over the exact body passes and returns the correctly mapped NormalizedEvent', async () => {
    const provider = makeProvider();
    const now = Math.floor(Date.now() / 1000);
    const payload = invoicePaidPayload(now);
    const header = signStripePayload(payload, webhookSecret, now);

    const normalized = await provider.verifyWebhook({ headers: { 'stripe-signature': header }, rawBody: payload });

    expect(normalized.type).toBe('payment.succeeded');
    expect(normalized.paymentRef).toBe('in_test_1');
    expect(normalized.subscriptionRef).toBe('sub_test_1');
    expect(normalized.customerRef).toBe('cus_test_1');
    expect(normalized.amount).toEqual({ amountMinor: 5000, currency: 'KRW' });
  });

  it('[EC:E4] header carrying the "Stripe-Signature" capitalized header name is also accepted', async () => {
    const provider = makeProvider();
    const now = Math.floor(Date.now() / 1000);
    const payload = invoicePaidPayload(now);
    const header = signStripePayload(payload, webhookSecret, now);

    const normalized = await provider.verifyWebhook({ headers: { 'Stripe-Signature': header }, rawBody: payload });
    expect(normalized.type).toBe('payment.succeeded');
  });

  it('[EC:E4] tampered body (payload mutated after signing) is rejected as WebhookSignatureError', async () => {
    const provider = makeProvider();
    const now = Math.floor(Date.now() / 1000);
    const payload = invoicePaidPayload(now);
    const header = signStripePayload(payload, webhookSecret, now);
    const tamperedPayload = payload.replace('"amount_paid":5000', '"amount_paid":999999');

    await expect(provider.verifyWebhook({ headers: { 'stripe-signature': header }, rawBody: tamperedPayload })).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  it('[EC:E4] signature computed with the wrong secret is rejected as WebhookSignatureError', async () => {
    const provider = makeProvider();
    const now = Math.floor(Date.now() / 1000);
    const payload = invoicePaidPayload(now);
    const header = signStripePayload(payload, 'whsec_totally_different_secret', now);

    await expect(provider.verifyWebhook({ headers: { 'stripe-signature': header }, rawBody: payload })).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  it('[EC:E4] missing stripe-signature header is rejected as WebhookSignatureError without attempting verification', async () => {
    const provider = makeProvider();
    const payload = invoicePaidPayload(Math.floor(Date.now() / 1000));

    await expect(provider.verifyWebhook({ headers: {}, rawBody: payload })).rejects.toThrow(WebhookSignatureError);
    await expect(provider.verifyWebhook({ headers: {}, rawBody: payload })).rejects.toThrow('missing stripe-signature header');
  });

  it('[EC:E4] malformed header (no v1= component) is rejected as WebhookSignatureError', async () => {
    const provider = makeProvider();
    const payload = invoicePaidPayload(Math.floor(Date.now() / 1000));

    await expect(provider.verifyWebhook({ headers: { 'stripe-signature': 't=123,not_v1=deadbeef' }, rawBody: payload })).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  it('[EC:E4] timestamp older than the SDK default 300s tolerance is rejected even with a correct signature (stripe.webhooks.constructEvent default)', async () => {
    const provider = makeProvider();
    const staleTimestamp = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago, > 300s default tolerance
    const payload = invoicePaidPayload(staleTimestamp);
    const header = signStripePayload(payload, webhookSecret, staleTimestamp);

    await expect(provider.verifyWebhook({ headers: { 'stripe-signature': header }, rawBody: payload })).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  it('[EC:E4] timestamp within tolerance (e.g. 60s old) with a correct signature still passes', async () => {
    const provider = makeProvider();
    const recentTimestamp = Math.floor(Date.now() / 1000) - 60;
    const payload = invoicePaidPayload(recentTimestamp);
    const header = signStripePayload(payload, webhookSecret, recentTimestamp);

    const normalized = await provider.verifyWebhook({ headers: { 'stripe-signature': header }, rawBody: payload });
    expect(normalized.type).toBe('payment.succeeded');
  });
});
