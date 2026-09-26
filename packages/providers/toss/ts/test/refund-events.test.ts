import { expect, it } from 'vitest';
import { TossProvider, mapTossWebhook } from '../src/index.js';

it.each([['DONE', 'refund.created'], ['FAILED', 'refund.pending'], ['PENDING', 'refund.pending']])('keeps cancellation identity and safe state %s', (cancelStatus, type) => {
  const body = { eventType: 'CANCEL_STATUS_CHANGED', createdAt: '2026-09-10T10:00:00.000',
    data: { transactionKey: 'cancel_2', cancelAmount: 3000, cancelStatus } };
  const event = mapTossWebhook(body);
  expect(event).toMatchObject({ type, refundRef: 'cancel_2', paymentRef: null, amount: null });
  expect(mapTossWebhook(body).id).toBe(event.id);
  expect(mapTossWebhook({ ...body, data: { ...body.data, transactionKey: 'cancel_3' } }).id).not.toBe(event.id);
});

it('selects a single cancellation by lastTransactionKey, never the original total or array order', () => {
  const event = mapTossWebhook({ eventType: 'PAYMENT_STATUS_CHANGED', createdAt: '2026-09-10T10:00:00+09:00',
    data: { paymentKey: 'payment', status: 'PARTIAL_CANCELED', currency: 'KRW', totalAmount: 10000,
      lastTransactionKey: 'cancel_2', cancels: [
        { transactionKey: 'cancel_2', cancelAmount: 3000, cancelStatus: 'DONE' },
        { transactionKey: 'cancel_1', cancelAmount: 2000, cancelStatus: 'DONE' },
      ] } });
  expect(event).toMatchObject({ refundRef: 'cancel_2', amount: { amountMinor: 3000, currency: 'KRW' } });
});

it('does not turn aggregate cancellation totals into one refund', () => {
  const event = mapTossWebhook({ eventType: 'PAYMENT_STATUS_CHANGED', data: {
    paymentKey: 'payment', status: 'PARTIAL_CANCELED', totalAmount: 10000, currency: 'KRW' } });
  expect(event.refundRef).toBeNull();
  expect(event.amount).toBeNull();
});

it.each([['DONE', 'succeeded'], ['PENDING', 'pending'], ['FAILED', 'pending']])('refund API preserves transaction ID and %s', async (cancelStatus, status) => {
  const raw = { paymentKey: 'payment', method: '카드', currency: 'KRW', lastTransactionKey: 'cancel_2',
    cancels: [{ transactionKey: 'cancel_2', cancelAmount: 3000, cancelStatus }] };
  const provider = new TossProvider({ secretKey: 'test_secret' }, async () => new Response(JSON.stringify(raw)));
  expect(await provider.refund({ paymentRef: 'payment', amount: { amountMinor: 3000, currency: 'KRW' }, reason: 'test', idempotencyKey: 'cancel_2' }))
    .toMatchObject({ providerRef: 'cancel_2', status });
});

it('authoritative lookup finds an older exact cancellation and never another refund', async () => {
  const provider = new TossProvider({ secretKey: 'test_secret' }, async () => new Response(JSON.stringify({
    paymentKey: 'payment', currency: 'KRW', lastTransactionKey: 'new', cancels: [
      { transactionKey: 'old', cancelAmount: 2000, cancelStatus: 'DONE' },
      { transactionKey: 'new', cancelAmount: 3000, cancelStatus: 'DONE' },
    ],
  })));
  expect(await provider.getRefund({ paymentRef: 'payment', refundRef: 'old' }))
    .toMatchObject({ providerRef: 'old', status: 'succeeded', amount: { amountMinor: 2000, currency: 'KRW' } });
  expect(await provider.getRefund({ paymentRef: 'payment', refundRef: 'missing' })).toBeNull();
});
