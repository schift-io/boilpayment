import { describe, expect, it } from 'vitest';
import { toNormalizedEvent } from '../src/index.js';

type RefundPayload = {
  readonly id: string; readonly order_id: string; readonly customer_id: string;
  readonly subscription_id: string; readonly amount: number; readonly currency: string;
  readonly status: string | null;
};

describe('refund webhook identity and finality', () => {
  for (const type of ['refund.created', 'refund.updated']) {
    it.each([
      ['pending', 'refund.pending'], [null, 'refund.pending'],
      ['succeeded', 'refund.created'], ['failed', 'refund.failed'], ['canceled', 'refund.failed'],
    ])(`${type} %s maps to %s`, (status, expected) => {
      const data: RefundPayload = { id: 'refund_actual', order_id: 'order_actual', customer_id: 'customer_actual', subscription_id: 'sub_actual', amount: 250, currency: 'usd', status };
      const normalized = toNormalizedEvent({ type, id: 'delivery_actual', timestamp: '2026-01-01T00:00:00Z', data });
      expect(normalized.type).toBe(expected);
      expect(normalized.id).toBe('delivery_actual');
      expect(normalized.refundRef).toBe('refund_actual');
      expect(normalized.paymentRef).toBe('order_actual');
      expect(normalized.subscriptionRef).toBe('sub_actual');
      expect(normalized.amount).toEqual({ amountMinor: 250, currency: 'USD' });
    });
  }
  it('aggregate order refund never claims a singular refund', () => {
    expect(toNormalizedEvent({ type: 'order.refunded', data: { id: 'order_actual', total_amount: 1000, refunded_amount: 250, currency: 'usd' } })).toMatchObject({ type: 'unknown', refundRef: null });
  });
});
