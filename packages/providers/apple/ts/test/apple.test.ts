import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CollectingLogger } from 'boilpayment-core';
import { AppleProvider } from '../src/index.js';
// @ts-expect-error — plain .mjs test mock, no types
import { startAppleMock } from '../../../../../tools/mocks/apple/server.mjs';
// @ts-expect-error — plain .mjs test mock, no types
import { loadChain, signJws } from '../../../../../tools/mocks/apple/sign.mjs';

type Mock = Awaited<ReturnType<typeof startAppleMock>>;
let mock: Mock;
const BUNDLE = 'io.boilpayment.test';
const DAY = 86_400_000;

function provider(over: Partial<ConstructorParameters<typeof AppleProvider>[0]> = {}, logger = new CollectingLogger()) {
  return new AppleProvider({
    bundleId: BUNDLE, appAppleId: 123, rootCertificates: [mock.rootPem], issuerId: 'issuer', keyId: 'KEY1', privateKey: mock.apiKey,
    apiBaseUrl: { production: `${mock.url}/production`, sandbox: `${mock.url}/sandbox` }, logger, ...over,
  });
}
async function seed(tx: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${mock.url}/__mock/transactions`, { method: 'POST', body: JSON.stringify(tx) });
  return ((await res.json()) as { signedTransaction: string }).signedTransaction;
}
async function note(body: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${mock.url}/__mock/notification`, { method: 'POST', body: JSON.stringify(body) });
  return ((await res.json()) as { body: string }).body;
}

beforeAll(async () => { mock = await startAppleMock({ bundleId: BUNDLE }); });
afterAll(async () => { await mock.close(); });

describe('apple verifyPurchase', () => {
  it('EC:N1 verifies a signed subscription transaction and re-fetches it from the store', async () => {
    const now = Date.now();
    const jws = await seed({ transactionId: 't-100', productId: 'pro.monthly', purchaseDate: now - DAY, expiresDate: now + 29 * DAY, price: 9990, currency: 'USD', appAccountToken: 'acct-1' });
    const v = await provider().verifyPurchase({ signedTransaction: jws });
    expect(v.payment).toMatchObject({ providerRef: 't-100', subscriptionId: 't-100', kind: 'subscription', status: 'succeeded', amount: { amountMinor: 999, currency: 'USD' }, customerId: 'acct-1' });
    expect(v).toMatchObject({ subscriptionRef: 't-100', productId: 'pro.monthly', accountToken: 'acct-1', environment: 'sandbox', ownership: 'purchased', amountFromStore: true });
    expect(v.subscription?.status).toBe('active');
  });

  it('EC:N3 security: a transaction for another bundle id is rejected (iap_wrong_app)', async () => {
    const jws = await seed({ transactionId: 't-other', productId: 'x', purchaseDate: Date.now(), bundleId: 'com.someone.else', type: 'Consumable' });
    await expect(provider().verifyPurchase({ signedTransaction: jws })).rejects.toMatchObject({ code: 'iap_wrong_app' });
  });

  it('EC:N1 security: a JWS signed by an untrusted chain is rejected', async () => {
    const evil = loadChain(mock.chainDir, 'evil-');
    const jws = signJws({ transactionId: 't-evil', bundleId: BUNDLE, productId: 'x', purchaseDate: Date.now(), environment: 'Sandbox', type: 'Consumable' }, evil);
    await expect(provider().verifyPurchase({ signedTransaction: jws })).rejects.toMatchObject({ code: 'iap_signature_invalid' });
  });

  it('EC:N1 security: unsigned, alg-swapped, truncated-chain and tampered JWS are rejected', async () => {
    const good = await seed({ transactionId: 't-tamper', productId: 'x', purchaseDate: Date.now(), type: 'Consumable' });
    const [h, b, s] = good.split('.');
    const header = JSON.parse(Buffer.from(h, 'base64url').toString());
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const tampered = b64({ ...JSON.parse(Buffer.from(b, 'base64url').toString()), price: 1 });
    const cases = [
      `${b64({ alg: 'none' })}.${b}.`,
      `${b64({ ...header, alg: 'HS256' })}.${b}.${s}`,
      `${b64({ ...header, x5c: header.x5c.slice(0, 2) })}.${b}.${s}`,
      `${h}.${tampered}.${s}`,
      'not-a-jws',
    ];
    for (const c of cases) await expect(provider().verifyPurchase({ signedTransaction: c })).rejects.toMatchObject({ code: 'iap_signature_invalid' });
  });

  it('EC:E3 the kit authenticates to the App Store Server API with a valid ES256 JWT', async () => {
    const jws = await seed({ transactionId: 't-auth', productId: 'x', purchaseDate: Date.now(), type: 'Consumable', price: 1100000, currency: 'KRW' });
    const wrongKey = readFileSync(join(mock.chainDir, 'leaf.key'), 'utf8');
    await expect(provider({ privateKey: wrongKey }).verifyPurchase({ signedTransaction: jws })).rejects.toMatchObject({ code: 'provider' });
    const v = await provider().verifyPurchase({ signedTransaction: jws });
    expect(v.payment).toMatchObject({ kind: 'topup', subscriptionId: null, amount: { amountMinor: 1100, currency: 'KRW' } });
  });

  it('EC:N5 family-shared transactions are reported as such', async () => {
    const jws = await seed({ transactionId: 't-fam', productId: 'x', purchaseDate: Date.now(), expiresDate: Date.now() + DAY, inAppOwnershipType: 'FAMILY_SHARED' });
    expect((await provider().verifyPurchase({ signedTransaction: jws })).ownership).toBe('family_shared');
  });
});

describe('apple notifications', () => {
  it('EC:E16 N13 DID_RENEW maps to payment.succeeded with store refs', async () => {
    const now = Date.now();
    await seed({ transactionId: 't-200', productId: 'pro.monthly', purchaseDate: now - 31 * DAY, expiresDate: now - DAY, price: 9990 });
    const body = await note({ notificationType: 'DID_RENEW', transaction: { transactionId: 't-201', originalTransactionId: 't-200', productId: 'pro.monthly', purchaseDate: now - DAY, expiresDate: now + 29 * DAY, price: 9990, type: 'Auto-Renewable Subscription', environment: 'Sandbox', bundleId: BUNDLE, currency: 'USD' } });
    const ev = await provider().verifyWebhook({ headers: {}, rawBody: body });
    expect(ev).toMatchObject({ provider: 'apple', type: 'payment.succeeded', paymentRef: 't-201', subscriptionRef: 't-200', amount: { amountMinor: 999, currency: 'USD' } });
    const pay = await provider().getPayment('t-201');
    expect(pay).toMatchObject({ subscriptionId: 't-200', kind: 'subscription', status: 'succeeded' });
  });

  it('EC:N6 REFUND maps to refund.created with a refund ref and the transaction amount', async () => {
    const body = await note({ notificationType: 'REFUND', transaction: { transactionId: 't-100', revocationDate: Date.now() } });
    const ev = await provider().verifyWebhook({ headers: {}, rawBody: body });
    expect(ev).toMatchObject({ type: 'refund.created', paymentRef: 't-100', refundRef: 'apple-refund:t-100', amount: { amountMinor: 999 } });
  });

  it('EC:N1 security: notifications signed by another chain, for another app, or Production without appAppleId are rejected', async () => {
    await expect(provider().verifyWebhook({ headers: {}, rawBody: await note({ notificationType: 'TEST', evil: true }) })).rejects.toMatchObject({ code: 'webhook_signature' });
    await expect(provider().verifyWebhook({ headers: {}, rawBody: await note({ notificationType: 'TEST', data: { bundleId: 'com.other' } }) })).rejects.toMatchObject({ code: 'webhook_signature' });
    const prod = await note({ notificationType: 'TEST', data: { environment: 'Production', appAppleId: 999 } });
    await expect(provider().verifyWebhook({ headers: {}, rawBody: prod })).rejects.toMatchObject({ code: 'webhook_signature' });
    await expect(provider({ appAppleId: null }).verifyWebhook({ headers: {}, rawBody: prod })).rejects.toMatchObject({ code: 'webhook_signature' });
    await expect(provider().verifyWebhook({ headers: {}, rawBody: '{}' })).rejects.toMatchObject({ code: 'webhook_signature' });
  });

  it('EC:N14 unknown or newer notification types map to unknown and are logged', async () => {
    const logger = new CollectingLogger();
    const ev = await provider({}, logger).verifyWebhook({ headers: {}, rawBody: await note({ notificationType: 'METADATA_UPDATE' }) });
    expect(ev.type).toBe('unknown');
    expect(logger.entries.some((e) => e.event === 'webhook.unmapped' && e.providerErrorCode === 'METADATA_UPDATE')).toBe(true);
  });

  it('getSubscription reads status and renewal info (grace, auto-renew off)', async () => {
    await fetch(`${mock.url}/__mock/status`, { method: 'POST', body: JSON.stringify({ originalTransactionId: 't-200', status: 4, autoRenewStatus: 0, gracePeriodExpiresDate: Date.now() + 3 * DAY }) });
    const sub = await provider().getSubscription('t-200');
    expect(sub).toMatchObject({ providerRef: 't-200', status: 'past_due', cancelAtPeriodEnd: true });
    expect(sub.graceUntil).toBeInstanceOf(Date);
  });
});
