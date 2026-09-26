import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CollectingLogger } from 'boilpayment-core';
import { GooglePlayProvider, periodStartFromExpiry } from '../src/index.js';
// @ts-expect-error — plain .mjs test mock, no types
import { startGoogleMock } from '../../../../../tools/mocks/google-play/server.mjs';

type Mock = Awaited<ReturnType<typeof startGoogleMock>>;
let mock: Mock;
let serviceAccount: { client_email: string; private_key: string; token_uri: string };
const DAY = 86_400_000;

function provider(over: Partial<ConstructorParameters<typeof GooglePlayProvider>[0]> = {}, logger = new CollectingLogger()) {
  return new GooglePlayProvider({
    packageName: mock.packageName, serviceAccount, apiBaseUrl: mock.url, logger,
    pubsub: { audience: mock.audience, serviceAccountEmail: mock.pushEmail, jwksUrl: mock.jwksUrl },
    productIntervals: { 'pro.monthly': 'month' }, ...over,
  });
}
const post = (path: string, body: unknown) => fetch(`${mock.url}${path}`, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json());
const push = (body: unknown) => post('/__mock/push', body) as Promise<{ headers: Record<string, string>; body: string }>;
const sub = (token: string, over: Record<string, unknown> = {}) => post('/__mock/subscriptions', {
  token, subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE', startTime: new Date(Date.now() - DAY).toISOString(),
  acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING', externalAccountIdentifiers: { obfuscatedExternalAccountId: 'acct-1' }, testPurchase: {},
  lineItems: [{ productId: 'pro.monthly', expiryTime: '2026-03-31T10:00:00.000Z', latestSuccessfulOrderId: 'GPA.1-1', autoRenewingPlan: { autoRenewEnabled: true, recurringPrice: { currencyCode: 'USD', units: '9', nanos: 990000000 } } }],
  ...over,
});

beforeAll(async () => {
  mock = await startGoogleMock();
  serviceAccount = await fetch(`${mock.url}/__mock/service-account`).then((r) => r.json());
});
afterAll(async () => { await mock.close(); });

describe('google play verifyPurchase', () => {
  it('EC:N1 verifies a subscription token, derives the period, reads account id and ack state', async () => {
    await sub('tok-1');
    const v = await provider().verifyPurchase({ purchaseToken: 'tok-1', productId: 'pro.monthly', subscription: true });
    expect(v.payment).toMatchObject({ providerRef: 's|tok-1|GPA.1-1', subscriptionId: 'tok-1', kind: 'subscription', status: 'succeeded', amount: { amountMinor: 999, currency: 'USD' }, customerId: 'acct-1' });
    expect(v.payment.period).toEqual({ start: new Date('2026-02-28T10:00:00.000Z'), end: new Date('2026-03-31T10:00:00.000Z') });
    expect(v).toMatchObject({ subscriptionRef: 'tok-1', accountToken: 'acct-1', environment: 'sandbox', acknowledged: false, amountFromStore: true });
  });

  it('EC:N3 security: a token for another package (wrong packageName config) is not found', async () => {
    await expect(provider({ packageName: 'com.other.app' }).verifyPurchase({ purchaseToken: 'tok-1', productId: 'pro.monthly', subscription: true })).rejects.toMatchObject({ code: 'iap_purchase_not_found' });
  });

  it('EC:N11 one-time product: no store price, sandbox from purchaseType 0, ack state from products.get', async () => {
    await post('/__mock/products', { productId: 'coins.100', token: 'ptok-1', purchaseState: 0, purchaseTimeMillis: String(Date.now()), acknowledgementState: 0, purchaseType: 0, orderId: 'GPA.9', obfuscatedExternalAccountId: 'acct-1' });
    const v = await provider().verifyPurchase({ purchaseToken: 'ptok-1', productId: 'coins.100', subscription: false });
    expect(v).toMatchObject({ amountFromStore: false, environment: 'sandbox', acknowledged: false, subscriptionRef: null, productId: 'coins.100' });
    expect(v.payment).toMatchObject({ providerRef: 'p|coins.100|ptok-1', kind: 'topup', status: 'succeeded' });
  });

  it('EC:N1 acknowledge is idempotent and only POSTs while pending', async () => {
    const p = provider();
    await p.acknowledge('s|tok-1|GPA.1-1');
    await p.acknowledge('s|tok-1|GPA.1-1');
    await p.acknowledge('p|coins.100|ptok-1');
    const { calls } = (await fetch(`${mock.url}/__mock/acks`).then((r) => r.json())) as { calls: { token: string }[] };
    expect(calls.filter((c) => c.token === 'tok-1')).toHaveLength(1);
    expect(calls.filter((c) => c.token === 'ptok-1')).toHaveLength(1);
  });

  it('EC:N9 linkedPurchaseToken is reported as the replaced subscription', async () => {
    await sub('tok-2', { linkedPurchaseToken: 'tok-1' });
    expect((await provider().verifyPurchase({ purchaseToken: 'tok-2', subscription: true })).replacesSubscriptionRef).toBe('tok-1');
  });

  it('EC:N9 period start = expiry minus the interval, clamped to month end', () => {
    expect(periodStartFromExpiry(new Date('2026-03-31T00:00:00Z'), 'month').toISOString()).toBe('2026-02-28T00:00:00.000Z');
    expect(periodStartFromExpiry(new Date('2026-01-15T05:00:00Z'), 'month').toISOString()).toBe('2025-12-15T05:00:00.000Z');
    expect(periodStartFromExpiry(new Date('2028-02-29T00:00:00Z'), 'year').toISOString()).toBe('2027-02-28T00:00:00.000Z');
  });
});

describe('google play RTDN push', () => {
  const renewed = { subscriptionNotification: { version: '1.0', notificationType: 2, purchaseToken: 'tok-1', subscriptionId: 'pro.monthly' } };

  it('EC:E16 SUBSCRIPTION_RENEWED maps to payment.succeeded with the latest order ref', async () => {
    const { headers, body } = await push({ notification: renewed, messageId: 'm-1' });
    const ev = await provider().verifyWebhook({ headers, rawBody: body });
    expect(ev).toMatchObject({ id: 'm-1', type: 'payment.succeeded', subscriptionRef: 'tok-1', paymentRef: 's|tok-1|GPA.1-1', amount: { amountMinor: 999 } });
  });

  it('EC:N1 security: push without OIDC token, with a foreign signer, wrong audience, wrong sender or expired is rejected', async () => {
    for (const bad of [{ sign: 'none' }, { sign: 'evil' }, { audience: 'https://attacker.test' }, { email: 'someone@else.iam.gserviceaccount.com' }, { expired: true }]) {
      const { headers, body } = await push({ notification: renewed, ...bad });
      await expect(provider().verifyWebhook({ headers, rawBody: body })).rejects.toMatchObject({ code: 'webhook_signature' });
    }
  });

  it('EC:N3 security: a notification for another package is rejected', async () => {
    const { headers, body } = await push({ notification: { ...renewed, packageName: 'com.other.app' } });
    await expect(provider().verifyWebhook({ headers, rawBody: body })).rejects.toMatchObject({ code: 'webhook_signature' });
  });

  it('EC:N6 voided purchases map to refund.created (amount resolved later from the local payment)', async () => {
    const { headers, body } = await push({ notification: { voidedPurchaseNotification: { purchaseToken: 'ptok-1', orderId: 'GPA.9', productType: 2, refundType: 1 } } });
    const ev = await provider().verifyWebhook({ headers, rawBody: body });
    expect(ev).toMatchObject({ type: 'refund.created', paymentRef: 'p|?|ptok-1', refundRef: 'gp-void:GPA.9', amount: null });
  });

  it('EC:N14 unknown subscription notification types map to unknown and are logged', async () => {
    const logger = new CollectingLogger();
    const { headers, body } = await push({ notification: { subscriptionNotification: { version: '1.0', notificationType: 20, purchaseToken: 'tok-1' } } });
    expect((await provider({}, logger).verifyWebhook({ headers, rawBody: body })).type).toBe('unknown');
    expect(logger.entries.some((e) => e.event === 'webhook.unmapped')).toBe(true);
  });

  it('cancelSubscription turns auto-renew off at period end', async () => {
    const s = await provider().cancelSubscription('tok-1', { atPeriodEnd: true });
    expect(s).toMatchObject({ providerRef: 'tok-1', cancelAtPeriodEnd: true });
  });
});
