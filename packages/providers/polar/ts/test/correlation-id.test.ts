// EC:L5 — withCorrelationId() scopes every `provider.request` log line from the returned clone to
// a fixed correlationId, overriding the Idempotency-Key-header-derived default, without touching
// the PaymentProvider interface (duck-typed, not declared there).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollectingLogger } from 'boilpayment-core';
import { PolarProvider } from '../src/index.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('[EC:L5] PolarProvider.withCorrelationId', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('overrides the logged correlationId (default falls back to Idempotency-Key)', async () => {
    const logger = new CollectingLogger();
    const provider = new PolarProvider({ accessToken: 'polar_at_dummy', webhookSecret: 'whsec_x', server: 'sandbox', logger });

    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'cust_default' }));
    await provider.createCustomer({ email: 'a@example.com' });
    const defaultEntry = logger.entries.find((e) => e.event === 'provider.request');
    expect(defaultEntry?.correlationId ?? null).toBeFalsy(); // createCustomer sends no Idempotency-Key

    const scoped = provider.withCorrelationId('corr_evt_123');
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'cust_scoped' }));
    await scoped.createCustomer({ email: 'b@example.com' });
    const scopedEntry = [...logger.entries].reverse().find((e) => e.event === 'provider.request');
    expect(scopedEntry?.correlationId).toBe('corr_evt_123');

    // the original instance is unaffected by the clone
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'cust_default_2' }));
    await provider.createCustomer({ email: 'c@example.com' });
    const stillDefault = [...logger.entries].reverse().find((e) => e.event === 'provider.request');
    expect(stillDefault?.correlationId ?? null).toBeFalsy();
  });
});
