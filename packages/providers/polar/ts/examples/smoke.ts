// Smoke test — no live Polar keys. Exercises verifyWebhook (manual Standard Webhooks verification)
// against a self-signed payload and the pure normalize functions against fixture objects.
// Run: node <tsx cli> packages/providers/polar/ts/examples/smoke.ts
import { createHmac } from 'node:crypto';
import {
  PolarProvider,
  normalizeFailure,
  normalizeOrder,
  normalizeSubscription,
  normalizeRefund,
  mapEventType,
  toNormalizedEvent,
  verifyStandardWebhookSignature,
} from '../src/index.js';
import { WebhookSignatureError } from '@schift/payment-kit-core';

function signStandardWebhook(id: string, timestamp: string, body: string, secret: string): string {
  const secretRaw = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  const key = Buffer.from(secretRaw, 'base64');
  const signedContent = `${id}.${timestamp}.${body}`;
  const sig = createHmac('sha256', key).update(signedContent).digest('base64');
  return `v1,${sig}`;
}

async function main() {
  // secret must be base64-decodable; use a base64 string directly (Polar issues secrets as `whsec_<base64>`)
  const webhookSecret = 'whsec_c2VjcmV0a2V5Zm9ycG9sYXJ0ZXN0';
  const provider = new PolarProvider({ accessToken: 'polar_at_dummy', webhookSecret, server: 'sandbox' });

  console.log('=== capabilities ===');
  console.log(provider.capabilities());

  const orderPaidBody = JSON.stringify({
    type: 'order.paid',
    timestamp: '2026-01-01T00:00:00.000Z',
    data: {
      id: 'order_test_1',
      customer_id: 'cust_test_1',
      subscription_id: 'sub_test_1',
      total_amount: 5000,
      currency: 'krw',
      status: 'paid',
      paid: true,
      created_at: '2026-01-01T00:00:00.000Z',
    },
  });
  const webhookId = 'msg_test_1';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sigHeader = signStandardWebhook(webhookId, timestamp, orderPaidBody, webhookSecret);

  console.log('\n=== verifyWebhook (valid signature, order.paid) ===');
  const normalized = await provider.verifyWebhook({
    headers: { 'webhook-id': webhookId, 'webhook-timestamp': timestamp, 'webhook-signature': sigHeader },
    rawBody: orderPaidBody,
  });
  console.log(JSON.stringify(normalized, null, 2));

  console.log('\n=== verifyWebhook (bad signature) ===');
  try {
    await provider.verifyWebhook({
      headers: { 'webhook-id': webhookId, 'webhook-timestamp': timestamp, 'webhook-signature': 'v1,deadbeef' },
      rawBody: orderPaidBody,
    });
    console.log('FAIL: expected WebhookSignatureError, none thrown');
    process.exitCode = 1;
  } catch (err) {
    if (err instanceof WebhookSignatureError) {
      console.log('OK: rejected as WebhookSignatureError:', err.message);
    } else {
      console.log('FAIL: wrong error type:', err);
      process.exitCode = 1;
    }
  }

  // extra direct unit check of verifyStandardWebhookSignature (missing headers path)
  console.log('\n=== verifyStandardWebhookSignature (missing headers) ===');
  try {
    verifyStandardWebhookSignature({ headers: {}, rawBody: orderPaidBody, secret: webhookSecret });
    console.log('FAIL: expected WebhookSignatureError');
    process.exitCode = 1;
  } catch (err) {
    console.log('OK:', (err as Error).message);
  }

  console.log('\n=== normalizeFailure fixture ===');
  console.log(normalizeFailure({ message: 'card processing error' }));

  console.log('\n=== normalizeOrder fixture (topup) ===');
  console.log(
    JSON.stringify(
      normalizeOrder({ id: 'order_test_2', customer_id: 'cust_test_1', total_amount: 1000, currency: 'usd', status: 'paid', paid: true, created_at: '2026-01-01T00:00:00.000Z' }),
      null,
      2,
    ),
  );

  console.log('\n=== normalizeSubscription fixture ===');
  console.log(
    JSON.stringify(
      normalizeSubscription({
        id: 'sub_test_1',
        customer_id: 'cust_test_1',
        status: 'active',
        current_period_start: '2026-01-01T00:00:00.000Z',
        current_period_end: '2026-01-31T00:00:00.000Z',
        cancel_at_period_end: false,
        created_at: '2026-01-01T00:00:00.000Z',
        metadata: { customerId: 'internal_cust_1', planId: 'plan_pro' },
      }),
      null,
      2,
    ),
  );

  console.log('\n=== normalizeRefund fixture ===');
  console.log(
    JSON.stringify(
      normalizeRefund({ id: 'refund_test_1', order_id: 'order_test_1', customer_id: 'cust_test_1', amount: 2000, currency: 'krw', status: 'succeeded', reason: 'customer_request', created_at: '2026-01-01T00:00:00.000Z' }, 'D4'),
      null,
      2,
    ),
  );

  console.log('\n=== mapEventType(subscription.revoked) ===');
  console.log(mapEventType('subscription.revoked'));

  console.log('\n=== toNormalizedEvent (subscription.past_due fixture) ===');
  console.log(
    JSON.stringify(
      toNormalizedEvent({ type: 'subscription.past_due', timestamp: '2026-01-01T00:00:00.000Z', data: { id: 'sub_test_2', customer_id: 'cust_test_2' } }),
      null,
      2,
    ),
  );

  console.log('\nSMOKE OK');
}

main().catch((err) => {
  console.error('SMOKE FAILED', err);
  process.exitCode = 1;
});
