// Phase 6 regression tests — pure normalizers. Fixtures mirror ts/examples/smoke.ts and
// spec/polar.pseudo.md (status/failure mapping tables, webhook event mapping table).
import { describe, it, expect } from 'vitest';
import {
  normalizeFailure,
  normalizeOrder,
  normalizeSubscription,
  normalizeRefund,
  mapEventType,
  toNormalizedEvent,
} from '../src/index.js';

describe('[EC:E12] normalizeFailure', () => {
  it('[EC:E12] always returns code=unknown, retryable=true, providerCode=null (Polar exposes no failure detail)', () => {
    expect(normalizeFailure({ message: 'card processing error' })).toEqual({
      code: 'unknown',
      providerCode: null,
      retryable: true,
      userMessage: 'card processing error',
    });
  });

  it('[EC:E12] falls back to default Korean message when message absent', () => {
    expect(normalizeFailure({}).userMessage).toBe('결제 처리 중 오류가 발생했습니다. 다시 시도해 주세요.');
  });

  it('[EC:E12] null message also falls back to default Korean message', () => {
    expect(normalizeFailure({ message: null }).userMessage).toBe('결제 처리 중 오류가 발생했습니다. 다시 시도해 주세요.');
  });
});

describe('[EC:E7][EC:E12] normalizeOrder — Payment status mapping', () => {
  const BASE = {
    id: 'order_test_2',
    customer_id: 'cust_test_1',
    total_amount: 1000,
    currency: 'usd',
    created_at: '2024-01-01T00:00:00.000Z',
  };

  it('[EC:E7] status=paid, paid=true -> succeeded', () => {
    const p = normalizeOrder({ ...BASE, status: 'paid', paid: true });
    expect(p.status).toBe('succeeded');
  });

  it('[EC:E7] paid=true without status field still maps to succeeded', () => {
    const p = normalizeOrder({ ...BASE, paid: true });
    expect(p.status).toBe('succeeded');
  });

  it('[EC:D6] status=refunded -> refunded', () => {
    expect(normalizeOrder({ ...BASE, status: 'refunded' }).status).toBe('refunded');
  });

  it('[EC:D6] status=partially_refunded -> partially_refunded', () => {
    expect(normalizeOrder({ ...BASE, status: 'partially_refunded' }).status).toBe('partially_refunded');
  });

  it('[EC:E12] status=void -> failed', () => {
    expect(normalizeOrder({ ...BASE, status: 'void' }).status).toBe('failed');
  });

  it('[EC:E7][EC:E13] unrecognized/absent status (no order yet) -> pending', () => {
    expect(normalizeOrder({ ...BASE, status: 'unknown_status' }).status).toBe('pending');
    expect(normalizeOrder(BASE).status).toBe('pending');
  });

  it('[EC:F(Polar)] kind=subscription when subscription_id present, topup otherwise', () => {
    expect(normalizeOrder({ ...BASE, status: 'paid', paid: true, subscription_id: 'sub_test_1' }).kind).toBe('subscription');
    expect(normalizeOrder({ ...BASE, status: 'paid', paid: true }).kind).toBe('topup');
  });

  it('[EC:D6] amount is order currency/amount, no conversion; falls back total_amount -> net_amount -> 0', () => {
    const p = normalizeOrder({ ...BASE, status: 'paid', paid: true, currency: 'krw', total_amount: 5000 });
    expect(p.amount).toEqual({ amountMinor: 5000, currency: 'KRW' });
    const p2 = normalizeOrder({ ...BASE, status: 'paid', paid: true, total_amount: undefined, net_amount: 700 });
    expect(p2.amount.amountMinor).toBe(700);
  });

  it('[EC:F(Polar)] provider=polar, providerRef=order.id, subscriptionId passthrough', () => {
    const p = normalizeOrder({ ...BASE, status: 'paid', paid: true, subscription_id: 'sub_test_1' });
    expect(p.provider).toBe('polar');
    expect(p.providerRef).toBe('order_test_2');
    expect(p.subscriptionId).toBe('sub_test_1');
  });
});

describe('[EC:F(Polar)] normalizeSubscription — status mapping and metadata contract', () => {
  const BASE = {
    id: 'sub_test_1',
    customer_id: 'cust_test_1',
    current_period_start: '2024-01-01T00:00:00.000Z',
    current_period_end: '2024-01-31T00:00:00.000Z',
    cancel_at_period_end: false,
    created_at: '2024-01-01T00:00:00.000Z',
  };

  const statusTable: Array<[string, string]> = [
    ['trialing', 'trialing'],
    ['active', 'active'],
    ['past_due', 'past_due'],
    ['canceled', 'canceled'],
    ['unpaid', 'expired'],
    ['incomplete', 'past_due'],
    ['incomplete_expired', 'expired'],
    ['paused', 'active'],
  ];
  for (const [raw, expected] of statusTable) {
    it(`[EC:F(Polar)] status ${raw} -> ${expected}`, () => {
      expect(normalizeSubscription({ ...BASE, status: raw }).status).toBe(expected);
    });
  }

  it('[EC:F(Polar)] unrecognized status falls back to expired', () => {
    expect(normalizeSubscription({ ...BASE, status: 'some_future_status' }).status).toBe('expired');
  });

  it('[EC:F(Polar)] id/customerId/planId read from metadata per "계약 메모"; empty string when absent', () => {
    const withMeta = normalizeSubscription({
      ...BASE,
      status: 'active',
      metadata: { customerId: 'internal_cust_1', planId: 'plan_pro', subscriptionId: 'internal_sub_1' },
    });
    expect(withMeta.id).toBe('internal_sub_1');
    expect(withMeta.customerId).toBe('internal_cust_1');
    expect(withMeta.planId).toBe('plan_pro');

    const withoutMeta = normalizeSubscription({ ...BASE, status: 'active' });
    expect(withoutMeta.id).toBe('sub_test_1'); // falls back to sub.id
    expect(withoutMeta.customerId).toBe('cust_test_1'); // falls back to sub.customer_id
    expect(withoutMeta.planId).toBe(''); // no fallback source -> ''
  });

  it('[EC:A1] resetAnchor has no field on Subscription — anchorDay derives from current_period_start day', () => {
    const s = normalizeSubscription({ ...BASE, status: 'active', current_period_start: '2024-03-15T00:00:00.000Z' });
    expect(s.anchorDay).toBe(15);
  });

  it('[EC:A5] cancelAtPeriodEnd passthrough as boolean', () => {
    expect(normalizeSubscription({ ...BASE, status: 'active', cancel_at_period_end: true }).cancelAtPeriodEnd).toBe(true);
    expect(normalizeSubscription({ ...BASE, status: 'active', cancel_at_period_end: false }).cancelAtPeriodEnd).toBe(false);
  });
});

describe('[EC:D4][EC:D6] normalizeRefund', () => {
  const BASE = {
    id: 'refund_test_1',
    order_id: 'order_test_1',
    customer_id: 'cust_test_1',
    amount: 2000,
    currency: 'krw',
    reason: 'customer_request',
    created_at: '2024-01-01T00:00:00.000Z',
  };

  it('[EC:D4] status=succeeded -> succeeded', () => {
    expect(normalizeRefund({ ...BASE, status: 'succeeded' }, 'D4').status).toBe('succeeded');
  });

  it('[EC:D4] status=failed -> failed, and failure is populated via normalizeFailure', () => {
    const r = normalizeRefund({ ...BASE, status: 'failed' }, 'D4');
    expect(r.status).toBe('failed');
    expect(r.failure).toEqual({ code: 'unknown', providerCode: null, retryable: true, userMessage: '결제 처리 중 오류가 발생했습니다. 다시 시도해 주세요.' });
  });

  it('[EC:D4] status=canceled -> failed', () => {
    expect(normalizeRefund({ ...BASE, status: 'canceled' }, 'D4').status).toBe('failed');
  });

  it('[EC:D4] any other status -> pending, failure null', () => {
    const r = normalizeRefund({ ...BASE, status: 'pending' }, 'D4');
    expect(r.status).toBe('pending');
    expect(r.failure).toBeNull();
  });

  it('[EC:D6] amount/currency passthrough exactly (no conversion), ruleId carried', () => {
    const r = normalizeRefund({ ...BASE, status: 'succeeded' }, 'D4');
    expect(r.amount).toEqual({ amountMinor: 2000, currency: 'KRW' });
    expect(r.ruleId).toBe('D4');
    expect(r.paymentId).toBe('order_test_1');
    expect(r.providerRef).toBe('refund_test_1');
  });
});

describe('[EC:F(Polar)] mapEventType — webhook event mapping table', () => {
  const table: Array<[string, string]> = [
    ['order.paid', 'payment.succeeded'],
    ['order.created', 'payment.pending'],
    ['order.refunded', 'unknown'],
    ['refund.created', 'refund.pending'],
    ['refund.updated', 'refund.pending'],
    ['subscription.created', 'subscription.created'],
    ['subscription.updated', 'subscription.updated'],
    ['subscription.active', 'subscription.updated'],
    ['subscription.uncanceled', 'subscription.updated'],
    ['subscription.canceled', 'subscription.canceled'],
    ['subscription.revoked', 'subscription.canceled'],
    ['subscription.past_due', 'subscription.payment_failed'],
  ];
  for (const [raw, expected] of table) {
    it(`[EC:F(Polar)] ${raw} -> ${expected}`, () => {
      expect(mapEventType(raw)).toBe(expected);
    });
  }

  it('[EC:F(Polar)] unknown Benefits/checkout/customer/product events fall back to unknown (own ledger is source of truth)', () => {
    expect(mapEventType('benefit.created')).toBe('unknown');
    expect(mapEventType('benefit_grant.created')).toBe('unknown');
    expect(mapEventType('checkout.created')).toBe('unknown');
    expect(mapEventType('customer.updated')).toBe('unknown');
    expect(mapEventType('product.updated')).toBe('unknown');
  });
});

describe('[EC:F(Polar)] toNormalizedEvent — field extraction per source-column of mapping table', () => {
  it('[EC:F(Polar)] order.paid populates paymentRef/subscriptionRef/customerRef/amount from order fields', () => {
    const ev = toNormalizedEvent({
      type: 'order.paid',
      timestamp: '2024-01-01T00:00:00.000Z',
      data: { id: 'order_test_1', customer_id: 'cust_test_1', subscription_id: 'sub_test_1', total_amount: 5000, currency: 'krw' },
    });
    expect(ev.type).toBe('payment.succeeded');
    expect(ev.paymentRef).toBe('order_test_1');
    expect(ev.subscriptionRef).toBe('sub_test_1');
    expect(ev.customerRef).toBe('cust_test_1');
    expect(ev.amount).toEqual({ amountMinor: 5000, currency: 'KRW' });
    expect(ev.provider).toBe('polar');
    expect(ev.id).toBe('order.paid:order_test_1');
  });

  it('[EC:F(Polar)] subscription.past_due populates subscriptionRef/customerRef, no paymentRef/amount', () => {
    const ev = toNormalizedEvent({ type: 'subscription.past_due', timestamp: '2024-01-01T00:00:00.000Z', data: { id: 'sub_test_2', customer_id: 'cust_test_2' } });
    expect(ev.type).toBe('subscription.payment_failed');
    expect(ev.subscriptionRef).toBe('sub_test_2');
    expect(ev.customerRef).toBe('cust_test_2');
    expect(ev.paymentRef).toBeNull();
    expect(ev.amount).toBeNull();
  });

  it('[EC:D4] refund.created populates paymentRef from data.order_id (not data.id)', () => {
    const ev = toNormalizedEvent({ type: 'refund.created', timestamp: '2024-01-01T00:00:00.000Z', data: { id: 'refund_1', status: 'succeeded', order_id: 'order_test_1', customer_id: 'cust_test_1', amount: 2000, currency: 'krw' } });
    expect(ev.type).toBe('refund.created');
    expect(ev.paymentRef).toBe('order_test_1');
    expect(ev.amount).toEqual({ amountMinor: 2000, currency: 'KRW' });
  });

  it('[EC:F(Polar)] raw is preserved verbatim on the normalized event', () => {
    const parsed = { type: 'order.created', timestamp: '2024-01-01T00:00:00.000Z', data: { id: 'order_x' } };
    const ev = toNormalizedEvent(parsed);
    expect(ev.raw).toEqual(parsed);
  });
});
