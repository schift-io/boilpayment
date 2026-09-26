// EC:L5 — withCorrelationId() scopes every `provider.request` log line from the returned clone to
// a fixed correlationId. PortOne's request() has no per-call idempotencyKey at all (unlike the
// other 3 providers), so before this change every portone `provider.request` log line had no
// correlationId whatsoever; withCorrelationId() is the only source now.
import { describe, it, expect } from 'vitest';
import { CollectingLogger } from 'boilpayment-core';
import { PortoneProvider } from '../src/index.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('[EC:L5] PortoneProvider.withCorrelationId', () => {
  it('overrides the logged correlationId (default is null — request() has no idempotencyKey at all)', async () => {
    const logger = new CollectingLogger();
    let call = 0;
    const fetchStub = (async () => {
      call += 1;
      return jsonResponse({ id: `pay_${call}`, status: 'PAID', amount: { total: 1000 }, currency: 'KRW', paidAt: '2026-01-01T00:00:00Z' });
    }) as unknown as typeof fetch;
    const provider = new PortoneProvider({ apiSecret: 'secret', storeId: 'store_1', webhookSecret: 'whsec_x', logger }, fetchStub);

    await provider.getPayment('pay_default');
    const defaultEntry = logger.entries.find((e) => e.event === 'provider.request');
    expect(defaultEntry?.correlationId ?? null).toBeFalsy();

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
