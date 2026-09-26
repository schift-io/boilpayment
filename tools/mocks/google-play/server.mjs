#!/usr/bin/env node
// Dependency-free mock of the Google surfaces GooglePlayProvider calls. No Google account, no network.
//   GET  /oidc/certs                                      fake Google JWKS (Pub/Sub push OIDC tokens)
//   POST /token                                           service-account JWT bearer grant -> access_token
//   GET  /androidpublisher/v3/applications/{pkg}/purchases/subscriptionsv2/tokens/{token}
//   GET  /androidpublisher/v3/applications/{pkg}/purchases/products/{productId}/tokens/{token}
//   POST .../purchases/subscriptions/{subscriptionId}/tokens/{token}:acknowledge | :cancel
//   POST .../purchases/products/{productId}/tokens/{token}:acknowledge
// Shapes: developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2,
// .../purchases.products, developer.android.com/google/play/billing/rtdn-reference.
//
// Control endpoints (test only):
//   GET  /__mock/service-account                -> service-account JSON (private key + token_uri = this mock)
//   POST /__mock/subscriptions {token, ...SubscriptionPurchaseV2}
//   POST /__mock/products {productId, token, ...ProductPurchase}
//   POST /__mock/push {notification, audience?, email?, sign?: 'evil'|'none', expired?} -> {headers, body}
//   GET  /__mock/acks                           -> acknowledge / cancel calls seen
import { createServer } from 'node:http';
import { generateKeyPairSync, sign, verify, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export async function startGoogleMock({ port = 0, packageName = 'io.boilpayment.test', audience = 'https://example.test/webhook/google-play', pushEmail = 'push@test.iam.gserviceaccount.com' } = {}) {
  const oidc = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const evil = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'mock-kid-1';
  const saEmail = 'kit@test.iam.gserviceaccount.com';
  const accessTokens = new Set();
  const subs = new Map();
  const products = new Map();
  const calls = [];
  let url = '';

  const enc = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const jwt = (claims, key, k = kid) => { const h = enc({ alg: 'RS256', kid: k, typ: 'JWT' }); const b = enc(claims); return `${h}.${b}.${sign('sha256', Buffer.from(`${h}.${b}`), key).toString('base64url')}`; };
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const read = (req) => new Promise((ok) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => ok(s)); });

  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/oidc/certs') return json(res, 200, { keys: [{ ...oidc.publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] });
    if (u.pathname === '/__mock/service-account') {
      return json(res, 200, { type: 'service_account', client_email: saEmail, private_key: sa.privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: `${url}/token` });
    }
    if (req.method === 'POST' && u.pathname === '/token') {
      const form = new URLSearchParams(await read(req));
      const [h, b, s] = String(form.get('assertion')).split('.');
      const claims = JSON.parse(Buffer.from(b ?? '', 'base64url').toString() || '{}');
      const ok = s && verify('sha256', Buffer.from(`${h}.${b}`), sa.publicKey, Buffer.from(s, 'base64url'))
        && claims.iss === saEmail && claims.aud === `${url}/token` && claims.scope === 'https://www.googleapis.com/auth/androidpublisher';
      if (!ok) return json(res, 400, { error: 'invalid_grant' });
      const token = `ya29.mock-${randomUUID()}`;
      accessTokens.add(token);
      return json(res, 200, { access_token: token, expires_in: 3600, token_type: 'Bearer' });
    }
    if (req.method === 'POST' && u.pathname === '/__mock/subscriptions') { const b = JSON.parse(await read(req)); subs.set(b.token, b); return json(res, 200, { ok: true }); }
    if (req.method === 'POST' && u.pathname === '/__mock/products') { const b = JSON.parse(await read(req)); products.set(`${b.productId}|${b.token}`, b); return json(res, 200, { ok: true }); }
    if (u.pathname === '/__mock/acks') return json(res, 200, { calls });
    if (req.method === 'POST' && u.pathname === '/__mock/push') {
      const b = JSON.parse(await read(req));
      const note = { version: '1.0', packageName, eventTimeMillis: String(Date.now()), ...b.notification };
      const now = Math.floor(Date.now() / 1000);
      const claims = { iss: 'https://accounts.google.com', aud: b.audience ?? audience, email: b.email ?? pushEmail, email_verified: true, iat: now, exp: b.expired ? now - 10 : now + 3600, sub: '1' };
      const headers = b.sign === 'none' ? {} : { authorization: `Bearer ${jwt(claims, b.sign === 'evil' ? evil.privateKey : oidc.privateKey)}` };
      const body = JSON.stringify({ message: { data: Buffer.from(JSON.stringify(note)).toString('base64'), messageId: b.messageId ?? randomUUID(), publishTime: new Date().toISOString() }, subscription: 'projects/p/subscriptions/s' });
      return json(res, 200, { headers, body });
    }
    const m = u.pathname.match(/^\/androidpublisher\/v3\/applications\/([^/]+)\/purchases\/(subscriptionsv2|products|subscriptions)\/(.+)$/);
    if (m) {
      const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (!accessTokens.has(bearer)) return json(res, 401, { error: { code: 401, message: 'Invalid Credentials' } });
      if (decodeURIComponent(m[1]) !== packageName) return json(res, 404, { error: { code: 404, message: 'Package not found' } });
      const rest = m[3];
      if (m[2] === 'subscriptionsv2' && req.method === 'GET') {
        const token = decodeURIComponent(rest.replace(/^tokens\//, ''));
        const s = subs.get(token);
        if (!s) return json(res, 404, { error: { code: 404, message: 'The purchase token was not found.' } });
        const { token: _t, ...body } = s;
        return json(res, 200, { kind: 'androidpublisher#subscriptionPurchaseV2', ...body });
      }
      const pm = rest.match(/^([^/]+)\/tokens\/([^/:]+)(?::(acknowledge|cancel))?$/);
      if (!pm) return json(res, 404, {});
      const [, id, tok, action] = pm.map((x) => (x ? decodeURIComponent(x) : x));
      if (m[2] === 'products') {
        const p = products.get(`${id}|${tok}`);
        if (!p) return json(res, 404, { error: { code: 404, message: 'The purchase token was not found.' } });
        if (action === 'acknowledge') { p.acknowledgementState = 1; calls.push({ action, kind: 'product', id, token: tok }); return json(res, 200, {}); }
        const { token: _t, productId: _p, ...body } = p;
        return json(res, 200, { kind: 'androidpublisher#productPurchase', ...body });
      }
      const s = subs.get(tok);
      if (!s) return json(res, 404, { error: { code: 404, message: 'The purchase token was not found.' } });
      if (action === 'acknowledge') { s.acknowledgementState = 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED'; calls.push({ action, kind: 'subscription', id, token: tok }); return json(res, 200, {}); }
      if (action === 'cancel') { s.subscriptionState = 'SUBSCRIPTION_STATE_CANCELED'; calls.push({ action, kind: 'subscription', id, token: tok }); return json(res, 200, {}); }
    }
    json(res, 404, { error: 'not found' });
  });
  await new Promise((ok) => server.listen(port, '127.0.0.1', ok));
  url = `http://127.0.0.1:${server.address().port}`;
  return { url, packageName, audience, pushEmail, jwksUrl: `${url}/oidc/certs`, close: () => new Promise((ok) => server.close(ok)) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mock = await startGoogleMock({ port: Number(process.env.GOOGLE_PLAY_MOCK_PORT ?? 12221) });
  console.log(JSON.stringify({ url: mock.url }));
}
