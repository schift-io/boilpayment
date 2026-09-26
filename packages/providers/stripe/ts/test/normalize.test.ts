// Pure normalizer tests — no network, no StripeProvider instance. Fixtures are modeled on real
// Stripe webhook/object shapes (mirroring ts/examples/smoke.ts) and checked against
// packages/providers/stripe/spec/stripe.pseudo.md.
import { describe, it, expect } from 'vitest';
import type Stripe from 'stripe';
import {
  normalizeFailure,
  normalizePaymentIntent,
  normalizeInvoiceAsPayment,
  normalizeSubscription,
  normalizeRefund,
  mapEventType,
  toNormalizedEvent,
  invoicePaymentIntentRef,
} from '../src/index.js';

const NOW = 1_700_000_000;

describe('[EC:E12] normalizeFailure', () => {
  const table: Array<[string, string, boolean]> = [
    ['insufficient_funds', 'insufficient_funds', true],
    ['card_declined', 'card_declined', false],
    ['expired_card', 'expired_card', false],
    ['processing_error', 'processing_error', true],
    ['incorrect_cvc', 'incorrect_cvc', true],
    ['incorrect_number', 'incorrect_number', true],
    ['authentication_required', 'authentication_required', true],
    ['lost_card', 'lost_card', false],
    ['stolen_card', 'stolen_card', false],
    ['api_connection_error', 'provider_unavailable', true],
    ['api_error', 'provider_unavailable', true],
    ['rate_limit_error', 'provider_unavailable', true],
  ];

  for (const [input, expectedCode, expectedRetryable] of table) {
    it(`[EC:E12] maps decline_code "${input}" -> code "${expectedCode}" retryable=${expectedRetryable}`, () => {
      const result = normalizeFailure({ declineCode: input });
      expect(result.code).toBe(expectedCode);
      expect(result.retryable).toBe(expectedRetryable);
      expect(result.providerCode).toBe(input);
    });
  }

  it('[EC:E12] unmapped code falls back to unknown/non-retryable and preserves providerCode + message', () => {
    const result = normalizeFailure({ code: 'some_weird_code', message: 'weird' });
    expect(result).toEqual({ code: 'unknown', providerCode: 'some_weird_code', retryable: false, userMessage: 'weird' });
  });

  it('[EC:E12] unmapped code with no message falls back to default Korean userMessage', () => {
    const result = normalizeFailure({ code: 'totally_unknown' });
    expect(result.code).toBe('unknown');
    expect(result.userMessage).toBe('결제 중 알 수 없는 오류가 발생했습니다.');
  });

  it('[EC:E12] declineCode takes precedence over code when both present', () => {
    const result = normalizeFailure({ code: 'card_error', declineCode: 'insufficient_funds' });
    expect(result.code).toBe('insufficient_funds');
    expect(result.providerCode).toBe('insufficient_funds');
  });

  it('[EC:E12] no code and no declineCode -> unknown with null providerCode', () => {
    const result = normalizeFailure({ message: 'nothing to go on' });
    expect(result.code).toBe('unknown');
    expect(result.providerCode).toBeNull();
  });
});

describe('[EC:E7] normalizePaymentIntent — PaymentIntent.status -> PaymentStatus', () => {
  function pi(status: string, extra: Record<string, unknown> = {}): Stripe.PaymentIntent {
    return {
      id: 'pi_test_1',
      amount: 10000,
      currency: 'krw',
      status,
      created: NOW,
      last_payment_error: null,
      invoice: null,
      ...extra,
    } as unknown as Stripe.PaymentIntent;
  }

  it('[EC:E7] status=succeeded -> succeeded', () => {
    expect(normalizePaymentIntent(pi('succeeded')).status).toBe('succeeded');
  });

  for (const s of ['requires_action', 'requires_confirmation', 'requires_payment_method']) {
    it(`[EC:E7] status=${s} -> requires_action (3DS/SCA hold)`, () => {
      expect(normalizePaymentIntent(pi(s)).status).toBe('requires_action');
    });
  }

  for (const s of ['processing', 'requires_capture']) {
    it(`[EC:E7] status=${s} -> pending`, () => {
      expect(normalizePaymentIntent(pi(s)).status).toBe('pending');
    });
  }

  it('[EC:E7] status=canceled -> failed', () => {
    expect(normalizePaymentIntent(pi('canceled')).status).toBe('failed');
  });

  it('[EC:E7] unknown status defaults to pending', () => {
    expect(normalizePaymentIntent(pi('some_future_status')).status).toBe('pending');
  });

  it('[EC:F(Stripe)] kind=topup when no invoice supplied, kind=subscription when invoice supplied', () => {
    const topup = normalizePaymentIntent(pi('succeeded'), null);
    expect(topup.kind).toBe('topup');
    expect(topup.subscriptionId).toBeNull();
    expect(topup.period).toBeNull();

    const invoice = {
      id: 'in_1',
      subscription: 'sub_test_1',
      lines: { data: [{ period: { start: NOW, end: NOW + 2592000 } }] },
    } as unknown as Stripe.Invoice;
    const withInvoice = normalizePaymentIntent(pi('succeeded'), invoice);
    expect(withInvoice.kind).toBe('subscription');
    expect(withInvoice.subscriptionId).toBe('sub_test_1');
    expect(withInvoice.period).toEqual({ start: new Date(NOW * 1000), end: new Date((NOW + 2592000) * 1000) });
  });

  it('[EC:E12] failure populated from last_payment_error via normalizeFailure', () => {
    const withError = pi('requires_payment_method', {
      last_payment_error: { code: 'card_declined', decline_code: 'insufficient_funds', message: 'declined' },
    });
    const result = normalizePaymentIntent(withError, null);
    expect(result.failure).toEqual({ code: 'insufficient_funds', providerCode: 'insufficient_funds', retryable: true, userMessage: expect.any(String) });
  });

  it('[EC:D6] amount is currency + amountMinor 1:1 (no conversion, currency upper-cased)', () => {
    const result = normalizePaymentIntent(pi('succeeded'), null);
    expect(result.amount).toEqual({ amountMinor: 10000, currency: 'KRW' });
  });
});

describe('[EC:F(Stripe)] normalizeInvoiceAsPayment', () => {
  function invoice(status: Stripe.Invoice.Status | null, extra: Record<string, unknown> = {}): Stripe.Invoice {
    return {
      id: 'in_test_1',
      subscription: 'sub_test_1',
      amount_paid: 5000,
      amount_due: 5000,
      currency: 'krw',
      status,
      created: NOW,
      lines: { data: [{ period: { start: NOW, end: NOW + 2592000 } }] },
      ...extra,
    } as unknown as Stripe.Invoice;
  }

  it.each(['legacy', 'basil'])('preserves %s subscription checkout identity on the invoice payment', (shape) => {
    const metadata = { checkoutEntitlementKey: 'intent_immutable', planId: 'captured_plan' };
    const original = invoice('paid', shape === 'legacy'
      ? { metadata: {}, subscription_details: { metadata } }
      : { subscription: undefined, metadata: {}, parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_test_1', metadata } } });
    const normalized = normalizeInvoiceAsPayment(original);
    expect(normalized.subscriptionId).toBe('sub_test_1');
    expect(normalized.raw).toMatchObject({ metadata });
    expect(original.metadata).toEqual({});
  });

  it('[EC:F(Stripe)] status=paid -> succeeded, kind is always subscription', () => {
    const result = normalizeInvoiceAsPayment(invoice('paid'));
    expect(result.status).toBe('succeeded');
    expect(result.kind).toBe('subscription');
    expect(result.subscriptionId).toBe('sub_test_1');
  });

  for (const s of ['open', 'draft'] as const) {
    it(`[EC:F(Stripe)] status=${s} -> pending`, () => {
      expect(normalizeInvoiceAsPayment(invoice(s)).status).toBe('pending');
    });
  }

  for (const s of ['uncollectible', 'void'] as const) {
    it(`[EC:F(Stripe)] status=${s} -> failed`, () => {
      expect(normalizeInvoiceAsPayment(invoice(s)).status).toBe('failed');
    });
  }

  it('[EC:F(Stripe)] unknown/null status defaults to pending', () => {
    expect(normalizeInvoiceAsPayment(invoice(null)).status).toBe('pending');
  });

  it('[EC:E7 E12] failure only populated when status=open AND a PaymentIntent with last_payment_error is supplied', () => {
    const pi = { last_payment_error: { code: 'expired_card' } } as unknown as Stripe.PaymentIntent;
    const openWithPi = normalizeInvoiceAsPayment(invoice('open'), pi);
    expect(openWithPi.failure).toEqual({ code: 'expired_card', providerCode: 'expired_card', retryable: false, userMessage: expect.any(String) });

    const paidWithPi = normalizeInvoiceAsPayment(invoice('paid'), pi);
    expect(paidWithPi.failure).toBeNull();

    const openNoPi = normalizeInvoiceAsPayment(invoice('open'), null);
    expect(openNoPi.failure).toBeNull();
  });

  it('[EC:F(Stripe)] amount falls back to amount_due when amount_paid is falsy (0/open invoice)', () => {
    const result = normalizeInvoiceAsPayment(invoice('open', { amount_paid: 0, amount_due: 7000 }));
    expect(result.amount).toEqual({ amountMinor: 7000, currency: 'KRW' });
  });
});

describe('[EC:F(Stripe)] normalizeSubscription', () => {
  function sub(extra: Record<string, unknown> = {}): Stripe.Subscription {
    return {
      id: 'sub_test_1',
      customer: 'cus_test_1',
      status: 'active',
      current_period_start: NOW,
      current_period_end: NOW + 2592000,
      billing_cycle_anchor: NOW,
      cancel_at_period_end: false,
      created: NOW,
      metadata: {},
      ...extra,
    } as unknown as Stripe.Subscription;
  }

  const statusTable: Array<[string, string]> = [
    ['trialing', 'trialing'],
    ['active', 'active'],
    ['past_due', 'past_due'],
    ['canceled', 'canceled'],
    ['unpaid', 'expired'],
    ['incomplete', 'incomplete'], // EC:A27 — first payment not made yet: not entitled, no dunning
    ['incomplete_expired', 'expired'],
    ['paused', 'paused'], // EC:A27 — trial ended without a payment method: not entitled
  ];
  for (const [stripeStatus, expected] of statusTable) {
    it(`[EC:F(Stripe)] status=${stripeStatus} -> ${expected}`, () => {
      expect(normalizeSubscription(sub({ status: stripeStatus })).status).toBe(expected);
    });
  }

  it('[EC:F(Stripe)] unmapped status defaults to expired', () => {
    expect(normalizeSubscription(sub({ status: 'some_future_status' })).status).toBe('expired');
  });

  it('계약 메모: metadata.customerId/planId/subscriptionId populate id/customerId/planId when present', () => {
    const result = normalizeSubscription(sub({ metadata: { customerId: 'internal_cust_1', planId: 'plan_pro', subscriptionId: 'internal_sub_1' } }));
    expect(result.id).toBe('internal_sub_1');
    expect(result.customerId).toBe('internal_cust_1');
    expect(result.planId).toBe('plan_pro');
  });

  it('계약 메모: missing metadata falls back to provider id for `id`, provider customer id for `customerId`, and empty string for `planId`', () => {
    const result = normalizeSubscription(sub({ metadata: {} }));
    expect(result.id).toBe('sub_test_1');
    expect(result.customerId).toBe('cus_test_1');
    expect(result.planId).toBe('');
  });

  it('[EC:G1] anchorDay is the UTC day-of-month of billing_cycle_anchor', () => {
    const jan15 = Math.floor(Date.UTC(2024, 0, 15, 3, 0, 0) / 1000);
    const result = normalizeSubscription(sub({ billing_cycle_anchor: jan15 }));
    expect(result.anchorDay).toBe(15);
  });

  it('normalizeSubscription surfaces cancelAtPeriodEnd and providerRef verbatim', () => {
    const result = normalizeSubscription(sub({ cancel_at_period_end: true }));
    expect(result.cancelAtPeriodEnd).toBe(true);
    expect(result.providerRef).toBe('sub_test_1');
    expect(result.provider).toBe('stripe');
  });

  it('reads current_period_start/end from items[0] when absent on the subscription itself (basil API shape)', () => {
    const s = {
      id: 'sub_basil_1',
      customer: 'cus_1',
      status: 'active',
      billing_cycle_anchor: NOW,
      cancel_at_period_end: false,
      created: NOW,
      metadata: {},
      items: { data: [{ current_period_start: NOW, current_period_end: NOW + 2592000 }] },
    } as unknown as Stripe.Subscription;
    const result = normalizeSubscription(s);
    expect(result.currentPeriod).toEqual({ start: new Date(NOW * 1000), end: new Date((NOW + 2592000) * 1000) });
  });

  it('[EC:F(Stripe)] throws PaymentKitError(provider_shape) when current_period is absent both on the subscription and on items[0]', () => {
    const s = {
      id: 'sub_no_period',
      customer: 'cus_1',
      status: 'active',
      billing_cycle_anchor: NOW,
      cancel_at_period_end: false,
      created: NOW,
      metadata: {},
      items: { data: [{}] },
    } as unknown as Stripe.Subscription;
    expect(() => normalizeSubscription(s)).toThrowError(
      expect.objectContaining({ code: 'provider_shape' }),
    );
  });

  it('[EC:F(Stripe)] throws PaymentKitError(provider_shape) when items.data is empty and nothing on the subscription root', () => {
    const s = {
      id: 'sub_no_items',
      customer: 'cus_1',
      status: 'active',
      billing_cycle_anchor: NOW,
      cancel_at_period_end: false,
      created: NOW,
      metadata: {},
      items: { data: [] },
    } as unknown as Stripe.Subscription;
    expect(() => normalizeSubscription(s)).toThrowError(
      expect.objectContaining({ code: 'provider_shape' }),
    );
  });
});

describe('[EC:D4 D6] normalizeRefund', () => {
  function refund(status: string | null, extra: Record<string, unknown> = {}): Stripe.Refund {
    return {
      id: 're_test_1',
      payment_intent: 'pi_test_1',
      amount: 3000,
      currency: 'krw',
      status,
      created: NOW,
      reason: null,
      failure_reason: null,
      ...extra,
    } as unknown as Stripe.Refund;
  }

  it('[EC:D4 D6] status=succeeded -> succeeded', () => {
    expect(normalizeRefund(refund('succeeded'), 'cust_1', 'D4').status).toBe('succeeded');
  });

  for (const s of ['failed', 'canceled']) {
    it(`[EC:D4 D6] status=${s} -> failed`, () => {
      expect(normalizeRefund(refund(s), 'cust_1', 'D4').status).toBe('failed');
    });
  }

  it('[EC:D4 D6] status=pending (or unknown) defaults to pending', () => {
    expect(normalizeRefund(refund('pending'), 'cust_1', 'D4').status).toBe('pending');
  });

  it('[EC:D6] amount passes through 1:1 (no currency conversion), reason passed through unmapped', () => {
    const result = normalizeRefund(refund('succeeded', { reason: 'requested_by_customer' }), 'cust_1', 'D4');
    expect(result.amount).toEqual({ amountMinor: 3000, currency: 'KRW' });
    expect(result.reason).toBe('requested_by_customer');
    expect(result.ruleId).toBe('D4');
    expect(result.paymentId).toBe('pi_test_1');
    expect(result.creditsRevoked).toBe(0);
  });

  it('[EC:D4 D6] failure only populated when status=failed', () => {
    const failed = normalizeRefund(refund('failed', { failure_reason: 'expired_or_canceled_card' }), 'cust_1', 'D4');
    expect(failed.failure).not.toBeNull();
    const succeeded = normalizeRefund(refund('succeeded'), 'cust_1', 'D4');
    expect(succeeded.failure).toBeNull();
  });
});

describe('invoicePaymentIntentRef', () => {
  it('reads legacy string `invoice.payment_intent`', () => {
    const invoice = { payment_intent: 'pi_legacy_1' } as unknown as Stripe.Invoice;
    expect(invoicePaymentIntentRef(invoice)).toBe('pi_legacy_1');
  });

  it('reads legacy object `invoice.payment_intent.id`', () => {
    const invoice = { payment_intent: { id: 'pi_legacy_2' } } as unknown as Stripe.Invoice;
    expect(invoicePaymentIntentRef(invoice)).toBe('pi_legacy_2');
  });

  it('falls back to basil-era `invoice.payments.data[].payment.payment_intent` (string form)', () => {
    const invoice = { payments: { data: [{ payment: { payment_intent: 'pi_basil_1' } }] } } as unknown as Stripe.Invoice;
    expect(invoicePaymentIntentRef(invoice)).toBe('pi_basil_1');
  });

  it('falls back to basil-era `invoice.payments.data[].payment.payment_intent` (object form)', () => {
    const invoice = { payments: { data: [{ payment: { payment_intent: { id: 'pi_basil_2' } } }] } } as unknown as Stripe.Invoice;
    expect(invoicePaymentIntentRef(invoice)).toBe('pi_basil_2');
  });

  it('returns null when neither shape is present', () => {
    const invoice = {} as unknown as Stripe.Invoice;
    expect(invoicePaymentIntentRef(invoice)).toBeNull();
  });
});

describe('[EC:F(Stripe)] mapEventType — full webhook event mapping table', () => {
  function evt(type: string, object: Record<string, unknown> = {}): Stripe.Event {
    return { id: 'evt_1', type, created: NOW, data: { object } } as unknown as Stripe.Event;
  }

  it('invoice.paid -> payment.succeeded', () => {
    expect(mapEventType(evt('invoice.paid'))).toBe('payment.succeeded');
  });

  it('invoice.payment_failed -> subscription.payment_failed', () => {
    expect(mapEventType(evt('invoice.payment_failed'))).toBe('subscription.payment_failed');
  });

  it('checkout.session.completed (mode=payment) -> payment.succeeded', () => {
    expect(mapEventType(evt('checkout.session.completed', { mode: 'payment' }))).toBe('payment.succeeded');
  });

  it('checkout.session.completed (mode=subscription) -> subscription.created', () => {
    expect(mapEventType(evt('checkout.session.completed', { mode: 'subscription' }))).toBe('subscription.created');
  });

  it('[EC:E3] payment_intent.succeeded WITHOUT invoice field -> payment.succeeded', () => {
    expect(mapEventType(evt('payment_intent.succeeded', { invoice: null }))).toBe('payment.succeeded');
  });

  it('[EC:E3] payment_intent.succeeded WITH invoice field -> unknown (avoids double-trigger; invoice.paid already fired)', () => {
    expect(mapEventType(evt('payment_intent.succeeded', { invoice: 'in_1' }))).toBe('unknown');
  });

  it('payment_intent.payment_failed -> payment.failed', () => {
    expect(mapEventType(evt('payment_intent.payment_failed'))).toBe('payment.failed');
  });

  it('customer.subscription.created -> subscription.created', () => {
    expect(mapEventType(evt('customer.subscription.created'))).toBe('subscription.created');
  });

  it('customer.subscription.updated -> subscription.updated', () => {
    expect(mapEventType(evt('customer.subscription.updated'))).toBe('subscription.updated');
  });

  it('customer.subscription.deleted -> subscription.canceled', () => {
    expect(mapEventType(evt('customer.subscription.deleted'))).toBe('subscription.canceled');
  });

  it('charge.refunded -> unknown (cumulative snapshot)', () => {
    expect(mapEventType(evt('charge.refunded'))).toBe('unknown');
  });

  it('charge.dispute.created -> dispute.opened', () => {
    expect(mapEventType(evt('charge.dispute.created'))).toBe('dispute.opened');
  });

  it('charge.dispute.closed -> dispute.closed', () => {
    expect(mapEventType(evt('charge.dispute.closed'))).toBe('dispute.closed');
  });

  it('unhandled event type -> unknown', () => {
    expect(mapEventType(evt('customer.created'))).toBe('unknown');
  });
});

describe('[EC:F(Stripe)] toNormalizedEvent — field extraction per event type', () => {
  it('invoice.paid: paymentRef=invoice.id, subscriptionRef=invoice.subscription, customerRef=invoice.customer, amount=amount_paid', () => {
    const event = {
      id: 'evt_invoice_paid',
      type: 'invoice.paid',
      created: NOW,
      data: { object: { id: 'in_1', customer: 'cus_1', subscription: 'sub_1', amount_paid: 5000, amount_due: 5000, currency: 'krw' } },
    } as unknown as Stripe.Event;
    const result = toNormalizedEvent(event);
    expect(result).toEqual({
      id: 'evt_invoice_paid',
      provider: 'stripe',
      type: 'payment.succeeded',
      occurredAt: new Date(NOW * 1000),
      customerRef: 'cus_1',
      subscriptionRef: 'sub_1',
      paymentRef: 'in_1',
      refundRef: null,
      amount: { amountMinor: 5000, currency: 'KRW' },
      raw: event,
    });
  });

  it('checkout.session.completed: customerRef falls back to client_reference_id when session.customer is absent', () => {
    const event = {
      id: 'evt_checkout_1',
      type: 'checkout.session.completed',
      created: NOW,
      data: { object: { id: 'cs_1', mode: 'payment', customer: null, client_reference_id: 'internal_cust_9', payment_intent: 'pi_1', amount_total: 4200, currency: 'usd' } },
    } as unknown as Stripe.Event;
    const result = toNormalizedEvent(event);
    expect(result.customerRef).toBe('internal_cust_9');
    expect(result.paymentRef).toBe('pi_1');
    expect(result.amount).toEqual({ amountMinor: 4200, currency: 'USD' });
    expect(result.type).toBe('payment.succeeded');
  });

  it('checkout.session.completed (mode=subscription): subscriptionRef populated, type=subscription.created', () => {
    const event = {
      id: 'evt_checkout_2',
      type: 'checkout.session.completed',
      created: NOW,
      data: { object: { id: 'cs_2', mode: 'subscription', customer: 'cus_2', subscription: 'sub_2' } },
    } as unknown as Stripe.Event;
    const result = toNormalizedEvent(event);
    expect(result.subscriptionRef).toBe('sub_2');
    expect(result.type).toBe('subscription.created');
  });

  it('payment_intent.payment_failed: paymentRef=pi.id, customerRef=pi.customer, amount=pi.amount', () => {
    const event = {
      id: 'evt_pi_failed',
      type: 'payment_intent.payment_failed',
      created: NOW,
      data: { object: { id: 'pi_1', customer: 'cus_1', amount: 1000, currency: 'krw' } },
    } as unknown as Stripe.Event;
    const result = toNormalizedEvent(event);
    expect(result.paymentRef).toBe('pi_1');
    expect(result.customerRef).toBe('cus_1');
    expect(result.type).toBe('payment.failed');
  });

  it('customer.subscription.updated: subscriptionRef=sub.id, customerRef=sub.customer', () => {
    const event = {
      id: 'evt_sub_updated',
      type: 'customer.subscription.updated',
      created: NOW,
      data: { object: { id: 'sub_1', customer: 'cus_1' } },
    } as unknown as Stripe.Event;
    const result = toNormalizedEvent(event);
    expect(result.subscriptionRef).toBe('sub_1');
    expect(result.customerRef).toBe('cus_1');
    expect(result.type).toBe('subscription.updated');
  });

  it('customer.subscription.deleted -> subscription.canceled with subscriptionRef/customerRef populated', () => {
    const event = {
      id: 'evt_sub_deleted',
      type: 'customer.subscription.deleted',
      created: NOW,
      data: { object: { id: 'sub_1', customer: 'cus_1' } },
    } as unknown as Stripe.Event;
    const result = toNormalizedEvent(event);
    expect(result.type).toBe('subscription.canceled');
  });

  it('[EC:D4] charge.refunded: paymentRef=charge.payment_intent, amount=amount_refunded', () => {
    const event = {
      id: 'evt_refund_1',
      type: 'charge.refunded',
      created: NOW,
      data: { object: { payment_intent: 'pi_1', customer: 'cus_1', amount_refunded: 2000, currency: 'krw' } },
    } as unknown as Stripe.Event;
    const result = toNormalizedEvent(event);
    expect(result.type).toBe('unknown');
    expect(result.refundRef).toBeNull();
    expect(result.paymentRef).toBe('pi_1');
    expect(result.amount).toEqual({ amountMinor: 2000, currency: 'KRW' });
  });

  it('charge.dispute.created: paymentRef=dispute.payment_intent, amount=dispute.amount (fixture from ts/examples/smoke.ts)', () => {
    const event = {
      id: 'evt_test_dispute',
      type: 'charge.dispute.created',
      created: NOW,
      data: { object: { payment_intent: 'pi_test_2', amount: 3000, currency: 'krw' } },
    } as unknown as Stripe.Event;
    const result = toNormalizedEvent(event);
    expect(result.type).toBe('dispute.opened');
    expect(result.paymentRef).toBe('pi_test_2');
    expect(result.amount).toEqual({ amountMinor: 3000, currency: 'KRW' });
  });

  it('charge.dispute.closed -> dispute.closed (final on_lost verdict left to cs module per D9)', () => {
    const event = {
      id: 'evt_dispute_closed',
      type: 'charge.dispute.closed',
      created: NOW,
      data: { object: { payment_intent: 'pi_1', amount: 3000, currency: 'krw', status: 'lost' } },
    } as unknown as Stripe.Event;
    expect(toNormalizedEvent(event).type).toBe('dispute.closed');
  });

  it('unhandled event type -> unknown with all refs null and raw preserved', () => {
    const event = { id: 'evt_unknown', type: 'customer.created', created: NOW, data: { object: { id: 'cus_1' } } } as unknown as Stripe.Event;
    const result = toNormalizedEvent(event);
    expect(result.type).toBe('unknown');
    expect(result.customerRef).toBeNull();
    expect(result.subscriptionRef).toBeNull();
    expect(result.paymentRef).toBeNull();
    expect(result.amount).toBeNull();
    expect(result.raw).toBe(event);
  });
});
