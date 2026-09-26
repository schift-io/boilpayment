// EC:L5 — withCorrelationId() scopes every `provider.request` log line from the returned clone to
// a fixed correlationId, overriding the idempotencyKey-derived default, without touching the
// PaymentProvider interface (duck-typed, not declared there — see spec/webhook.pseudo.md [EC:L5]).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CollectingLogger } from '@schift/payment-kit-core';
import { StripeProvider } from '../src/index.js';
import { installHttpMock, type HttpMock } from './helpers/mockHttp.js';

const HOST = '127.0.0.1';
const PORT = 8935;

let mock: HttpMock;
beforeEach(() => {
  mock = installHttpMock();
});
afterEach(() => {
  mock.restore();
});

describe('[EC:L5] StripeProvider.withCorrelationId', () => {
  it('overrides the logged correlationId (default falls back to idempotencyKey)', async () => {
    const logger = new CollectingLogger();
    const provider = new StripeProvider({
      secretKey: 'sk_test_dummy',
      webhookSecret: 'whsec_unused',
      apiBase: { host: HOST, port: PORT, protocol: 'http' },
      logger,
    });
    mock.respondJson(200, { id: 'cus_default' });
    await provider.createCustomer({ email: 'a@example.com' });
    const defaultEntry = logger.entries.find((e) => e.event === 'provider.request');
    expect(defaultEntry?.correlationId ?? null).toBeFalsy(); // createCustomer has no idempotencyKey

    const scoped = provider.withCorrelationId('corr_evt_123');
    mock.respondJson(200, { id: 'cus_scoped' });
    await scoped.createCustomer({ email: 'b@example.com' });
    const scopedEntry = [...logger.entries].reverse().find((e) => e.event === 'provider.request');
    expect(scopedEntry?.correlationId).toBe('corr_evt_123');

    // the original instance is unaffected by the clone
    mock.respondJson(200, { id: 'cus_default_2' });
    await provider.createCustomer({ email: 'c@example.com' });
    const stillDefault = [...logger.entries].reverse().find((e) => e.event === 'provider.request');
    expect(stillDefault?.correlationId ?? null).toBeFalsy();
  });
});
