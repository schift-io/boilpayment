// HTTP-calling StripeProvider methods, driven entirely through `installHttpMock` (see
// test/helpers/mockHttp.ts) — StripeProvider is constructed with `apiBase: { host, port,
// protocol: 'http' }` pointing at a fake host, and `test/helpers/mockHttp.ts` replaces Node's
// `http.request` for the duration of each test so no real socket is ever opened. This is the seam
// the Stripe SDK's own NodeHttpClient documents as monkey-patchable (see comment in that helper).
// Every assertion checks the exact method/path/Authorization header/Idempotency-Key
// header/body the spec (packages/providers/stripe/spec/stripe.pseudo.md "엔드포인트 매핑") requires.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PaymentKitError } from 'boilpayment-core';
import type { CreateCheckoutInput, Plan, PlanPrice } from 'boilpayment-core';
import { StripeProvider } from '../src/index.js';
import { installHttpMock, type HttpMock } from './helpers/mockHttp.js';

const SECRET_KEY = 'sk_test_dummy_secret';
const HOST = '127.0.0.1';
const PORT = 8931;

function makeProvider(): StripeProvider {
  return new StripeProvider({
    secretKey: SECRET_KEY,
    webhookSecret: 'whsec_unused_in_these_tests',
    apiBase: { host: HOST, port: PORT, protocol: 'http' },
  });
}

function authHeader(req: { headers: Record<string, unknown> }): string | undefined {
  const h = req.headers['authorization'] ?? req.headers['Authorization'];
  return typeof h === 'string' ? h : undefined;
}

let mock: HttpMock;
beforeEach(() => {
  mock = installHttpMock();
});
afterEach(() => {
  mock.restore();
});

function plan(): Plan {
  return { id: 'plan_pro', name: 'Pro', interval: 'month', creditsPerPeriod: 1000, usageIncluded: 0, trialDays: 0, prices: [] };
}
function price(providerRef: string | undefined): PlanPrice {
  return { currency: 'KRW', amountMinor: 9900, providerPriceRefs: providerRef ? { stripe: providerRef } : undefined };
}
function checkoutInput(overrides: Partial<CreateCheckoutInput> = {}): CreateCheckoutInput {
  return {
    customerRef: 'cus_test_1',
    plan: plan(),
    price: price('price_stripe_pro_monthly'),
    mode: 'subscription',
    successUrl: 'https://app.example.com/success',
    cancelUrl: 'https://app.example.com/cancel',
    idempotencyKey: 'checkout:cus_test_1:plan_pro:1700000000',
    ...overrides,
  };
}

describe('[EC:F(Stripe)] createCustomer', () => {
  it('sends POST /v1/customers with Bearer auth and email/name/metadata body, returns {ref}', async () => {
    mock.respondJson(200, { id: 'cus_new_1', object: 'customer', email: 'a@b.com' });
    const provider = makeProvider();

    const result = await provider.createCustomer({ email: 'a@b.com', name: 'Alice', metadata: { source: 'signup' } });

    expect(result).toEqual({ ref: 'cus_new_1' });
    expect(mock.requests).toHaveLength(1);
    const req = mock.requests[0];
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/v1/customers');
    expect(authHeader(req)).toBe(`Bearer ${SECRET_KEY}`);
    expect(req.body).toContain('email=a%40b.com');
    expect(req.body).toContain('name=Alice');
    expect(req.body).toContain('metadata[source]=signup');
  });
});

describe('[EC:E6] createCheckout', () => {
  it('mode=subscription: POST /v1/checkout/sessions with Idempotency-Key = input.idempotencyKey and subscription_data.metadata mirrored', async () => {
    mock.respondJson(200, { id: 'cs_1', object: 'checkout.session', url: 'https://checkout.stripe.com/cs_1' });
    const provider = makeProvider();

    const result = await provider.createCheckout(checkoutInput({ metadata: { checkoutEntitlementKey: "intent_immutable" } }));

    expect(result).toEqual({ id: 'cs_1', url: 'https://checkout.stripe.com/cs_1', providerRef: 'cs_1' });
    const req = mock.requests[0];
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/v1/checkout/sessions');
    expect(req.headers['Idempotency-Key']).toBe('checkout:cus_test_1:plan_pro:1700000000');
    expect(req.body).toContain('mode=subscription');
    expect(req.body).toContain('client_reference_id=cus_test_1');
    expect(new URLSearchParams(req.body).get('customer')).toBe('cus_test_1');
    expect(req.body).toContain('line_items[0][price]=price_stripe_pro_monthly');
    expect(req.body).toContain('line_items[0][quantity]=1');
    expect(req.body).toContain('metadata[planId]=plan_pro');
    expect(req.body).toContain('subscription_data[metadata][planId]=plan_pro');
    expect(req.body).toContain('subscription_data[metadata][checkoutEntitlementKey]=intent_immutable');
  });

  it('mode=one_time: mode="payment" in body, no subscription_data key sent', async () => {
    mock.respondJson(200, { id: 'cs_2', object: 'checkout.session', url: 'https://checkout.stripe.com/cs_2' });
    const provider = makeProvider();

    await provider.createCheckout(checkoutInput({ mode: 'one_time', metadata: { checkoutEntitlementKey: 'intent_immutable' } }));

    const req = mock.requests[0];
    expect(req.body).toContain('mode=payment');
    expect(req.body).toContain('payment_intent_data[metadata][checkoutEntitlementKey]=intent_immutable');
    expect(req.body).not.toContain('subscription_data');
  });

  it('[EC:F(Stripe)] missing price.providerPriceRefs.stripe throws PaymentKitError(missing_provider_price_ref) BEFORE any HTTP call', async () => {
    const provider = makeProvider();

    await expect(provider.createCheckout(checkoutInput({ price: price(undefined) }))).rejects.toMatchObject({
      code: 'missing_provider_price_ref',
    });
    expect(mock.requests).toHaveLength(0);
  });

  it('missing price ref rejects with a PaymentKitError instance', async () => {
    const provider = makeProvider();
    await expect(provider.createCheckout(checkoutInput({ price: price(undefined) }))).rejects.toBeInstanceOf(PaymentKitError);
  });
});

describe('[EC:E7] getPayment', () => {
  it('providerRef starting with pi_ -> GET /v1/payment_intents/{ref}?expand[0]=invoice', async () => {
    mock.respondJson(200, { id: 'pi_1', object: 'payment_intent', amount: 10000, currency: 'krw', status: 'succeeded', created: 1700000000, last_payment_error: null, invoice: null });
    const provider = makeProvider();

    const payment = await provider.getPayment('pi_1');

    expect(payment.id).toBe('pi_1');
    expect(payment.status).toBe('succeeded');
    expect(payment.kind).toBe('topup');
    const req = mock.requests[0];
    expect(req.method).toBe('GET');
    expect(req.path).toBe('/v1/payment_intents/pi_1?expand[0]=invoice');
    expect(authHeader(req)).toBe(`Bearer ${SECRET_KEY}`);
  });

  it('[EC:F(Stripe)] providerRef starting with in_ -> GET /v1/invoices/{ref} (NO expand param, per API >= 2025-03-31 guard), then GET /v1/payment_intents/{piRef}', async () => {
    mock.respondJson(200, {
      id: 'in_1',
      object: 'invoice',
      subscription: 'sub_1',
      amount_paid: 5000,
      amount_due: 5000,
      currency: 'krw',
      status: 'paid',
      created: 1700000000,
      payment_intent: 'pi_from_invoice',
      lines: { data: [] },
    });
    mock.respondJson(200, { id: 'pi_from_invoice', object: 'payment_intent', amount: 5000, currency: 'krw', status: 'succeeded', created: 1700000000, last_payment_error: null });
    const provider = makeProvider();

    const payment = await provider.getPayment('in_1');

    expect(payment.kind).toBe('subscription');
    expect(mock.requests).toHaveLength(2);
    expect(mock.requests[0].method).toBe('GET');
    expect(mock.requests[0].path).toBe('/v1/invoices/in_1');
    expect(mock.requests[1].method).toBe('GET');
    expect(mock.requests[1].path).toBe('/v1/payment_intents/pi_from_invoice');
  });

  it('providerRef starting with in_ and no payment_intent on the invoice -> only one GET call, no second lookup', async () => {
    mock.respondJson(200, {
      id: 'in_2',
      object: 'invoice',
      subscription: null,
      amount_paid: 0,
      amount_due: 5000,
      currency: 'krw',
      status: 'open',
      created: 1700000000,
      lines: { data: [] },
    });
    const provider = makeProvider();

    const payment = await provider.getPayment('in_2');

    expect(payment.status).toBe('pending');
    expect(mock.requests).toHaveLength(1);
  });
});

describe('[EC:H4 E1] listPayments — dedup invoices vs bare payment intents', () => {
  it('sends GET /v1/invoices and GET /v1/payment_intents with customer + created[gte], excludes a PaymentIntent already covered by an invoice', async () => {
    const since = new Date('2024-01-01T00:00:00Z');
    mock.respondJson(200, {
      object: 'list',
      data: [
        {
          id: 'in_1',
          subscription: 'sub_1',
          amount_paid: 5000,
          amount_due: 5000,
          currency: 'krw',
          status: 'paid',
          created: 1700000000,
          payment_intent: 'pi_covered',
          lines: { data: [] },
        },
      ],
    });
    mock.respondJson(200, {
      object: 'list',
      data: [
        { id: 'pi_covered', amount: 5000, currency: 'krw', status: 'succeeded', created: 1700000000, last_payment_error: null, invoice: null },
        { id: 'pi_standalone', amount: 2000, currency: 'krw', status: 'succeeded', created: 1700000100, last_payment_error: null, invoice: null },
      ],
    });
    const provider = makeProvider();

    const payments = await provider.listPayments({ customerRef: 'cus_1', since });

    const ids = payments.map((p) => p.id);
    expect(ids).toContain('in_1');
    expect(ids).toContain('pi_standalone');
    expect(ids).not.toContain('pi_covered'); // dedup: already represented by in_1
    expect(payments).toHaveLength(2);

    const gte = Math.floor(since.getTime() / 1000);
    expect(mock.requests[0].method).toBe('GET');
    expect(mock.requests[0].path).toBe(`/v1/invoices?customer=cus_1&created[gte]=${gte}`);
    expect(mock.requests[1].method).toBe('GET');
    expect(mock.requests[1].path).toBe(`/v1/payment_intents?customer=cus_1&created[gte]=${gte}`);
  });
});

describe('[EC:E3] getSubscription', () => {
  it('sends GET /v1/subscriptions/{ref} and returns the normalized subscription', async () => {
    mock.respondJson(200, {
      id: 'sub_1',
      object: 'subscription',
      customer: 'cus_1',
      status: 'active',
      current_period_start: 1700000000,
      current_period_end: 1702592000,
      billing_cycle_anchor: 1700000000,
      cancel_at_period_end: false,
      created: 1700000000,
      metadata: { customerId: 'internal_cust_1', planId: 'plan_pro', subscriptionId: 'internal_sub_1' },
    });
    const provider = makeProvider();

    const sub = await provider.getSubscription('sub_1');

    expect(sub.id).toBe('internal_sub_1');
    expect(sub.status).toBe('active');
    const req = mock.requests[0];
    expect(req.method).toBe('GET');
    expect(req.path).toBe('/v1/subscriptions/sub_1');
  });
});

function subFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub_1',
    object: 'subscription',
    customer: 'cus_1',
    status: 'active',
    current_period_start: 1700000000,
    current_period_end: 1702592000,
    billing_cycle_anchor: 1700000000,
    cancel_at_period_end: false,
    created: 1700000000,
    metadata: {},
    items: { data: [{ id: 'si_1', price: { id: 'price_old' } }] },
    ...overrides,
  };
}

describe('[EC:A1] changeSubscription — proration + billing_cycle_anchor reset', () => {
  it('[EC:A1] immediate_prorate_reset_anchor: retrieve then update with proration_behavior=create_prorations and billing_cycle_anchor=now', async () => {
    mock.respondJson(200, subFixture());
    mock.respondJson(200, subFixture({ billing_cycle_anchor: 1700050000 }));
    const provider = makeProvider();

    await provider.changeSubscription('sub_1', { newPriceRef: 'price_new', proration: 'immediate', resetAnchor: true });

    expect(mock.requests).toHaveLength(2);
    expect(mock.requests[0].method).toBe('GET');
    expect(mock.requests[0].path).toBe('/v1/subscriptions/sub_1');
    const updateReq = mock.requests[1];
    expect(updateReq.method).toBe('POST');
    expect(updateReq.path).toBe('/v1/subscriptions/sub_1');
    expect(updateReq.body).toContain('items[0][id]=si_1');
    expect(updateReq.body).toContain('items[0][price]=price_new');
    expect(updateReq.body).toContain('proration_behavior=create_prorations');
    expect(updateReq.body).toContain('billing_cycle_anchor=now');
  });

  it('[EC:A1] keep_anchor: proration=none, resetAnchor=false -> proration_behavior=none and NO billing_cycle_anchor key sent at all', async () => {
    mock.respondJson(200, subFixture());
    mock.respondJson(200, subFixture());
    const provider = makeProvider();

    await provider.changeSubscription('sub_1', { newPriceRef: 'price_new', proration: 'none', resetAnchor: false });

    const updateReq = mock.requests[1];
    expect(updateReq.body).toContain('proration_behavior=none');
    expect(updateReq.body).not.toContain('billing_cycle_anchor');
  });

  it('uses the id of the FIRST subscription item (items.data[0].id) for the update, not a hardcoded value', async () => {
    mock.respondJson(200, subFixture({ items: { data: [{ id: 'si_specific_7', price: { id: 'price_old' } }] } }));
    mock.respondJson(200, subFixture());
    const provider = makeProvider();

    await provider.changeSubscription('sub_1', { newPriceRef: 'price_new', proration: 'none', resetAnchor: false });

    expect(mock.requests[1].body).toContain('items[0][id]=si_specific_7');
  });
});

describe('[EC:A5] cancelSubscription', () => {
  it('atPeriodEnd=true -> POST /v1/subscriptions/{ref} with cancel_at_period_end=true (no DELETE)', async () => {
    mock.respondJson(200, subFixture({ cancel_at_period_end: true }));
    const provider = makeProvider();

    const sub = await provider.cancelSubscription('sub_1', { atPeriodEnd: true });

    expect(sub.cancelAtPeriodEnd).toBe(true);
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0].method).toBe('POST');
    expect(mock.requests[0].path).toBe('/v1/subscriptions/sub_1');
    expect(mock.requests[0].body).toBe('cancel_at_period_end=true');
  });

  it('atPeriodEnd=false -> DELETE /v1/subscriptions/{ref}', async () => {
    mock.respondJson(200, subFixture({ status: 'canceled' }));
    const provider = makeProvider();

    const sub = await provider.cancelSubscription('sub_1', { atPeriodEnd: false });

    expect(sub.status).toBe('canceled');
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0].method).toBe('DELETE');
    expect(mock.requests[0].path).toBe('/v1/subscriptions/sub_1');
  });
});

describe('[EC:A23] uncancelSubscription', () => {
  it('pending cancellation (status=active, cancel_at_period_end=true) -> GET retrieve then POST update cancel_at_period_end=false', async () => {
    mock.respondJson(200, subFixture({ status: 'active', cancel_at_period_end: true }));
    mock.respondJson(200, subFixture({ status: 'active', cancel_at_period_end: false }));
    const provider = makeProvider();

    const sub = await provider.uncancelSubscription('sub_1');

    expect(sub.cancelAtPeriodEnd).toBe(false);
    expect(mock.requests).toHaveLength(2);
    expect(mock.requests[0].method).toBe('GET');
    expect(mock.requests[0].path).toBe('/v1/subscriptions/sub_1');
    expect(mock.requests[1].method).toBe('POST');
    expect(mock.requests[1].path).toBe('/v1/subscriptions/sub_1');
    expect(mock.requests[1].body).toBe('cancel_at_period_end=false');
  });

  it('already fully canceled (status=canceled) -> throws not_reactivatable with the real Stripe status, no update call made', async () => {
    mock.respondJson(200, subFixture({ status: 'canceled' }));
    const provider = makeProvider();

    await expect(provider.uncancelSubscription('sub_1')).rejects.toMatchObject({ code: 'not_reactivatable' });
    // only the GET retrieve happened — no POST update was attempted against an already-dead subscription.
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0].method).toBe('GET');
  });
});

describe('chargeBillingKey — unsupported for Stripe (native subscriptions)', () => {
  it('throws PaymentKitError("unsupported") without making any HTTP call', async () => {
    const provider = makeProvider();
    await expect(provider.chargeBillingKey()).rejects.toMatchObject({ code: 'unsupported' });
    expect(mock.requests).toHaveLength(0);
  });
});

describe('[EC:D4 D6] refund', () => {
  it('paymentRef=pi_...: POST /v1/refunds directly, with Idempotency-Key header and amount/reason mapped', async () => {
    mock.respondJson(200, { id: 're_1', object: 'refund', amount: 3000, currency: 'krw', status: 'succeeded', created: 1700000000, payment_intent: 'pi_1', reason: null });
    const provider = makeProvider();

    const refund = await provider.refund({ paymentRef: 'pi_1', amount: { amountMinor: 3000, currency: 'KRW' }, reason: 'duplicate', idempotencyKey: 'refund:pi_1:1' });

    expect(refund.id).toBe('re_1');
    expect(mock.requests).toHaveLength(1);
    const req = mock.requests[0];
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/v1/refunds');
    expect(req.headers['Idempotency-Key']).toBe('refund:pi_1:1');
    expect(req.body).toContain('payment_intent=pi_1');
    expect(req.body).toContain('amount=3000');
    expect(req.body).toContain('reason=duplicate');
  });

  it('reason mapping: "fraudulent" passes through, anything else maps to "requested_by_customer"', async () => {
    mock.respondJson(200, { id: 're_2', object: 'refund', amount: 1000, currency: 'krw', status: 'succeeded', created: 1700000000, payment_intent: 'pi_1', reason: null });
    mock.respondJson(200, { id: 're_3', object: 'refund', amount: 1000, currency: 'krw', status: 'succeeded', created: 1700000000, payment_intent: 'pi_1', reason: null });
    const provider = makeProvider();

    await provider.refund({ paymentRef: 'pi_1', amount: { amountMinor: 1000, currency: 'KRW' }, reason: 'fraudulent', idempotencyKey: 'k1' });
    await provider.refund({ paymentRef: 'pi_1', amount: { amountMinor: 1000, currency: 'KRW' }, reason: 'customer_changed_mind', idempotencyKey: 'k2' });

    expect(mock.requests[0].body).toContain('reason=fraudulent');
    expect(mock.requests[1].body).toContain('reason=requested_by_customer');
  });

  it('paymentRef=in_...: GET the invoice first to resolve the PaymentIntent ref, then POST /v1/refunds using it; customerId sourced from invoice.customer', async () => {
    mock.respondJson(200, {
      id: 'in_1',
      object: 'invoice',
      customer: 'cus_from_invoice',
      subscription: 'sub_1',
      amount_paid: 5000,
      amount_due: 5000,
      currency: 'krw',
      status: 'paid',
      created: 1700000000,
      payment_intent: 'pi_resolved',
      lines: { data: [] },
    });
    mock.respondJson(200, { id: 're_4', object: 'refund', amount: 5000, currency: 'krw', status: 'succeeded', created: 1700000000, payment_intent: 'pi_resolved', reason: null });
    const provider = makeProvider();

    const refund = await provider.refund({ paymentRef: 'in_1', amount: { amountMinor: 5000, currency: 'KRW' }, reason: 'requested_by_customer', idempotencyKey: 'refund:in_1:1' });

    expect(refund.customerId).toBe('cus_from_invoice');
    expect(mock.requests).toHaveLength(2);
    expect(mock.requests[0].method).toBe('GET');
    expect(mock.requests[0].path).toBe('/v1/invoices/in_1');
    expect(mock.requests[1].method).toBe('POST');
    expect(mock.requests[1].path).toBe('/v1/refunds');
    expect(mock.requests[1].body).toContain('payment_intent=pi_resolved');
  });

  it('paymentRef=in_... with an invoice that has no payment_intent -> PaymentKitError(provider_shape), no refund POST attempted', async () => {
    mock.respondJson(200, {
      id: 'in_no_pi',
      object: 'invoice',
      customer: 'cus_1',
      amount_paid: 0,
      amount_due: 5000,
      currency: 'krw',
      status: 'open',
      created: 1700000000,
      lines: { data: [] },
    });
    const provider = makeProvider();

    await expect(
      provider.refund({ paymentRef: 'in_no_pi', amount: { amountMinor: 5000, currency: 'KRW' }, reason: 'requested_by_customer', idempotencyKey: 'k' }),
    ).rejects.toMatchObject({ code: 'provider_shape' });
    expect(mock.requests).toHaveLength(1); // only the invoice GET, no refund POST
  });
});

describe('[EC:C4] reportUsage — Billing Meter Events', () => {
  it('sends POST /v1/billing/meter_events with event_name, payload[stripe_customer_id]/[value], identifier, timestamp', async () => {
    mock.respondJson(200, { object: 'billing.meter_event' });
    const provider = makeProvider();
    const occurredAt = new Date('2024-01-15T12:00:00Z');

    await provider.reportUsage({ meter: 'api_calls', customerRef: 'cus_1', quantity: 42, occurredAt, idempotencyKey: 'usage:evt:1' });

    expect(mock.requests).toHaveLength(1);
    const req = mock.requests[0];
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/v1/billing/meter_events');
    expect(req.body).toContain('event_name=api_calls');
    expect(req.body).toContain('payload[stripe_customer_id]=cus_1');
    expect(req.body).toContain('payload[value]=42');
    expect(req.body).toContain(`identifier=${encodeURIComponent('usage:evt:1')}`);
    expect(req.body).toContain(`timestamp=${Math.floor(occurredAt.getTime() / 1000)}`);
  });
});

describe('capabilities()', () => {
  it('matches spec: nativeSubscriptions/partialRefund/meters=true, scheduling=provider, webhookSignature=true', () => {
    const provider = makeProvider();
    expect(provider.capabilities()).toEqual({
      nativeSubscriptions: true,
      partialRefund: true,
      meters: true,
      scheduling: 'provider',
      webhookSignature: true,
    });
  });
});

it.each(['one_time', 'subscription'] as const)('checkout %s preserves the captured entitlement through payment retrieval', async (mode) => {
  mock.respondJson(200, { id: 'cs_entitlement', object: 'checkout.session', url: 'https://checkout.stripe.com/cs_entitlement' });
  const provider = makeProvider();
  await provider.createCheckout(checkoutInput({ mode, metadata: { checkoutEntitlementKey: 'intent_captured' } }));
  const request = mock.requests[0];
  const body = new URLSearchParams(request.body);
  const metadataPrefix = mode === 'one_time' ? 'payment_intent_data' : 'subscription_data';
  const key = body.get(`${metadataPrefix}[metadata][checkoutEntitlementKey]`);
  expect(key).toBe('intent_captured');
  const metadata = { checkoutEntitlementKey: key };
  const paymentRef = mode === 'one_time' ? 'pi_entitlement' : 'in_entitlement';
  mock.respondJson(200, mode === 'one_time'
    ? { id: paymentRef, object: 'payment_intent', amount: 9900, currency: 'krw', status: 'succeeded', created: 1735689600, metadata }
    : { id: paymentRef, object: 'invoice', amount_paid: 9900, amount_due: 9900, currency: 'krw', status: 'paid', created: 1735689600, metadata: {}, parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_entitlement', metadata } }, payments: { data: [] } });
  const payment = await provider.getPayment(paymentRef);
  expect(payment.raw).toMatchObject({ metadata: { checkoutEntitlementKey: 'intent_captured' } });
  expect(payment.subscriptionId).toBe(mode === 'subscription' ? 'sub_entitlement' : null);
});
