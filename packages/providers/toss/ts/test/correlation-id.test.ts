// EC:L5 — withCorrelationId() scopes every `provider.request` log line from the returned clone to
// a fixed correlationId, overriding the idempotencyKey-derived default, without touching the
// PaymentProvider interface (duck-typed, not declared there).
import { describe, it, expect } from 'vitest';
import { CollectingLogger } from '@schift/payment-kit-core';
import { TossProvider } from '../src/index.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('[EC:L5] TossProvider.withCorrelationId', () => {
  it('overrides the logged correlationId (default falls back to idempotencyKey — null for a GET)', async () => {
    const logger = new CollectingLogger();
    let call = 0;
    const fetchStub = (async () => {
      call += 1;
      return jsonResponse({ paymentKey: `pay_${call}`, status: 'DONE', totalAmount: 1000, currency: 'KRW', approvedAt: '2026-01-01T00:00:00Z' });
    }) as unknown as typeof fetch;
    const provider = new TossProvider({ secretKey: 'sk_test', logger }, fetchStub);

    await provider.getPayment('pay_default');
    const defaultEntry = logger.entries.find((e) => e.event === 'provider.request');
    expect(defaultEntry?.correlationId ?? null).toBeFalsy(); // getPayment is a GET, no idempotencyKey

    const scoped = provider.withCorrelationId('corr_evt_123');
    await scoped.getPayment('pay_scoped');
    const scopedEntry = [...logger.entries].reverse().find((e) => e.event === 'provider.request');
    expect(scopedEntry?.correlationId).toBe('corr_evt_123');

    // the original instance is unaffected by the clone
    await provider.getPayment('pay_default_2');
    const stillDefault = [...logger.entries].reverse().find((e) => e.event === 'provider.request');
    expect(stillDefault?.correlationId ?? null).toBeFalsy();
  });
});
