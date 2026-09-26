import type Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { toNormalizedEvent } from '../src/index.js';

type RefundEvent = Stripe.RefundCreatedEvent | Stripe.RefundUpdatedEvent | Stripe.RefundFailedEvent | Stripe.ChargeRefundUpdatedEvent;

function event(type: RefundEvent['type'], status: Stripe.Refund['status']): RefundEvent {
  return {
    id: 'evt_delivery', object: 'event', api_version: '2024-12-18.acacia',
    created: 1735689600, livemode: false, pending_webhooks: 1, request: null, type,
    data: { object: {
      id: 're_actual', object: 'refund', amount: 250, currency: 'usd', created: 1735689600,
      balance_transaction: null, source_transfer_reversal: null, transfer_reversal: null, charge: 'ch_actual', payment_intent: 'pi_actual',
      metadata: {}, reason: 'requested_by_customer', receipt_number: null, status,
    } },
  };
}

describe('refund webhook identity and finality', () => {
  for (const type of ['refund.created', 'refund.updated', 'charge.refund.updated'] as const) {
    it.each([
      ['pending', 'refund.pending'], ['requires_action', 'refund.pending'],
      [null, 'refund.pending'], ['succeeded', 'refund.created'],
      ['failed', 'refund.failed'], ['canceled', 'refund.failed'],
    ] as const)(`${type} %s maps to %s`, (status, expected) => {
      const normalized = toNormalizedEvent(event(type, status));
      expect(normalized.type).toBe(expected);
      expect(normalized.id).toBe('evt_delivery');
      expect(normalized.refundRef).toBe('re_actual');
      expect(normalized.paymentRef).toBe('pi_actual');
      expect(normalized.amount).toEqual({ amountMinor: 250, currency: 'USD' });
    });
  }

  it('refund.failed preserves the actual refund reference', () => {
    expect(toNormalizedEvent(event('refund.failed', 'failed'))).toMatchObject({
      type: 'refund.failed', refundRef: 're_actual', id: 'evt_delivery',
    });
  });
});
