// Phase 6 regression tests — HTTP-calling PaymentProvider methods, driven through a stubbed
// global `fetch` (the DI seam PolarProvider actually uses — see `private request()` in
// ts/src/index.ts, which calls the bare `fetch()` global directly; there is no injectable
// `deps.http` seam in this implementation, so stubbing global fetch is the minimal seam).
// No real network call is made anywhere in this file.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PolarProvider } from '../src/index.js';
import { ProviderError, PaymentKitError } from 'boilpayment-core';
import type { Plan, PlanPrice } from 'boilpayment-core';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('[EC:F(Polar)] PolarProvider HTTP methods (fetch stubbed — no network)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const provider = new PolarProvider({ accessToken: 'polar_at_dummy', webhookSecret: 'whsec_c2VjcmV0', server: 'sandbox' });

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function lastCall() {
    const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit];
    return { url, init };
  }

  it('[EC:F(Polar)] createCustomer -> POST /v1/customers/ with Bearer auth and email/name/metadata body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'cust_abc' }));
    const result = await provider.createCustomer({ email: 'a@example.com', name: 'A', metadata: { foo: 'bar' } });
    expect(result).toEqual({ ref: 'cust_abc' });
    const { url, init } = lastCall();
    expect(url).toBe('https://sandbox-api.polar.sh/v1/customers/');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer polar_at_dummy');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ email: 'a@example.com', name: 'A', metadata: { foo: 'bar' } });
  });

  it('[EC:E6] createCheckout -> POST /v1/checkouts/ with products=[polar product ref], customer_id, metadata.planId, success_url, Idempotency-Key header', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'checkout_1', url: 'https://polar.sh/checkout/checkout_1' }));
    const price: PlanPrice = { currency: 'usd', amountMinor: 1000, providerPriceRefs: { polar: 'prod_polar_1' } };
    const plan: Plan = { id: 'plan_pro', name: 'Pro', interval: 'month', creditsPerPeriod: 1000, usageIncluded: 0, trialDays: 0, prices: [price] };
    const checkout = await provider.createCheckout({
      customerRef: 'cust_abc',
      plan,
      price,
      mode: 'subscription',
      successUrl: 'https://app.example.com/success',
      cancelUrl: 'https://app.example.com/cancel',
      idempotencyKey: 'checkout:cust_abc:plan_pro:0',
      metadata: { checkoutEntitlementKey: 'intent_immutable', extra: '1' },
    });
    expect(checkout).toEqual({ id: 'checkout_1', url: 'https://polar.sh/checkout/checkout_1', providerRef: 'checkout_1' });
    const { url, init } = lastCall();
    expect(url).toBe('https://sandbox-api.polar.sh/v1/checkouts/');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('checkout:cust_abc:plan_pro:0');
    expect(JSON.parse(init.body as string)).toEqual({
      products: ['prod_polar_1'],
      customer_id: 'cust_abc',
      metadata: { checkoutEntitlementKey: 'intent_immutable', extra: '1', planId: 'plan_pro' },
      success_url: 'https://app.example.com/success',
    });
  });

  it('[DC-01][AF-01] createCheckout forwards discount controls and affiliate metadata', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'checkout_discounted', url: 'https://polar.sh/checkout/checkout_discounted' }));
    const price: PlanPrice = { currency: 'usd', amountMinor: 1000, providerPriceRefs: { polar: 'prod_polar_1' } };
    const plan: Plan = { id: 'plan_pro', name: 'Pro', interval: 'month', creditsPerPeriod: 1000, usageIncluded: 0, trialDays: 0, prices: [price] };

    await provider.createCheckout({
      customerRef: 'cust_abc',
      plan,
      price,
      mode: 'subscription',
      successUrl: 'https://app.example.com/success',
      cancelUrl: 'https://app.example.com/cancel',
      idempotencyKey: 'checkout:discounted',
      allowDiscountCodes: true,
      presetDiscountCode: 'discount_20pct',
      affiliateId: 'affiliate_alpha',
    });

    expect(JSON.parse(lastCall().init.body as string)).toEqual({
      products: ['prod_polar_1'],
      customer_id: 'cust_abc',
      metadata: { planId: 'plan_pro', affiliateId: 'affiliate_alpha' },
      success_url: 'https://app.example.com/success',
      allow_discount_codes: true,
      discount_id: 'discount_20pct',
    });
  });

  it('[DC-06] exhausted discount refusal is definitive and returns no checkout', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'discount max redemptions reached' }, 422));
    const price: PlanPrice = { currency: 'usd', amountMinor: 1000, providerPriceRefs: { polar: 'prod_polar_1' } };
    const plan: Plan = { id: 'plan_pro', name: 'Pro', interval: null, creditsPerPeriod: 1000, usageIncluded: 0, trialDays: 0, prices: [price] };

    await expect(provider.createCheckout({
      customerRef: 'cust_abc', plan, price, mode: 'one_time',
      successUrl: 'https://app.example.com/success', cancelUrl: 'https://app.example.com/cancel',
      idempotencyKey: 'checkout:exhausted', presetDiscountCode: 'discount_exhausted',
    })).rejects.toMatchObject({ code: 'provider', httpStatus: 422 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('[EC:F(Polar)] createCheckout -> missing providerPriceRefs.polar throws PaymentKitError(missing_provider_price_ref) without calling fetch', async () => {
    const price: PlanPrice = { currency: 'usd', amountMinor: 1000 };
    const plan: Plan = { id: 'plan_pro', name: 'Pro', interval: 'month', creditsPerPeriod: 1000, usageIncluded: 0, trialDays: 0, prices: [price] };
    await expect(
      provider.createCheckout({
        customerRef: 'cust_abc',
        plan,
        price,
        mode: 'subscription',
        successUrl: 'https://app.example.com/success',
        cancelUrl: 'https://app.example.com/cancel',
        idempotencyKey: 'k1',
      }),
    ).rejects.toMatchObject({
      code: 'missing_provider_price_ref',
      message: 'set plan_prices.provider_price_refs for plan plan_pro / usd (see docs/GUIDE.md)',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('[EC:E7][EC:E12] getPayment -> GET /v1/orders/{ref}, normalizes response through normalizeOrder', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: 'order_1', metadata: { checkoutEntitlementKey: 'intent_immutable' }, customer_id: 'cust_abc', total_amount: 1000, currency: 'usd', status: 'paid', paid: true, created_at: '2024-01-01T00:00:00.000Z' }),
    );
    const payment = await provider.getPayment('order_1');
    expect(payment.status).toBe('succeeded');
    expect(payment.providerRef).toBe('order_1');
    expect(payment.raw).toMatchObject({ metadata: { checkoutEntitlementKey: 'intent_immutable' } });
    const { url, init } = lastCall();
    expect(url).toBe('https://sandbox-api.polar.sh/v1/orders/order_1');
    expect(init.method).toBe('GET');
  });

  it('[EC:H4][EC:E1] listPayments -> GET /v1/orders/?customer_id=...&limit=100, filters client-side by since', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        items: [
          { id: 'order_old', customer_id: 'cust_abc', total_amount: 100, currency: 'usd', status: 'paid', paid: true, created_at: '2023-01-01T00:00:00.000Z' },
          { id: 'order_new', customer_id: 'cust_abc', total_amount: 200, currency: 'usd', status: 'paid', paid: true, created_at: '2024-06-01T00:00:00.000Z' },
        ],
      }),
    );
    const since = new Date('2024-01-01T00:00:00.000Z');
    const payments = await provider.listPayments({ customerRef: 'cust_abc', since });
    expect(payments.map((p) => p.providerRef)).toEqual(['order_new']);
    const { url, init } = lastCall();
    expect(url).toBe('https://sandbox-api.polar.sh/v1/orders/?customer_id=cust_abc&limit=100');
    expect(init.method).toBe('GET');
  });

  it('[EC:E3] getSubscription -> GET /v1/subscriptions/{ref}', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: 'sub_1', customer_id: 'cust_abc', status: 'active', current_period_start: '2024-01-01T00:00:00.000Z', current_period_end: '2024-01-31T00:00:00.000Z', cancel_at_period_end: false, created_at: '2024-01-01T00:00:00.000Z' }),
    );
    const sub = await provider.getSubscription('sub_1');
    expect(sub.status).toBe('active');
    const { url, init } = lastCall();
    expect(url).toBe('https://sandbox-api.polar.sh/v1/subscriptions/sub_1');
    expect(init.method).toBe('GET');
  });

  it('[EC:A1] changeSubscription(proration=immediate) -> PATCH /v1/subscriptions/{ref} {product_id, proration_behavior:"invoice"} (EC:A77); resetAnchor ignored', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: 'sub_1', customer_id: 'cust_abc', status: 'active', current_period_start: '2024-01-01T00:00:00.000Z', current_period_end: '2024-01-31T00:00:00.000Z', cancel_at_period_end: false, created_at: '2024-01-01T00:00:00.000Z' }),
    );
    await provider.changeSubscription('sub_1', { newPriceRef: 'prod_new', proration: 'immediate', resetAnchor: true });
    const { url, init } = lastCall();
    expect(url).toBe('https://sandbox-api.polar.sh/v1/subscriptions/sub_1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ product_id: 'prod_new', proration_behavior: 'invoice' });
  });

  it('[EC:A1] changeSubscription(proration=none) -> proration_behavior:"next_period"', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: 'sub_1', customer_id: 'cust_abc', status: 'active', current_period_start: '2024-01-01T00:00:00.000Z', current_period_end: '2024-01-31T00:00:00.000Z', cancel_at_period_end: false, created_at: '2024-01-01T00:00:00.000Z' }),
    );
    await provider.changeSubscription('sub_1', { newPriceRef: 'prod_new', proration: 'none', resetAnchor: false });
    const { init } = lastCall();
    expect(JSON.parse(init.body as string)).toEqual({ product_id: 'prod_new', proration_behavior: 'next_period' });
  });

  it('[EC:A5] cancelSubscription(atPeriodEnd=true) -> PATCH {cancel_at_period_end:true}', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: 'sub_1', customer_id: 'cust_abc', status: 'active', current_period_start: '2024-01-01T00:00:00.000Z', current_period_end: '2024-01-31T00:00:00.000Z', cancel_at_period_end: true, created_at: '2024-01-01T00:00:00.000Z' }),
    );
    await provider.cancelSubscription('sub_1', { atPeriodEnd: true });
    const { url, init } = lastCall();
    expect(url).toBe('https://sandbox-api.polar.sh/v1/subscriptions/sub_1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ cancel_at_period_end: true });
  });

  it('[EC:A5] cancelSubscription(atPeriodEnd=false) -> DELETE /v1/subscriptions/{ref}, no body', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: 'sub_1', customer_id: 'cust_abc', status: 'canceled', current_period_start: '2024-01-01T00:00:00.000Z', current_period_end: '2024-01-31T00:00:00.000Z', cancel_at_period_end: false, created_at: '2024-01-01T00:00:00.000Z' }),
    );
    await provider.cancelSubscription('sub_1', { atPeriodEnd: false });
    const { url, init } = lastCall();
    expect(url).toBe('https://sandbox-api.polar.sh/v1/subscriptions/sub_1');
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
  });

  it('[EC:A23] uncancelSubscription — pending cancellation -> GET then PATCH {cancel_at_period_end:false}', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: 'sub_1', customer_id: 'cust_abc', status: 'active', current_period_start: '2024-01-01T00:00:00.000Z', current_period_end: '2024-01-31T00:00:00.000Z', cancel_at_period_end: true, created_at: '2024-01-01T00:00:00.000Z' }),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: 'sub_1', customer_id: 'cust_abc', status: 'active', current_period_start: '2024-01-01T00:00:00.000Z', current_period_end: '2024-01-31T00:00:00.000Z', cancel_at_period_end: false, created_at: '2024-01-01T00:00:00.000Z' }),
    );
    const sub = await provider.uncancelSubscription('sub_1');
    expect(sub.cancelAtPeriodEnd).toBe(false);
    expect(fetchMock.mock.calls).toHaveLength(2);
    const firstInit = fetchMock.mock.calls[0][1] as RequestInit;
    expect(firstInit.method).toBe('GET');
    const { url, init } = lastCall();
    expect(url).toBe('https://sandbox-api.polar.sh/v1/subscriptions/sub_1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ cancel_at_period_end: false });
  });

  it('[EC:A23] uncancelSubscription — already canceled -> throws not_reactivatable, no PATCH attempted', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: 'sub_1', customer_id: 'cust_abc', status: 'canceled', current_period_start: '2024-01-01T00:00:00.000Z', current_period_end: '2024-01-31T00:00:00.000Z', cancel_at_period_end: false, created_at: '2024-01-01T00:00:00.000Z' }),
    );
    await expect(provider.uncancelSubscription('sub_1')).rejects.toMatchObject({ code: 'not_reactivatable' });
    expect(fetchMock.mock.calls).toHaveLength(1);
    const { init } = lastCall();
    expect(init.method).toBe('GET');
  });

  it('[EC:D4][EC:D6] refund -> POST /v1/refunds/ {order_id, amount, reason} with reason mapping (fraudulent passthrough)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: 'refund_1', order_id: 'order_1', customer_id: 'cust_abc', amount: 500, currency: 'usd', status: 'succeeded', reason: 'fraudulent', created_at: '2024-01-01T00:00:00.000Z' }),
    );
    const refund = await provider.refund({ paymentRef: 'order_1', amount: { amountMinor: 500, currency: 'USD' }, reason: 'fraudulent', idempotencyKey: 'refund:order_1' });
    expect(refund.status).toBe('succeeded');
    const { url, init } = lastCall();
    expect(url).toBe('https://sandbox-api.polar.sh/v1/refunds/');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ order_id: 'order_1', amount: 500, reason: 'fraudulent' });
  });

  it('[EC:D4] refund -> unrecognized reason falls back to customer_request', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: 'refund_2', order_id: 'order_1', customer_id: 'cust_abc', amount: 500, currency: 'usd', status: 'succeeded', reason: 'customer_request', created_at: '2024-01-01T00:00:00.000Z' }),
    );
    await provider.refund({ paymentRef: 'order_1', amount: { amountMinor: 500, currency: 'USD' }, reason: 'requested_by_customer', idempotencyKey: 'refund:order_1' });
    const { init } = lastCall();
    expect(JSON.parse(init.body as string).reason).toBe('customer_request');
  });

  it('[EC:C4] reportUsage -> POST /v1/events/ingest with events[0]={name, customer_id, timestamp (ISO), external_id, metadata.value}', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const occurredAt = new Date('2024-01-01T12:00:00.000Z');
    await provider.reportUsage({ meter: 'api_calls', customerRef: 'cust_abc', quantity: 42, occurredAt, idempotencyKey: 'usage:cust_abc:2024-01-01' });
    const { url, init } = lastCall();
    expect(url).toBe('https://sandbox-api.polar.sh/v1/events/ingest');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      events: [
        {
          name: 'api_calls',
          customer_id: 'cust_abc',
          timestamp: '2024-01-01T12:00:00.000Z',
          external_id: 'usage:cust_abc:2024-01-01',
          metadata: { value: 42 },
        },
      ],
    });
  });

  it('[EC:E12] non-2xx response -> ProviderError with normalized failure (code=unknown, retryable=true)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('insufficient permissions', { status: 403 }));
    await expect(provider.getPayment('order_x')).rejects.toBeInstanceOf(ProviderError);
    fetchMock.mockResolvedValueOnce(new Response('insufficient permissions', { status: 403 }));
    await expect(provider.getPayment('order_x')).rejects.toMatchObject({ failure: { code: 'unknown', retryable: true } });
  });

  it('[EC:F(Polar)] chargeBillingKey -> unsupported for native-subscription provider, no fetch call', async () => {
    await expect(provider.chargeBillingKey()).rejects.toBeInstanceOf(PaymentKitError);
    await expect(provider.chargeBillingKey()).rejects.toMatchObject({ code: 'unsupported' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
