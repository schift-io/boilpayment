#!/usr/bin/env node
// Dependency-free mock of the Polar REST API surface that PolarProvider
// (packages/providers/polar/{ts,py}/src) calls directly over fetch/httpx — no @polar-sh/sdk,
// no keys, no network. Response shapes verified against docs.polar.sh (fetched 2026-09-09,
// current site is polar.sh/docs — docs.polar.sh 301-redirects there) for:
//   - POST   /v1/customers/                 (api-reference/customers/create)
//   - POST   /v1/checkouts/          (api-reference/checkouts/create-session — response
//                                             shape is the shared Checkout object)
//   - GET    /v1/orders/{id}                (api-reference/orders/get)
//   - GET    /v1/orders/?customer_id=...    (api-reference/orders/list)
//   - GET    /v1/subscriptions/{id}         (api-reference/subscriptions/get)
//   - PATCH  /v1/subscriptions/{id}         (api-reference/subscriptions/update)
//   - DELETE /v1/subscriptions/{id}         (api-reference/subscriptions/revoke)
//   - POST   /v1/refunds/                   (api-reference/refunds/create)
//   - POST   /v1/events/ingest              (api-reference/events/ingest)
//   - webhook payload types                 (integrate/webhooks/events)
//
// SIMPLIFICATION (documented, not a Polar API behavior): real Polar checkouts are completed on
// Polar's own hosted page — there is no REST call that "completes" one. Since this mock is
// API-only, POST /v1/checkouts/ immediately synthesizes the resulting Order (status=paid)
// and, for a subscription product, the Subscription too, rather than leaving the checkout 'open'.
// This lets getPayment/listPayments/getSubscription have something real to read without a second,
// fictitious "complete checkout" endpoint that doesn't exist in the real API surface. The checkout
// response itself reports status:'succeeded' to reflect this (real Polar would say 'open').
//
// Two fixed subscription products and one fixed one-time product are pre-seeded so callers don't
// need a products-create endpoint (Polar's real API needs the dashboard/API to create products
// ahead of time too — out of scope for "provider calls" this mock serves):
//   prod_sub_basic    — Basic Monthly, 2900 usd/month
//   prod_sub_pro      — Pro Monthly,   4900 usd/month   (upgrade target for changeSubscription)
//   prod_onetime_pack — Credits Pack,   999 usd, one-time
//
// Auth: Authorization: Bearer polar_oat_test_... required on all /v1/* routes, else 401.
// State: in-memory, reset on restart.
//
// Usage:
//   POLAR_MOCK_PORT=12213 node tools/mocks/polar/server.mjs &
//   curl -H 'Authorization: Bearer polar_oat_test_x' http://127.0.0.1:12213/v1/customers/ -d '{"email":"a@b.c"}'
//
// Control endpoint (not part of the Polar API — for driving webhook round trips in tests):
//   POST /__mock/webhook  { url, secret, type: 'order.paid'|'order.created'|'order.refunded'|
//                            'subscription.created'|'subscription.updated'|'subscription.canceled'|
//                            'subscription.revoked'|'subscription.past_due'|'refund.created'|'refund.updated',
//                            id }   // order id, subscription id, or refund id, matching `type`'s entity
//   -> POSTs a Standard Webhooks-signed envelope { type, data, timestamp } to `url`, signed with
//      `secret` (whsec_... form, same algorithm as PolarProvider.verifyWebhook / verify_webhook).
//      Responds { delivered: bool, status?: number, error?: string, eventId }.

import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.env.POLAR_MOCK_PORT || 12213);

// ── fixed catalog ────────────────────────────────────────────────────────────
const PRODUCTS = {
  prod_sub_basic: { id: 'prod_sub_basic', name: 'Basic Monthly', amount: 2900, currency: 'usd', recurring: true, recurring_interval: 'month' },
  prod_sub_pro: { id: 'prod_sub_pro', name: 'Pro Monthly', amount: 4900, currency: 'usd', recurring: true, recurring_interval: 'month' },
  prod_onetime_pack: { id: 'prod_onetime_pack', name: 'Credits Pack', amount: 999, currency: 'usd', recurring: false, recurring_interval: null },
};

// ── in-memory state ──────────────────────────────────────────────────────────
const customers = new Map(); // id -> Customer
const checkouts = new Map(); // id -> Checkout
const orders = new Map(); // id -> Order
const subscriptions = new Map(); // id -> Subscription
const refunds = new Map(); // id -> Refund
const ingestedEventExternalIds = new Set(); // dedup key for events.ingest

function nowIso() {
  return new Date().toISOString();
}

function uuid() {
  return randomUUID();
}

function json(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': buf.length });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function requireAuth(req, res) {
  const auth = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/.exec(auth);
  if (!m || !m[1].startsWith('polar_oat_test_')) {
    json(res, 401, { error: 'invalid_token', detail: 'missing or non-test Bearer token (expected polar_oat_test_...)' });
    return false;
  }
  return true;
}

// ── entity builders (field names match docs.polar.sh examples) ──────────────

function buildCustomer({ email, name, metadata, external_id }) {
  const id = uuid();
  const c = {
    id,
    created_at: nowIso(),
    modified_at: nowIso(),
    metadata: metadata || {},
    external_id: external_id ?? null,
    email,
    email_verified: false,
    type: 'individual',
    name: name ?? null,
    billing_name: name ?? null,
    billing_address: null,
    tax_id: null,
    locale: 'en',
    organization_id: 'org_mock',
    default_payment_method_id: null,
    deleted_at: null,
    first_user_event_at: null,
    avatar_url: `https://www.gravatar.com/avatar/${id}?d=404`,
  };
  customers.set(id, c);
  return c;
}

function buildOrderForProduct({ product, customerId, subscriptionId, checkoutId }) {
  const id = uuid();
  const order = {
    id,
    created_at: nowIso(),
    modified_at: nowIso(),
    status: 'paid',
    paid: true,
    subtotal_amount: product.amount,
    discount_amount: 0,
    net_amount: product.amount,
    tax_amount: 0,
    total_amount: product.amount,
    applied_balance_amount: 0,
    due_amount: 0,
    refunded_amount: 0,
    refunded_tax_amount: 0,
    refundable_amount: product.amount,
    refundable_tax_amount: 0,
    currency: product.currency,
    billing_reason: subscriptionId ? 'subscription_create' : 'purchase',
    billing_name: null,
    billing_address: null,
    invoice_number: `INV-${id.slice(0, 8)}`,
    is_invoice_generated: true,
    receipt_number: `RCP-${id.slice(0, 8)}`,
    seats: null,
    units: null,
    customer_id: customerId,
    product_id: product.id,
    discount_id: null,
    subscription_id: subscriptionId ?? null,
    checkout_id: checkoutId ?? null,
    next_payment_attempt_at: null,
    metadata: {},
    custom_field_data: {},
    platform_fee_amount: Math.round(product.amount * 0.05),
    platform_fee_currency: product.currency,
    description: product.name,
    customer: null,
    product: null,
    discount: null,
    subscription: null,
    items: [
      { id: uuid(), created_at: nowIso(), modified_at: nowIso(), label: product.name, amount: product.amount, tax_amount: 0, proration: false, product_price_id: null },
    ],
  };
  orders.set(id, order);
  return order;
}

function buildSubscriptionForProduct({ product, customerId, checkoutId }) {
  const id = uuid();
  const start = new Date();
  const end = new Date(start.getTime());
  end.setUTCMonth(end.getUTCMonth() + 1);
  const sub = {
    id,
    created_at: start.toISOString(),
    modified_at: start.toISOString(),
    amount: product.amount,
    currency: product.currency,
    recurring_interval: product.recurring_interval,
    recurring_interval_count: 1,
    status: 'active',
    current_period_start: start.toISOString(),
    current_period_end: end.toISOString(),
    current_meter_period_start: null,
    current_meter_period_end: null,
    trial_start: null,
    trial_end: null,
    cancel_at_period_end: false,
    canceled_at: null,
    started_at: start.toISOString(),
    ends_at: null,
    ended_at: null,
    pause_at_period_end: false,
    paused_at: null,
    resumes_at: null,
    customer_id: customerId,
    product_id: product.id,
    discount_id: null,
    checkout_id: checkoutId ?? null,
    seats: null,
    units: null,
    customer_cancellation_reason: null,
    customer_cancellation_comment: null,
    metadata: {},
    custom_field_data: {},
    customer: null,
    product: null,
    discount: null,
    prices: [],
    meters: [],
    pending_update: null,
  };
  subscriptions.set(id, sub);
  return sub;
}

// ── Standard Webhooks signing (mirrors verifyStandardWebhookSignature in the provider) ──────────
function signStandardWebhook({ id, timestamp, rawBody, secret }) {
  const secretRaw = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  const key = Buffer.from(secretRaw, 'base64');
  const signedContent = `${id}.${timestamp}.${rawBody}`;
  const sig = createHmac('sha256', key).update(signedContent).digest('base64');
  return `v1,${sig}`;
}

async function deliverWebhook({ url, secret, type, data }) {
  const id = `msg_${uuid()}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const payload = { type, data, timestamp: new Date().toISOString() };
  const rawBody = JSON.stringify(payload);
  const signature = signStandardWebhook({ id, timestamp, rawBody, secret });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'webhook-id': id,
        'webhook-timestamp': timestamp,
        'webhook-signature': signature,
      },
      body: rawBody,
    });
    return { delivered: res.ok, status: res.status, eventId: id };
  } catch (err) {
    return { delivered: false, error: err instanceof Error ? err.message : String(err), eventId: id };
  }
}

// ── HTTP routing ─────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  } catch {
    return json(res, 400, { error: 'bad_request' });
  }
  const { pathname } = url;
  const method = req.method || 'GET';

  // -- control endpoint: not part of the Polar API, no auth required --
  if (method === 'POST' && pathname === '/__mock/webhook') {
    let body;
    try {
      body = await readBody(req);
    } catch {
      return json(res, 400, { error: 'invalid_json' });
    }
    const { url: targetUrl, secret, type, id } = body;
    if (!targetUrl || !secret || !type || !id) return json(res, 400, { error: 'missing url/secret/type/id' });
    let data = null;
    if (type.startsWith('order.')) data = orders.get(id);
    else if (type.startsWith('subscription.')) data = subscriptions.get(id);
    else if (type.startsWith('refund.')) data = refunds.get(id);
    if (!data) return json(res, 404, { error: 'entity_not_found', detail: `no local ${type} entity for id ${id}` });
    const result = await deliverWebhook({ url: targetUrl, secret, type, data });
    return json(res, 200, result);
  }

  // -- control endpoint: renew a subscription for one period (round-5 audit follow-up). Polar itself
  // charges the subscription at period end and emits order.paid with billing_reason 'subscription_cycle';
  // this moves the subscription's period forward one interval and creates that renewal order.
  //   POST /__mock/renew { subscription_id, status?: 'paid' | 'pending' } -> { order_id, period_start, period_end }
  if (method === 'POST' && pathname === '/__mock/renew') {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'invalid_json' }); }
    const sub = subscriptions.get(body.subscription_id);
    if (!sub) return json(res, 404, { error: 'entity_not_found', detail: `no subscription ${body.subscription_id}` });
    const product = PRODUCTS[sub.product_id];
    const start = new Date(sub.current_period_end);
    const end = new Date(start.getTime());
    if (product.recurring_interval === 'year') end.setUTCFullYear(end.getUTCFullYear() + 1); else end.setUTCMonth(end.getUTCMonth() + 1);
    sub.current_period_start = start.toISOString();
    sub.current_period_end = end.toISOString();
    sub.modified_at = nowIso();
    const order = buildOrderForProduct({ product, customerId: sub.customer_id, subscriptionId: sub.id, checkoutId: null });
    order.billing_reason = 'subscription_cycle';
    if (body.status === 'pending') { order.status = 'pending'; order.paid = false; }
    return json(res, 200, { order_id: order.id, period_start: sub.current_period_start, period_end: sub.current_period_end });
  }

  if (!pathname.startsWith('/v1/')) return json(res, 404, { error: 'not_found' });
  if (!requireAuth(req, res)) return;

  try {
    // POST /v1/customers/
    if (method === 'POST' && pathname === '/v1/customers/') {
      const body = await readBody(req);
      if (!body.email) return json(res, 422, { error: 'validation_error', detail: 'email required' });
      return json(res, 201, buildCustomer(body));
    }

    // POST /v1/checkouts/
    if (method === 'POST' && pathname === '/v1/checkouts/') {
      const body = await readBody(req);
      const productId = Array.isArray(body.products) ? body.products[0] : undefined;
      const product = productId ? PRODUCTS[productId] : undefined;
      if (!product) return json(res, 422, { error: 'validation_error', detail: `unknown product id: ${productId}` });

      const customerId = body.customer_id;
      if (!customerId || !customers.has(customerId)) return json(res, 422, { error: 'validation_error', detail: 'existing Polar customer_id required' });

      const checkoutId = uuid();
      let order;
      let sub = null;
      if (product.recurring) {
        sub = buildSubscriptionForProduct({ product, customerId, checkoutId });
        order = buildOrderForProduct({ product, customerId, subscriptionId: sub.id, checkoutId });
      } else {
        order = buildOrderForProduct({ product, customerId, subscriptionId: null, checkoutId });
      }

      const checkout = {
        id: checkoutId,
        created_at: nowIso(),
        modified_at: nowIso(),
        // SIMPLIFICATION: real Polar checkouts start 'open' and only become 'succeeded' once the
        // buyer completes Polar's hosted page — see file header. This mock completes synchronously.
        status: 'succeeded',
        url: `https://checkout.polar.sh/mock/${checkoutId}`,
        client_secret: `cs_mock_${checkoutId}`,
        expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
        success_url: body.success_url ?? null,
        return_url: body.return_url ?? null,
        amount: product.amount,
        total_amount: product.amount,
        discount_amount: 0,
        net_amount: product.amount,
        tax_amount: null,
        currency: product.currency,
        customer_id: customerId,
        external_customer_id: body.external_customer_id ?? null,
        customer_email: customers.get(customerId)?.email ?? null,
        customer_name: customers.get(customerId)?.name ?? null,
        is_business_customer: false,
        products: [{ id: product.id, name: product.name }],
        metadata: body.metadata ?? {},
        payment_processor: 'stripe',
        // mock-only breadcrumbs so callers/tests don't need a second lookup call to find what
        // this checkout produced (not a real Polar field):
        _mock_order_id: order.id,
        _mock_subscription_id: sub ? sub.id : null,
      };
      checkouts.set(checkoutId, checkout);
      return json(res, 201, checkout);
    }

    // GET /v1/orders/  (list) — must be checked before the /v1/orders/{id} pattern
    if (method === 'GET' && (pathname === '/v1/orders/' || pathname === '/v1/orders')) {
      const customerId = url.searchParams.get('customer_id');
      const limit = Math.min(Number(url.searchParams.get('limit') || 10), 100);
      let items = [...orders.values()];
      if (customerId) items = items.filter((o) => o.customer_id === customerId);
      items.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      items = items.slice(0, limit);
      return json(res, 200, { items, pagination: { total_count: items.length, max_page: 1 } });
    }

    // GET /v1/orders/{id}
    let m = /^\/v1\/orders\/([^/]+)$/.exec(pathname);
    if (method === 'GET' && m) {
      const order = orders.get(m[1]);
      if (!order) return json(res, 404, { error: 'resource_not_found', detail: 'order not found' });
      return json(res, 200, order);
    }

    // GET /v1/subscriptions/{id}
    m = /^\/v1\/subscriptions\/([^/]+)$/.exec(pathname);
    if (method === 'GET' && m) {
      const sub = subscriptions.get(m[1]);
      if (!sub) return json(res, 404, { error: 'resource_not_found', detail: 'subscription not found' });
      return json(res, 200, sub);
    }

    // PATCH /v1/subscriptions/{id}
    if (method === 'PATCH' && m) {
      const sub = subscriptions.get(m[1]);
      if (!sub) return json(res, 404, { error: 'resource_not_found', detail: 'subscription not found' });
      if (sub.status === 'canceled') return json(res, 403, { error: 'already_canceled_subscription' });
      const body = await readBody(req);
      if (body.product_id !== undefined && body.product_id !== null) {
        const product = PRODUCTS[body.product_id];
        if (!product) return json(res, 422, { error: 'validation_error', detail: `unknown product id: ${body.product_id}` });
        sub.product_id = product.id;
        sub.amount = product.amount;
        sub.currency = product.currency;
        sub.recurring_interval = product.recurring_interval;
        // proration_behavior:'reset' is the only Polar option that restarts the billing cycle —
        // 'prorate'/'next_period'/'invoice' (what changeSubscription actually sends) never touch
        // current_period_start/end. See spec/polar.pseudo.md "계약 메모" (resetAnchor is ignored).
        if (body.proration_behavior === 'reset') {
          const start = new Date();
          const end = new Date(start.getTime());
          end.setUTCMonth(end.getUTCMonth() + 1);
          sub.current_period_start = start.toISOString();
          sub.current_period_end = end.toISOString();
        }
      }
      if (body.cancel_at_period_end !== undefined) {
        sub.cancel_at_period_end = !!body.cancel_at_period_end;
        sub.status = body.cancel_at_period_end ? sub.status : (sub.status === 'canceled' ? 'active' : sub.status);
      }
      sub.modified_at = nowIso();
      subscriptions.set(sub.id, sub);
      return json(res, 200, sub);
    }

    // DELETE /v1/subscriptions/{id}  (immediate revoke)
    if (method === 'DELETE' && m) {
      const sub = subscriptions.get(m[1]);
      if (!sub) return json(res, 404, { error: 'resource_not_found', detail: 'subscription not found' });
      if (sub.status === 'canceled') return json(res, 403, { error: 'already_canceled_subscription' });
      sub.status = 'canceled';
      sub.canceled_at = nowIso();
      sub.ended_at = nowIso();
      sub.cancel_at_period_end = false;
      sub.modified_at = nowIso();
      subscriptions.set(sub.id, sub);
      return json(res, 200, sub);
    }

    // POST /v1/refunds/
    if (method === 'POST' && pathname === '/v1/refunds/') {
      const body = await readBody(req);
      const order = orders.get(body.order_id);
      if (!order) return json(res, 422, { error: 'validation_error', detail: 'order not found' });
      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount < 1) return json(res, 422, { error: 'validation_error', detail: 'amount must be >= 1' });
      if (amount > order.refundable_amount) return json(res, 422, { error: 'validation_error', detail: 'refund exceeds refundable_amount' });

      order.refunded_amount += amount;
      order.refundable_amount -= amount;
      order.status = order.refundable_amount === 0 ? 'refunded' : 'partially_refunded';
      order.modified_at = nowIso();
      orders.set(order.id, order);

      const id = uuid();
      const refund = {
        id,
        created_at: nowIso(),
        modified_at: nowIso(),
        status: 'succeeded',
        order_id: order.id,
        customer_id: order.customer_id,
        amount,
        tax_amount: 0,
        currency: order.currency,
        reason: body.reason ?? 'customer_request',
        organization_id: 'org_mock',
        subscription_id: order.subscription_id,
        revoke_benefits: !!body.revoke_benefits,
        metadata: body.metadata ?? {},
        dispute: null,
      };
      refunds.set(id, refund);
      return json(res, 201, refund);
    }

    // POST /v1/events/ingest
    if (method === 'POST' && pathname === '/v1/events/ingest') {
      const body = await readBody(req);
      const events = Array.isArray(body.events) ? body.events : [];
      let inserted = 0;
      let duplicates = 0;
      for (const e of events) {
        if (e.external_id && ingestedEventExternalIds.has(e.external_id)) {
          duplicates += 1;
          continue;
        }
        if (e.external_id) ingestedEventExternalIds.add(e.external_id);
        inserted += 1;
      }
      return json(res, 201, { inserted, duplicates });
    }

    return json(res, 404, { error: 'not_found', detail: `no mock route for ${method} ${pathname}` });
  } catch (err) {
    return json(res, 500, { error: 'mock_internal_error', detail: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(PORT, () => {
  console.log(`polar mock listening on http://127.0.0.1:${PORT}`);
});
