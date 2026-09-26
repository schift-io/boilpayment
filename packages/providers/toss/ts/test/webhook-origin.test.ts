// [EC:E18] Toss webhooks carry no signature. The IP allowlist uses the connection address the app
// passes (remoteAddress), never a client-sent header; a virtual-account DEPOSIT_CALLBACK must carry
// the `secret` Toss returned on that payment (re-fetched by orderId, compared in constant time).
import { describe, expect, it } from 'vitest';
import { WebhookSignatureError } from 'boilpayment-core';
import { TossProvider } from '../src/index.js';

const DONE = JSON.stringify({ eventType: 'PAYMENT_STATUS_CHANGED', createdAt: '2026-01-01T00:00:00+09:00', data: { paymentKey: 'pk_1', orderId: 'o_1', status: 'DONE' } });
const deposit = (secret: string) => JSON.stringify({ eventType: 'DEPOSIT_CALLBACK', createdAt: '2026-01-01T00:00:00+09:00', secret, status: 'DONE', transactionKey: 'tx_1', orderId: 'o_va', data: { paymentKey: 'pk_va', orderId: 'o_va', status: 'DONE' } });
const noFetch = (async () => { throw new Error('should not fetch'); }) as never;
const paymentWithSecret = (secret: string) => (async (url: string) => {
  if (!String(url).includes('/v1/payments/orders/o_va')) throw new Error(`unexpected ${url}`);
  return new Response(JSON.stringify({ paymentKey: 'pk_va', orderId: 'o_va', status: 'DONE', secret, method: '가상계좌', totalAmount: 1000, currency: 'KRW' }), { status: 200 });
}) as never;

describe('[EC:E18] Toss webhook origin', () => {
  it('[EC:E18] a spoofed x-paykit-remote-ip header does not pass the allowlist', async () => {
    const p = new TossProvider({ secretKey: 'test_sk_x', allowedWebhookIps: ['203.0.113.10'] }, noFetch);
    await expect(p.verifyWebhook({ headers: { 'x-paykit-remote-ip': '203.0.113.10' }, rawBody: DONE, remoteAddress: '198.51.100.9' })).rejects.toBeInstanceOf(WebhookSignatureError);
    await expect(p.verifyWebhook({ headers: { 'x-paykit-remote-ip': '203.0.113.10' }, rawBody: DONE })).rejects.toBeInstanceOf(WebhookSignatureError);
  });
  it('[EC:E18] the allowlist was checked at receipt; a later re-verify (receivedAt) does not need the address', async () => {
    const p = new TossProvider({ secretKey: 'test_sk_x', allowedWebhookIps: ['203.0.113.10'] }, noFetch);
    const e = await p.verifyWebhook({ headers: {}, rawBody: DONE, receivedAt: new Date() });
    expect(e.type).toBe('payment.succeeded');
  });
  it('[EC:E18] DEPOSIT_CALLBACK with the payment\'s secret passes, a wrong secret is refused', async () => {
    const ok = new TossProvider({ secretKey: 'test_sk_x', allowedWebhookIps: ['203.0.113.10'] }, paymentWithSecret('s3cr3t'));
    const from = { headers: {}, remoteAddress: '203.0.113.10' };
    expect((await ok.verifyWebhook({ ...from, rawBody: deposit('s3cr3t') })).type).toBe('payment.succeeded');
    await expect(ok.verifyWebhook({ ...from, rawBody: deposit('guess') })).rejects.toBeInstanceOf(WebhookSignatureError);
  });
  it('[EC:E19] DEPOSIT_CALLBACK without a secret is refused (it used to skip the check)', async () => {
    const p = new TossProvider({ secretKey: 'test_sk_x', allowedWebhookIps: ['203.0.113.10'] }, paymentWithSecret('s3cr3t'));
    const body = JSON.parse(deposit('s3cr3t')); delete body.secret;
    await expect(p.verifyWebhook({ headers: {}, remoteAddress: '203.0.113.10', rawBody: JSON.stringify(body) })).rejects.toBeInstanceOf(WebhookSignatureError);
  });
});
