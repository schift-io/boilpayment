import { expect, it } from 'vitest';
import { PortoneProvider, mapPortoneWebhook } from '../src/index.js';

it.each([['Transaction.CancelPending', 'refund.pending'], ['Transaction.Cancelled', 'refund.created'], ['Transaction.PartialCancelled', 'refund.created']])('maps cancellation event %s without inventing an amount', (type, expected) => {
  const body = { type, timestamp: '2026-09-10T01:00:00Z', data: { paymentId: 'payment', transactionId: 'attempt', cancellationId: 'cancel_2', totalAmount: 10000 } };
  const event = mapPortoneWebhook(body);
  expect(event).toMatchObject({ type: expected, refundRef: 'cancel_2', paymentRef: 'payment', amount: null });
  expect(mapPortoneWebhook(body).id).toBe(event.id);
  expect(mapPortoneWebhook({ ...body, data: { ...body.data, cancellationId: 'cancel_3' } }).id).not.toBe(event.id);
});

it.each([['SUCCEEDED', 'succeeded'], ['REQUESTED', 'pending'], ['FAILED', 'failed']])('refund API maps actual cancellation state %s and reference', async (cancellationStatus, status) => {
  const raw = { cancellation: { id: 'cancel_2', status: cancellationStatus, totalAmount: 3000, requestedAt: '2026-09-10T01:00:00Z' } };
  const provider = new PortoneProvider({ apiSecret: 'test_secret', storeId: 'store', webhookSecret: 'whsec_test' }, async () => new Response(JSON.stringify(raw)));
  expect(await provider.refund({ paymentRef: 'payment', amount: { amountMinor: 3000, currency: 'KRW' }, reason: 'test', idempotencyKey: 'cancel_2' }))
    .toMatchObject({ providerRef: 'cancel_2', status });
});

it.each([['SUCCEEDED', 'succeeded'], ['REQUESTED', 'pending'], ['FAILED', 'failed']])('authoritative lookup matches exact cancellation with %s', async (status, expected) => {
  const provider = new PortoneProvider({ apiSecret: 'test_secret', storeId: 'store', webhookSecret: 'whsec_test' }, async () => new Response(JSON.stringify({
    id: 'payment', currency: 'KRW', cancellations: [
      { id: 'old', status, totalAmount: 2000, requestedAt: '2026-09-10T01:00:00Z' },
      { id: 'new', status: 'SUCCEEDED', totalAmount: 3000, requestedAt: '2026-09-10T01:01:00Z' },
    ],
  })));
  expect(await provider.getRefund({ paymentRef: 'payment', refundRef: 'old' }))
    .toMatchObject({ providerRef: 'old', status: expected, amount: { amountMinor: 2000, currency: 'KRW' } });
  expect(await provider.getRefund({ paymentRef: 'payment', refundRef: 'missing' })).toBeNull();
});
