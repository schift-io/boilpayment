// A small controllable Stripe API for generated-app renewal tests: invoices, subscriptions, payment
// intents with an expanded latest_charge, checkout sessions (including discounts/payment links),
// and refunds (POST /v1/refunds moves the charge's
// amount_refunded like a dashboard refund). stripe-mock returns fixed fixtures and cannot hold the
// state a renewal, a refund and a dispute of the same invoice need across calls.
//   POST /__set   { invoices?, subscriptions?, payment_intents?, checkout_sessions? }  merge state
//   GET  /__state                                                 read everything back
// usage: STRIPE_FAKE_PORT=n node tools/mocks/stripe-renewals/server.mjs
import { createServer } from 'node:http';
const S = { invoices: {}, subscriptions: {}, payment_intents: {}, checkout_sessions: {}, refunds: {}, refundSeq: 0 };
const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'POST' && url.pathname === '/__set') {
      const s = JSON.parse(body || '{}');
      for (const k of ['invoices', 'subscriptions', 'payment_intents', 'checkout_sessions']) Object.assign(S[k], s[k] ?? {});
      return send(res, 200, {});
    }
    if (req.method === 'GET' && url.pathname === '/__state') return send(res, 200, S);
    if (req.method === 'POST' && url.pathname === '/v1/refunds') {
      const f = new URLSearchParams(body);
      const pi = S.payment_intents[f.get('payment_intent')];
      if (!pi) return send(res, 404, { error: { type: 'invalid_request_error', message: 'no such payment_intent' } });
      const amount = Number(f.get('amount') ?? pi.amount);
      const ch = pi.latest_charge;
      if (ch.amount_refunded + amount > pi.amount) return send(res, 400, { error: { type: 'invalid_request_error', code: 'charge_already_refunded', message: 'exceeds' } });
      ch.amount_refunded += amount; ch.refunded = ch.amount_refunded === pi.amount;
      const id = `re_${++S.refundSeq}`;
      const r = { id, object: 'refund', amount, currency: pi.currency, status: 'succeeded', payment_intent: pi.id, charge: ch.id,
        created: Math.floor(Date.now() / 1000), reason: f.get('reason'), metadata: {} };
      S.refunds[id] = r;
      return send(res, 200, r);
    }
    const checkout = /^\/v1\/checkout\/sessions\/([^/?]+)$/.exec(url.pathname);
    if (checkout) {
      const found = S.checkout_sessions[decodeURIComponent(checkout[1])];
      if (!found) return send(res, 404, { error: { type: 'invalid_request_error', message: `no such ${url.pathname}` } });
      return send(res, 200, found);
    }
    const m = /^\/v1\/(invoices|subscriptions|payment_intents|refunds)\/([^/?]+)$/.exec(url.pathname);
    const found = m ? S[m[1]][decodeURIComponent(m[2])] : undefined;
    if (!found) return send(res, 404, { error: { type: 'invalid_request_error', message: `no such ${url.pathname}` } });
    return send(res, 200, found);
  });
}).listen(Number(process.env.STRIPE_FAKE_PORT ?? 12290), '127.0.0.1');
