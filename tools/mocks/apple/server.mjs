#!/usr/bin/env node
// Dependency-free mock of the App Store Server API surface AppleProvider calls, signing everything
// with a test chain from make_chain.py (not Apple's). No Apple account, no network.
//   GET /{production|sandbox}/inApps/v1/transactions/{transactionId}      Get Transaction Info
//   GET /{production|sandbox}/inApps/v1/subscriptions/{originalTransactionId}  Get All Subscription Statuses
// Shapes: https://developer.apple.com/documentation/appstoreserverapi/get-transaction-info and
// .../get-all-subscription-statuses. Bearer JWT is checked against api.key from the chain dir.
//
// Control endpoints (test only, not Apple API):
//   POST /__mock/transactions {transaction}  -> {signedTransaction}   store + sign a JWSTransaction
//   POST /__mock/status {originalTransactionId, status, autoRenewStatus, gracePeriodExpiresDate}
//   POST /__mock/notification {notificationType, subtype, data, transaction?, evil?} -> {body}
//        body is the exact POST body Apple would send ({"signedPayload": ...})
//
// Usage: APPLE_MOCK_PORT=12220 node tools/mocks/apple/server.mjs  (prints {"url","chainDir"} once ready)
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChain, makeChain, signJws, verifyApiToken } from './sign.mjs';

export async function startAppleMock({ port = 0, chainDir = makeChain(), bundleId = 'io.boilpayment.test' } = {}) {
  const chain = loadChain(chainDir);
  const evil = loadChain(chainDir, 'evil-');
  const apiKey = readFileSync(join(chainDir, 'api.key'), 'utf8');
  const transactions = new Map(); // transactionId -> payload
  const statuses = new Map(); // originalTransactionId -> {status, renewal}

  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const read = (req) => new Promise((ok) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => ok(s ? JSON.parse(s) : {})); });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname === '/__mock/transactions') {
      const t = await read(req);
      const tx = { type: 'Auto-Renewable Subscription', bundleId, environment: 'Sandbox', inAppOwnershipType: 'PURCHASED', currency: 'USD', ...t };
      tx.originalTransactionId ??= tx.transactionId;
      transactions.set(tx.transactionId, tx);
      return json(res, 200, { signedTransaction: signJws(tx, chain), transaction: tx });
    }
    if (req.method === 'POST' && url.pathname === '/__mock/status') {
      const s = await read(req);
      statuses.set(s.originalTransactionId, s);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/__mock/notification') {
      const n = await read(req);
      const tx = n.transaction ? { ...transactions.get(n.transaction.transactionId), ...n.transaction } : null;
      if (tx) transactions.set(tx.transactionId, tx);
      const signer = n.evil ? evil : chain;
      const payload = {
        notificationType: n.notificationType, subtype: n.subtype, notificationUUID: n.notificationUUID ?? randomUUID(), version: '2.0', signedDate: Date.now(),
        data: { bundleId, environment: tx?.environment ?? 'Sandbox', ...(n.data ?? {}), ...(tx ? { signedTransactionInfo: signJws(tx, signer) } : {}) },
      };
      return json(res, 200, { body: JSON.stringify({ signedPayload: signJws(payload, signer) }), notificationUUID: payload.notificationUUID });
    }
    const m = url.pathname.match(/^\/(production|sandbox)\/inApps\/v1\/(transactions|subscriptions)\/([^/]+)$/);
    if (req.method === 'GET' && m) {
      const auth = req.headers.authorization ?? '';
      if (!auth.startsWith('Bearer ') || !verifyApiToken(auth.slice(7), apiKey, bundleId)) return json(res, 401, { errorCode: 4010000, errorMessage: 'Unauthorized' });
      const env = m[1] === 'production' ? 'Production' : 'Sandbox';
      const id = decodeURIComponent(m[3]);
      if (m[2] === 'transactions') {
        const tx = transactions.get(id);
        if (!tx || tx.environment !== env) return json(res, 404, { errorCode: 4040010, errorMessage: 'Transaction id not found.' });
        return json(res, 200, { signedTransactionInfo: signJws(tx, chain) });
      }
      const all = [...transactions.values()].filter((t) => t.originalTransactionId === id && t.environment === env).sort((a, b) => b.purchaseDate - a.purchaseDate);
      if (all.length === 0) return json(res, 404, { errorCode: 4040005, errorMessage: 'Original transaction id not found.' });
      const s = statuses.get(id) ?? { status: all[0].expiresDate > Date.now() ? 1 : 2, autoRenewStatus: 1 };
      const renewal = { originalTransactionId: id, autoRenewStatus: s.autoRenewStatus ?? 1, ...(s.gracePeriodExpiresDate ? { gracePeriodExpiresDate: s.gracePeriodExpiresDate } : {}) };
      return json(res, 200, { environment: env, bundleId, data: [{ subscriptionGroupIdentifier: 'group', lastTransactions: [{ originalTransactionId: id, status: s.status, signedTransactionInfo: signJws(all[0], chain), signedRenewalInfo: signJws(renewal, chain) }] }] });
    }
    json(res, 404, { errorMessage: 'not found' });
  });
  await new Promise((ok) => server.listen(port, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, chainDir, rootPem: chain.rootPem, apiKey, bundleId, close: () => new Promise((ok) => server.close(ok)) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mock = await startAppleMock({ port: Number(process.env.APPLE_MOCK_PORT ?? 12220), bundleId: process.env.APPLE_MOCK_BUNDLE_ID ?? 'io.boilpayment.test' });
  console.log(JSON.stringify({ url: mock.url, chainDir: mock.chainDir }));
}
