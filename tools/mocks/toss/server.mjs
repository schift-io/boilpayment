#!/usr/bin/env node
// Dependency-free Node (node:http) mock of the Toss Payments API surface that
// packages/providers/toss uses. No SDK, no external deps — matches the
// "stripe-mock" role but hand-rolled (Toss ships no official mock server).
//
// Run:  node tools/mocks/toss/server.mjs        (port from TOSS_MOCK_PORT, default 12211)
//
// Endpoints implemented (see packages/providers/toss/spec/toss.pseudo.md):
//   POST /v1/payments/confirm
//   GET  /v1/payments/{paymentKey}
//   GET  /v1/payments/orders/{orderId}
//   POST /v1/billing/authorizations/issue
//   POST /v1/billing/{billingKey}
//   POST /v1/payments/{paymentKey}/cancel
//   GET  /v1/transactions
// Mock-only helper endpoints (not real Toss API, prefixed /__mock/ so they can
// never collide with a real path):
//   POST /__mock/authorize   — simulates the widget having authorized a
//                              paymentKey/orderId/amount pair, which a real
//                              confirm call is checked against. Without a real
//                              browser+widget there is no other way to seed
//                              "what the customer actually authorized" before
//                              calling confirm.
//   POST /__mock/webhook     — makes the mock POST a PAYMENT_STATUS_CHANGED
//                              (or other) webhook body to a URL you pass, so a
//                              script can exercise TossProvider.verifyWebhook
//                              against a real HTTP delivery instead of a
//                              hand-built object.
//   GET  /__mock/health      — liveness check.
//
// Response field shapes (Payment object, billing object, transaction rows,
// error code strings, webhook event envelope) were copied from
// docs.tosspayments.com/reference (결제 승인/조회/취소, 자동결제 발급/승인,
// 거래 조회) and docs.tosspayments.com/reference/using-api/webhook-events,
// fetched 2026-09-09. Two gaps the fetched docs did not resolve precisely, so
// this mock makes a documented approximation instead of guessing silently:
//   - The exact per-scenario error `code` Toss returns when a confirm's
//     `amount` doesn't match what the widget authorized was not findable in
//     the fetched error-code table excerpts. We use `INVALID_REQUEST` (400),
//     which IS a confirmed real code listed for the confirm endpoint's error
//     table, with a message naming the mismatch.
//   - Toss's exact code for "virtual account cancel missing
//     refundReceiveAccount" wasn't resolved either (the fetched table only
//     showed codes for an *invalid* refund account, not a missing one). Same
//     `INVALID_REQUEST` (400) approximation is used here, message-annotated.
// Everything else (status enum, method strings incl. Korean '가상계좌', cancels[]
// shape with transactionKey/cancelAmount/canceledAt, webhook eventType set,
// unsigned payment webhooks vs signed payout.changed/seller.changed) is as
// documented.

import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { randomBytes } from 'node:crypto';
import { URL } from 'node:url';

const PORT = Number(process.env.TOSS_MOCK_PORT) || 12211;

// ── in-memory state ──────────────────────────────────────────────────────────
const payments = new Map(); // paymentKey -> Payment record
const widgetAuthorizations = new Map(); // orderId -> {paymentKey, amount, method, customerKey}
const billingKeys = new Map(); // billingKey -> {customerKey, card}
const idempotency = new Map(); // `${method} ${path} ${key}` -> {status, body}

function genId(prefix) {
  return prefix + randomBytes(12).toString('hex');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function errorBody(code, message) {
  return { code, message };
}

// EC:E4 variant note — payment webhooks (PAYMENT_STATUS_CHANGED etc.) carry no
// signature header per docs.tosspayments.com/reference/using-api/webhook-events;
// only payout.changed/seller.changed do. Auth on the REST API itself is Basic
// secretKey:, checked below.
function checkAuth(req, res) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Basic ')) {
    sendJson(res, 401, errorBody('UNAUTHORIZED_KEY', '인증되지 않은 시크릿 키 혹은 클라이언트 키 입니다'));
    return false;
  }
  const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
  const secretKey = decoded.endsWith(':') ? decoded.slice(0, -1) : decoded;
  if (!secretKey.startsWith('test_')) {
    sendJson(res, 401, errorBody('UNAUTHORIZED_KEY', '인증되지 않은 시크릿 키 혹은 클라이언트 키 입니다'));
    return false;
  }
  return true;
}

function idempotentReplay(method, path, key) {
  if (!key) return null;
  return idempotency.get(`${method} ${path} ${key}`) ?? null;
}

function idempotentStore(method, path, key, status, body) {
  if (!key) return;
  idempotency.set(`${method} ${path} ${key}`, { status, body });
}

function buildPaymentRecord({ paymentKey, orderId, orderName, amount, method, customerKey }) {
  const now = new Date().toISOString();
  const isVirtualAccount = method === '가상계좌';
  return {
    version: '2022-06-08',
    paymentKey,
    type: 'NORMAL',
    orderId,
    orderName: orderName ?? 'mock order',
    mId: 'tosspayments_mock',
    currency: 'KRW',
    method,
    // EC:E8 — virtual account confirms land in WAITING_FOR_DEPOSIT until the
    // actual bank deposit arrives (simulated via /__mock/webhook status=DONE).
    status: isVirtualAccount ? 'WAITING_FOR_DEPOSIT' : 'DONE',
    requestedAt: now,
    approvedAt: isVirtualAccount ? null : now,
    useEscrow: false,
    totalAmount: amount,
    balanceAmount: amount,
    suppliedAmount: Math.round(amount / 1.1),
    vat: amount - Math.round(amount / 1.1),
    cultureExpense: false,
    taxFreeAmount: 0,
    taxExemptionAmount: 0,
    lastTransactionKey: null,
    customerKey: customerKey ?? null, // convenience for round-trip matching; real API may omit for non-billing confirms
    card: isVirtualAccount
      ? null
      : { issuerCode: '61', acquirerCode: '31', number: '433012******1234', installmentPlanMonths: 0, approveNo: '00000000', cardType: '신용', ownerType: '개인' },
    virtualAccount: isVirtualAccount
      ? { accountType: '일반', accountNumber: '1234567890123', bankCode: '20', customerName: customerKey ?? 'mock customer', dueDate: new Date(Date.now() + 86400000).toISOString(), refundStatus: 'NONE', settlementStatus: 'INCOMPLETED' }
      : null,
    cancels: [],
    failure: null,
  };
}

// ── route handlers ────────────────────────────────────────────────────────────

async function handleAuthorize(req, res) {
  // Mock-only: simulates "the widget just finished and the customer
  // authorized this exact paymentKey/orderId/amount/method".
  const body = await readBody(req);
  const paymentKey = body.paymentKey ?? genId('mock_pay_');
  const orderId = body.orderId;
  if (!orderId || typeof body.amount !== 'number') {
    return sendJson(res, 400, errorBody('INVALID_REQUEST', 'orderId, amount 는 필수입니다'));
  }
  widgetAuthorizations.set(orderId, {
    paymentKey,
    orderId,
    amount: body.amount,
    method: body.method ?? '카드',
    customerKey: body.customerKey ?? null,
    orderName: body.orderName ?? null,
  });
  sendJson(res, 200, { paymentKey, orderId, amount: body.amount });
}

async function handleConfirm(req, res) {
  if (!checkAuth(req, res)) return;
  const body = await readBody(req);
  const { paymentKey, orderId, amount } = body;
  const auth = widgetAuthorizations.get(orderId);

  const existing = payments.get(paymentKey);
  if (existing) {
    // idempotent-friendly: confirming an already-confirmed paymentKey returns the same record.
    return sendJson(res, 200, existing);
  }

  if (!auth) {
    return sendJson(res, 404, errorBody('NOT_FOUND_PAYMENT_SESSION', '결제 시간이 만료되어 결제 진행 데이터가 존재하지 않습니다'));
  }
  if (auth.paymentKey !== paymentKey) {
    return sendJson(res, 404, errorBody('NOT_FOUND_PAYMENT', '존재하지 않는 결제 정보 입니다'));
  }
  if (auth.amount !== amount) {
    // See header note: exact Toss code for this scenario unconfirmed from docs; INVALID_REQUEST is
    // the confirmed generic 400 for the confirm endpoint's error table.
    return sendJson(res, 400, errorBody('INVALID_REQUEST', `요청 금액(${amount})이 인증된 금액(${auth.amount})과 일치하지 않습니다`));
  }

  const record = buildPaymentRecord({
    paymentKey,
    orderId,
    orderName: auth.orderName,
    amount,
    method: auth.method,
    customerKey: auth.customerKey,
  });
  payments.set(paymentKey, record);
  sendJson(res, 200, record);
}

async function handleGetPayment(req, res, paymentKey) {
  if (!checkAuth(req, res)) return;
  const record = payments.get(paymentKey);
  if (!record) return sendJson(res, 404, errorBody('NOT_FOUND_PAYMENT', '존재하지 않는 결제 정보 입니다'));
  sendJson(res, 200, record);
}

async function handleIssueBillingKey(req, res) {
  if (!checkAuth(req, res)) return;
  const body = await readBody(req);
  if (!body.authKey || !body.customerKey) {
    return sendJson(res, 400, errorBody('INVALID_REQUEST', 'authKey, customerKey 는 필수입니다'));
  }
  const billingKey = genId('mock_billing_');
  const card = { issuerCode: '61', acquirerCode: '31', number: '433012******1234', cardType: '신용', ownerType: '개인' };
  billingKeys.set(billingKey, { customerKey: body.customerKey, card });
  sendJson(res, 200, {
    mId: 'tosspayments_mock',
    customerKey: body.customerKey,
    billingKey,
    method: '카드',
    authenticatedAt: new Date().toISOString(),
    card,
  });
}

async function handleChargeBillingKey(req, res, billingKey) {
  if (!checkAuth(req, res)) return;
  const idempotencyKey = req.headers['idempotency-key'];
  const path = `/v1/billing/${billingKey}`;
  const replay = idempotentReplay('POST', path, idempotencyKey);
  if (replay) return sendJson(res, replay.status, replay.body);

  const billing = billingKeys.get(billingKey);
  if (!billing) {
    const status = 404;
    const body = errorBody('NOT_FOUND_BILLING_KEY', '존재하지 않는 빌링키 입니다');
    idempotentStore('POST', path, idempotencyKey, status, body);
    return sendJson(res, status, body);
  }

  const reqBody = await readBody(req);
  if (typeof reqBody.amount !== 'number' || !reqBody.orderId) {
    return sendJson(res, 400, errorBody('INVALID_REQUEST', 'amount, orderId 는 필수입니다'));
  }
  const paymentKey = genId('mock_pay_');
  const record = buildPaymentRecord({
    paymentKey,
    orderId: reqBody.orderId,
    orderName: reqBody.orderName,
    amount: reqBody.amount,
    method: '카드',
    customerKey: reqBody.customerKey ?? billing.customerKey,
  });
  payments.set(paymentKey, record);
  idempotentStore('POST', path, idempotencyKey, 200, record);
  sendJson(res, 200, record);
}

async function handleCancel(req, res, paymentKey) {
  if (!checkAuth(req, res)) return;
  const idempotencyKey = req.headers['idempotency-key'];
  const path = `/v1/payments/${paymentKey}/cancel`;
  const replay = idempotentReplay('POST', path, idempotencyKey);
  if (replay) return sendJson(res, replay.status, replay.body);

  const record = payments.get(paymentKey);
  if (!record) {
    const status = 404;
    const body = errorBody('NOT_FOUND_PAYMENT', '존재하지 않는 결제 정보 입니다');
    idempotentStore('POST', path, idempotencyKey, status, body);
    return sendJson(res, status, body);
  }

  const body = await readBody(req);
  if (record.method === '가상계좌' && !body.refundReceiveAccount) {
    // See header note: exact Toss code unconfirmed; INVALID_REQUEST used + message annotated.
    const status = 400;
    const errBody = errorBody('INVALID_REQUEST', '가상계좌 환불은 refundReceiveAccount 가 필요합니다');
    idempotentStore('POST', path, idempotencyKey, status, errBody);
    return sendJson(res, status, errBody);
  }

  const cancelAmount = typeof body.cancelAmount === 'number' ? body.cancelAmount : record.balanceAmount;
  if (cancelAmount > record.balanceAmount) {
    const status = 400;
    const errBody = errorBody('EXCEED_MAX_REFUND_AMOUNT', '취소 가능 금액을 초과했습니다');
    idempotentStore('POST', path, idempotencyKey, status, errBody);
    return sendJson(res, status, errBody);
  }

  const transactionKey = genId('mock_txn_');
  const canceledAt = new Date().toISOString();
  record.cancels.push({
    transactionKey,
    cancelAmount,
    cancelReason: body.cancelReason ?? null,
    canceledAt,
    cancelStatus: 'DONE',
    refundReceiveAccount: body.refundReceiveAccount ?? null,
  });
  record.balanceAmount -= cancelAmount;
  record.lastTransactionKey = transactionKey;
  record.status = record.balanceAmount === 0 ? 'CANCELED' : 'PARTIAL_CANCELED';

  idempotentStore('POST', path, idempotencyKey, 200, record);
  sendJson(res, 200, record);
}

async function handleTransactions(req, res, query) {
  if (!checkAuth(req, res)) return;
  const startDate = query.get('startDate');
  const endDate = query.get('endDate');
  const start = startDate ? new Date(startDate).getTime() : 0;
  const end = endDate ? new Date(endDate).getTime() : Date.now();

  const rows = [];
  for (const p of payments.values()) {
    const at = p.approvedAt ?? p.requestedAt;
    const t = new Date(at).getTime();
    if (t < start || t > end) continue;
    rows.push({
      mId: p.mId,
      transactionKey: p.lastTransactionKey ?? p.paymentKey,
      paymentKey: p.paymentKey,
      orderId: p.orderId,
      method: p.method,
      customerKey: p.customerKey, // EC:H4 — may be null; matches the documented "not always present" limitation
      useEscrow: p.useEscrow,
      status: p.status,
      transactionAt: at,
      currency: p.currency,
      amount: p.totalAmount,
      receiptUrl: `https://mock.tosspayments.com/receipt/${p.paymentKey}`,
    });
  }
  sendJson(res, 200, rows);
}

async function handleMockWebhook(req, res) {
  // Mock-only: POSTs a Toss-shaped webhook envelope to a caller-supplied URL,
  // so scripts can exercise TossProvider.verifyWebhook against a real HTTP
  // delivery instead of hand-building the request object.
  const body = await readBody(req);
  const { url, paymentKey } = body;
  if (!url) return sendJson(res, 400, errorBody('INVALID_REQUEST', 'url 은 필수입니다'));

  const record = paymentKey ? payments.get(paymentKey) : null;
  const eventType = body.eventType ?? 'PAYMENT_STATUS_CHANGED';
  const status = body.status ?? record?.status ?? 'DONE';
  const createdAt = new Date().toISOString();
  const eventBody = {
    eventType,
    createdAt,
    data: {
      paymentKey: paymentKey ?? record?.paymentKey ?? null,
      orderId: body.orderId ?? record?.orderId ?? null,
      status,
      totalAmount: body.totalAmount ?? record?.totalAmount ?? null,
      currency: body.currency ?? record?.currency ?? 'KRW',
      customerKey: body.customerKey ?? record?.customerKey ?? null,
      method: record?.method ?? null,
      approvedAt: record?.approvedAt ?? createdAt,
    },
  };

  const payload = JSON.stringify(eventBody);
  const target = new URL(url);
  const impl = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const outbound = impl(
    {
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
        'tosspayments-webhook-transmission-id': genId('mock_whtx_'),
        'tosspayments-webhook-transmission-time': createdAt,
        'tosspayments-webhook-transmission-retried-count': '0',
        // NOTE: no tosspayments-webhook-signature header — payment webhooks are
        // unsigned per docs.tosspayments.com/reference/using-api/webhook-events;
        // only payout.changed/seller.changed carry that header.
      },
    },
    (outboundRes) => {
      const chunks = [];
      outboundRes.on('data', (c) => chunks.push(c));
      outboundRes.on('end', () => {
        sendJson(res, 200, { delivered: true, targetStatus: outboundRes.statusCode, event: eventBody });
      });
    },
  );
  outbound.on('error', (err) => {
    sendJson(res, 502, { delivered: false, error: String(err), event: eventBody });
  });
  outbound.write(payload);
  outbound.end();
}

// ── router ────────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;
    const method = req.method;

    if (method === 'GET' && path === '/__mock/health') {
      return sendJson(res, 200, { ok: true, port: PORT, payments: payments.size, billingKeys: billingKeys.size });
    }
    if (method === 'POST' && path === '/__mock/authorize') return await handleAuthorize(req, res);
    if (method === 'POST' && path === '/__mock/webhook') return await handleMockWebhook(req, res);

    if (method === 'POST' && path === '/v1/payments/confirm') return await handleConfirm(req, res);

    let m;
    // GET /v1/payments/orders/{orderId} — look a payment up by the merchant's orderId (EC:A38).
    if (method === 'GET' && (m = path.match(/^\/v1\/payments\/orders\/([^/]+)$/))) {
      const orderId = decodeURIComponent(m[1]);
      const found = [...payments.values()].find((p) => p.orderId === orderId);
      if (!found) return sendJson(res, 404, errorBody('NOT_FOUND_PAYMENT', '존재하지 않는 결제 정보 입니다.'));
      return sendJson(res, 200, found);
    }
    if (method === 'GET' && (m = path.match(/^\/v1\/payments\/([^/]+)$/))) {
      return await handleGetPayment(req, res, decodeURIComponent(m[1]));
    }
    if (method === 'POST' && (m = path.match(/^\/v1\/payments\/([^/]+)\/cancel$/))) {
      return await handleCancel(req, res, decodeURIComponent(m[1]));
    }
    if (method === 'POST' && path === '/v1/billing/authorizations/issue') return await handleIssueBillingKey(req, res);
    if (method === 'POST' && (m = path.match(/^\/v1\/billing\/([^/]+)$/))) {
      return await handleChargeBillingKey(req, res, decodeURIComponent(m[1]));
    }
    if (method === 'GET' && path === '/v1/transactions') return await handleTransactions(req, res, url.searchParams);

    sendJson(res, 404, errorBody('NOT_FOUND', `unknown mock route: ${method} ${path}`));
  } catch (err) {
    sendJson(res, 500, errorBody('INTERNAL_SERVER_ERROR', String(err?.stack ?? err)));
  }
});

server.listen(PORT, () => {
  console.log(`toss-mock listening on http://127.0.0.1:${PORT}`);
});
