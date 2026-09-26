#!/usr/bin/env node
// Dependency-free Node (node:http) mock of the PortOne V2 API surface that
// packages/providers/portone uses. No SDK, no external deps — same role as
// tools/mocks/toss/server.mjs and tools/mocks/polar/server.mjs (PortOne, like
// Toss, ships no official mock server).
//
// Run:  node tools/mocks/portone/server.mjs   (port from PORTONE_MOCK_PORT, default 12212)
//
// Endpoints implemented (see packages/providers/portone/spec/portone.pseudo.md):
//   GET    /payments/{paymentId}
//   GET    /payments                       (requestBody= query param, see below)
//   POST   /payments/{paymentId}/billing-key
//   POST   /billing-keys
//   POST   /payments/{paymentId}/cancel
//   POST   /payments/{paymentId}/schedule
//   DELETE /payment-schedules
//
// Response field shapes (Payment discriminated union, PaymentAmount, PaymentFailure,
// BillingKeyPaymentSummary, IssueBillingKeyResponse/BillingKeyInfoSummary,
// CreatePaymentScheduleBody/Response, RevokePaymentSchedulesBody/Response,
// CancelPaymentBody/Response, GetPaymentsBody's requestBody-as-query-param
// convention, PaymentFilterInput's field list) were taken verbatim from the real
// V2 OpenAPI spec — developers.portone.io itself is JS-rendered and did not
// yield full schemas via WebFetch, so the spec was pulled from its source
// (portone-io/server-sdk GitHub repo, codegen/openapi.json, fetched 2026-09-09)
// instead. This resolved two items packages/providers/portone/spec/portone.pseudo.md
// had previously marked "미검증" (issueBillingKey's server-side path, and the
// cancel-schedules endpoint) and surfaced real bugs in the provider that were
// fixed alongside this mock — see that spec file's 2026-09-09 note for the list.
//
// Auth: every real endpoint requires `Authorization: PortOne test_<anything>`
// (any secret starting with `test_`; anything else, or a missing header, is a
// 401) — mirroring the toss/polar mocks' "test secrets only" convention.
//
// Mock-only helper endpoints (prefixed /__mock/ so they can never collide with
// a real PortOne path, no PortOne auth required):
//   POST /__mock/seed/payment  — inject a full Payment record directly, keyed
//                                by `id`. There is no way to reach every real
//                                status (VIRTUAL_ACCOUNT_ISSUED, FAILED with a
//                                specific pgCode, a virtual-account `method`
//                                for the D13 refund-account test) purely
//                                through the billing-key charge flow this mock
//                                implements, so seeding fills that gap — the
//                                same role stripe-mock's built-in fixtures play
//                                for Stripe.
//   POST /__mock/sign          — { type, data, staleSeconds? } -> { headers,
//                                body } — computes a real Standard Webhooks
//                                signature (webhook-id/webhook-timestamp/
//                                webhook-signature) for the given event
//                                envelope without pushing it anywhere, so a
//                                script can build a tampered-body or
//                                stale-timestamp case locally by mutating what
//                                comes back before calling verifyWebhook.
//   POST /__mock/webhook       — { url, secret, type, data } -> POSTs a
//                                Standard-Webhooks-signed { type, data,
//                                timestamp } envelope to `url`, signed with
//                                `secret` (whsec_... form, same algorithm as
//                                PortoneProvider.verifyWebhook /
//                                verify_webhook). Used for the real end-to-end
//                                delivery in the provider-scheduled-renewal
//                                round trip.
//   GET  /__mock/health         — liveness check.

import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { URL } from 'node:url';

const PORT = Number(process.env.PORTONE_MOCK_PORT) || 12212;

// ── in-memory state ──────────────────────────────────────────────────────────
const payments = new Map(); // paymentId -> Payment record (discriminated union shape)
const billingKeys = new Map(); // billingKey -> { billingKey, customer, channels, issuedAt }
const schedules = new Map(); // scheduleId -> { id, paymentId, billingKey, timeToPay, status }

function genId(prefix) {
  return prefix + randomBytes(12).toString('hex');
}

function nowIso() {
  return new Date().toISOString();
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
  const m = /^PortOne\s+(.+)$/.exec(auth);
  if (!m || !m[1].startsWith('test_')) {
    json(res, 401, { type: 'UNAUTHORIZED', message: 'missing or non-test Authorization header (expected "PortOne test_...")' });
    return false;
  }
  return true;
}

// ── Payment record builder (fills the required fields of the real Payment
// discriminated union with sensible defaults; caller-supplied fields win) ────
function buildPayment(fields) {
  const base = {
    id: fields.id,
    transactionId: fields.transactionId ?? genId('txn_'),
    merchantId: fields.merchantId ?? 'merchant_test',
    storeId: fields.storeId ?? 'store_dummy',
    version: 'V2',
    requestedAt: fields.requestedAt ?? nowIso(),
    updatedAt: fields.updatedAt ?? fields.requestedAt ?? nowIso(),
    statusChangedAt: fields.statusChangedAt ?? fields.requestedAt ?? nowIso(),
    orderName: fields.orderName ?? 'Subscription charge',
    amount: fields.amount ?? { total: 0, taxFree: 0, vat: 0 },
    currency: fields.currency ?? 'KRW',
    customer: fields.customer ?? {},
    origin: fields.origin ?? null,
  };
  return { ...base, ...fields };
}

// ── Standard Webhooks signing (mirrors PortoneProvider.verifyWebhook / verify_webhook) ──
function signStandardWebhook({ id, timestamp, rawBody, secret }) {
  const secretRaw = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  const key = Buffer.from(secretRaw, 'base64');
  const signedContent = `${id}.${timestamp}.${rawBody}`;
  const sig = createHmac('sha256', key).update(signedContent).digest('base64');
  return `v1,${sig}`;
}

function buildSignedEnvelope({ type, data, staleSeconds = 0 }) {
  const id = genId('msg_');
  const timestamp = String(Math.floor(Date.now() / 1000) - staleSeconds);
  const payload = { type, timestamp: nowIso(), data };
  const rawBody = JSON.stringify(payload);
  return { id, timestamp, rawBody };
}

async function deliverWebhook({ url, secret, type, data }) {
  const { id, timestamp, rawBody } = buildSignedEnvelope({ type, data });
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
    return json(res, 400, { type: 'INVALID_REQUEST', message: 'bad request' });
  }
  const { pathname } = url;
  const method = req.method || 'GET';

  if (method === 'GET' && pathname === '/__mock/health') {
    return json(res, 200, { ok: true });
  }

  // -- control endpoints: not part of the real PortOne API, no PortOne auth required --
  if (method === 'POST' && pathname === '/__mock/seed/payment') {
    let body;
    try {
      body = await readBody(req);
    } catch {
      return json(res, 400, { type: 'INVALID_REQUEST', message: 'invalid json' });
    }
    if (!body.id) return json(res, 400, { type: 'INVALID_REQUEST', message: 'id required' });
    const record = buildPayment(body);
    payments.set(record.id, record);
    return json(res, 200, record);
  }

  if (method === 'POST' && pathname === '/__mock/sign') {
    let body;
    try {
      body = await readBody(req);
    } catch {
      return json(res, 400, { type: 'INVALID_REQUEST', message: 'invalid json' });
    }
    const { type, data, secret, staleSeconds } = body;
    if (!type || !data || !secret) return json(res, 400, { type: 'INVALID_REQUEST', message: 'missing type/data/secret' });
    const { id, timestamp, rawBody } = buildSignedEnvelope({ type, data, staleSeconds: staleSeconds ?? 0 });
    const signature = signStandardWebhook({ id, timestamp, rawBody, secret });
    return json(res, 200, {
      headers: { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': signature },
      body: rawBody,
    });
  }

  if (method === 'POST' && pathname === '/__mock/webhook') {
    let body;
    try {
      body = await readBody(req);
    } catch {
      return json(res, 400, { type: 'INVALID_REQUEST', message: 'invalid json' });
    }
    const { url: targetUrl, secret, type, data } = body;
    if (!targetUrl || !secret || !type || !data) return json(res, 400, { type: 'INVALID_REQUEST', message: 'missing url/secret/type/data' });
    const result = await deliverWebhook({ url: targetUrl, secret, type, data });
    return json(res, 200, result);
  }

  // -- real PortOne V2 API surface --
  if (!requireAuth(req, res)) return;

  try {
    // GET /payments  (list — GetPaymentsBody carried as a single URL-encoded
    // `requestBody` query param per the real API's GET-with-body convention;
    // PaymentFilterInput has no customer-id field, so we only apply `from`.)
    if (method === 'GET' && pathname === '/payments') {
      let filter = {};
      const raw = url.searchParams.get('requestBody');
      if (raw) {
        try {
          filter = JSON.parse(raw).filter ?? {};
        } catch {
          return json(res, 400, { type: 'INVALID_REQUEST', message: 'requestBody must be JSON' });
        }
      }
      let items = [...payments.values()];
      if (filter.from) items = items.filter((p) => (p.requestedAt ?? '') >= filter.from);
      if (filter.until) items = items.filter((p) => (p.requestedAt ?? '') <= filter.until);
      return json(res, 200, { items, page: { number: 0, size: items.length, totalCount: items.length } });
    }

    // GET /payments/{paymentId}
    const getOneMatch = method === 'GET' && pathname.match(/^\/payments\/([^/]+)$/);
    if (getOneMatch) {
      const id = decodeURIComponent(getOneMatch[1]);
      const record = payments.get(id);
      if (!record) return json(res, 404, { type: 'PAYMENT_NOT_FOUND', message: `payment not found: ${id}` });
      return json(res, 200, record);
    }

    // POST /billing-keys  (IssueBillingKeyBody -> IssueBillingKeyResponse)
    if (method === 'POST' && pathname === '/billing-keys') {
      const body = await readBody(req);
      if (!body.method) return json(res, 400, { type: 'INVALID_REQUEST', message: 'method required' });
      const billingKey = genId('billing_key_');
      const record = {
        billingKey,
        channels: [{ channelKey: body.channelKey ?? 'channel_test' }],
        issuedAt: nowIso(),
        customer: body.customer ?? {},
      };
      billingKeys.set(billingKey, record);
      return json(res, 200, { billingKeyInfo: record, channelSpecificFailures: [] });
    }

    // POST /payments/{paymentId}/billing-key  (BillingKeyPaymentInput -> PayWithBillingKeyResponse)
    const chargeMatch = method === 'POST' && pathname.match(/^\/payments\/([^/]+)\/billing-key$/);
    if (chargeMatch) {
      const id = decodeURIComponent(chargeMatch[1]);
      const body = await readBody(req);
      if (!body.billingKey || !billingKeys.has(body.billingKey)) {
        return json(res, 404, { type: 'BILLING_KEY_NOT_FOUND', message: `billing key not found: ${body.billingKey}` });
      }
      const existing = payments.get(id);
      if (existing && existing.status === 'PAID') {
        // real API: retrying billing-key charge on an already-paid paymentId is
        // rejected, not double-charged — this IS the idempotency mechanism.
        return json(res, 409, { type: 'ALREADY_PAID', message: `payment already paid: ${id}` });
      }
      const paidAt = nowIso();
      const record = buildPayment({
        id,
        status: 'PAID',
        amount: body.amount ?? { total: 0 },
        currency: body.currency ?? 'KRW',
        customer: body.customer ?? {},
        billingKey: body.billingKey,
        method: { type: 'Card' },
        paidAt,
        requestedAt: paidAt,
        pgTxId: genId('pgtx_'),
      });
      payments.set(id, record);
      return json(res, 200, { payment: { pgTxId: record.pgTxId, paidAt: record.paidAt } });
    }

    // POST /payments/{paymentId}/cancel  (CancelPaymentBody -> CancelPaymentResponse)
    const cancelMatch = method === 'POST' && pathname.match(/^\/payments\/([^/]+)\/cancel$/);
    if (cancelMatch) {
      const id = decodeURIComponent(cancelMatch[1]);
      const body = await readBody(req);
      const record = payments.get(id);
      if (!record) return json(res, 404, { type: 'PAYMENT_NOT_FOUND', message: `payment not found: ${id}` });
      // EC:D13 — a virtual-account payment's cancel requires refundAccount.
      if (record.method?.type === 'VirtualAccount' && !body.refundAccount) {
        return json(res, 400, {
          type: 'INVALID_REQUEST',
          message: 'refundAccount is required to refund a virtual account payment',
        });
      }
      const total = record.amount?.total ?? 0;
      const alreadyCancelled = (record.cancellations ?? []).reduce((sum, c) => sum + (c.totalAmount ?? c.amount ?? 0), 0);
      const cancelAmount = body.amount ?? total - alreadyCancelled;
      if (cancelAmount > total - alreadyCancelled) {
        return json(res, 400, { type: 'INVALID_REQUEST', message: 'cancel amount exceeds remaining cancellable amount' });
      }
      const cancelledAt = nowIso();
      const cancellation = {
        id: genId('cxl_'),
        status: 'SUCCEEDED',
        totalAmount: cancelAmount,
        amount: cancelAmount,
        reason: body.reason,
        requestedAt: cancelledAt,
        cancelledAt,
      };
      const cancellations = [...(record.cancellations ?? []), cancellation];
      const nowCancelled = alreadyCancelled + cancelAmount;
      const status = nowCancelled >= total ? 'CANCELLED' : 'PARTIAL_CANCELLED';
      const updated = { ...record, status, cancellations };
      payments.set(id, updated);
      return json(res, 200, { cancellation });
    }

    // POST /payments/{paymentId}/schedule  (CreatePaymentScheduleBody -> CreatePaymentScheduleResponse)
    const scheduleMatch = method === 'POST' && pathname.match(/^\/payments\/([^/]+)\/schedule$/);
    if (scheduleMatch) {
      const id = decodeURIComponent(scheduleMatch[1]);
      const body = await readBody(req);
      const paymentInput = body.payment;
      if (!paymentInput || !paymentInput.billingKey) {
        return json(res, 400, { type: 'INVALID_REQUEST', message: 'payment.billingKey required' });
      }
      if (!billingKeys.has(paymentInput.billingKey)) {
        return json(res, 404, { type: 'BILLING_KEY_NOT_FOUND', message: `billing key not found: ${paymentInput.billingKey}` });
      }
      const existing = [...schedules.values()].find((s) => s.paymentId === id && s.status === 'SCHEDULED');
      if (existing) {
        return json(res, 409, { type: 'PAYMENT_SCHEDULE_ALREADY_EXISTS', message: `a schedule already exists for paymentId ${id}` });
      }
      const scheduleId = genId('sch_');
      const record = {
        id: scheduleId,
        paymentId: id,
        billingKey: paymentInput.billingKey,
        payment: paymentInput,
        timeToPay: body.timeToPay,
        status: 'SCHEDULED',
      };
      schedules.set(scheduleId, record);
      return json(res, 200, { schedule: { id: scheduleId, status: 'SCHEDULED' } });
    }

    // DELETE /payment-schedules  (RevokePaymentSchedulesBody -> RevokePaymentSchedulesResponse)
    if (method === 'DELETE' && pathname === '/payment-schedules') {
      const body = await readBody(req);
      if (!body.billingKey && !(Array.isArray(body.scheduleIds) && body.scheduleIds.length > 0)) {
        return json(res, 400, { type: 'INVALID_REQUEST', message: 'billingKey or scheduleIds required' });
      }
      const targets = [...schedules.values()].filter((s) => {
        if (s.status !== 'SCHEDULED') return false;
        if (body.scheduleIds) return body.scheduleIds.includes(s.id);
        return s.billingKey === body.billingKey;
      });
      const revokedScheduleIds = [];
      for (const s of targets) {
        schedules.set(s.id, { ...s, status: 'REVOKED' });
        revokedScheduleIds.push(s.id);
      }
      return json(res, 200, { revokedScheduleIds, revokedAt: nowIso() });
    }

    return json(res, 404, { type: 'NOT_FOUND', message: `no route for ${method} ${pathname}` });
  } catch (err) {
    return json(res, 500, { type: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(PORT, () => {
  console.log(`portone-mock listening on http://127.0.0.1:${PORT}`);
});
