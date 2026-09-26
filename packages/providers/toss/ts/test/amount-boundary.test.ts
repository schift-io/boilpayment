// [EC:J8] Amounts from Toss are checked at the provider boundary: a fractional or unsafe amount in a
// webhook body is refused instead of flowing into the ledger (Py used to truncate 1.5 to 1).
import { describe, it, expect } from 'vitest';
import { mapTossWebhook } from '../src/index.js';

const body = (totalAmount: number) => ({ eventType: 'PAYMENT_STATUS_CHANGED', createdAt: '2026-01-01T00:00:00+09:00',
  data: { paymentKey: 'pk_1', orderId: 'o_1', status: 'DONE', totalAmount, currency: 'KRW' } });

describe('[EC:J8] Toss amount boundary', () => {
  it('[EC:J8] a whole amount passes', () => {
    expect(mapTossWebhook(body(5000)).amount).toEqual({ amountMinor: 5000, currency: 'KRW' });
  });
  it.each([1.5, 2 ** 53])('[EC:J8] %s is refused', (n) => {
    expect(() => mapTossWebhook(body(n))).toThrow();
  });
});
