// Phase 6 regression tests — packages/webhook/ts/src/receive.ts
// Ground truth measured via `tsx packages/webhook/ts/examples/smoke.ts` this session.
import { describe, expect, it } from 'vitest';
import { FixedClock, InMemoryRepo } from '@schift/payment-kit-core';
import { receive } from '../src/index.js';
import { FakeProvider, jsonVerify } from './helpers.js';

function setup() {
  const clock = new FixedClock(new Date('2026-02-02T00:00:00Z'));
  const repo = new InMemoryRepo();
  const provider = new FakeProvider({ verify: jsonVerify() });
  return { clock, repo, provider };
}

describe('webhook.receive', () => {
  it('[EC:E4] bad signature returns 400 and stores nothing in repo.webhookEvents', async () => {
    const { clock, repo, provider } = setup();
    const rawBody = JSON.stringify({ id: 'evt_bad_sig', type: 'payment.succeeded', occurredAt: clock.now().toISOString() });

    const result = await receive({ provider, headers: { 'x-sig': 'nope' }, rawBody, repo, clock });

    expect(result).toEqual({ status: 400, eventId: null, duplicated: null });
    expect(await repo.webhookEvents.list()).toHaveLength(0);
  });

  it('[EC:E5] good signature stores the record with status=received and returns 200', async () => {
    const { clock, repo, provider } = setup();
    const rawBody = JSON.stringify({ id: 'evt_good_sig', type: 'payment.succeeded', occurredAt: clock.now().toISOString() });

    const result = await receive({ provider, headers: { 'x-sig': 'ok' }, rawBody, repo, clock });

    expect(result.status).toBe(200);
    expect(result.eventId).toBe('evt_good_sig');
    expect(result.duplicated).toBe(false);

    const stored = await repo.webhookEvents.get('evt_good_sig');
    expect(stored).not.toBeNull();
    expect(stored?.status).toBe('received');
    expect(stored?.provider).toBe('stripe');
    expect(stored?.type).toBe('payment.succeeded');
    expect(stored?.rawBody).toBe(rawBody);
    expect(stored?.processedAt).toBeNull();
    expect(stored?.error).toBeNull();
    expect(stored?.attempts).toBe(0);
  });

  it('[EC:E5][EC:B12] resend of the identical event id is a no-op (idempotency_key = provider_event_id, UNIQUE)', async () => {
    const { clock, repo, provider } = setup();
    const rawBody = JSON.stringify({ id: 'evt_dup', type: 'payment.succeeded', occurredAt: clock.now().toISOString() });

    const first = await receive({ provider, headers: { 'x-sig': 'ok' }, rawBody, repo, clock });
    expect(first.duplicated).toBe(false);

    const second = await receive({ provider, headers: { 'x-sig': 'ok' }, rawBody, repo, clock });
    expect(second).toEqual({ status: 200, eventId: 'evt_dup', duplicated: true });

    // still exactly one stored record, and the resend did not touch it (attempts untouched by receive()).
    const all = await repo.webhookEvents.list();
    expect(all).toHaveLength(1);
    expect(all[0].attempts).toBe(0);
    expect(all[0].status).toBe('received');
  });

  // EC:I9 finding (2026-09-09, cs.timeline) — WebhookEventRecord now carries customerId/paymentId/
  // subscriptionId, resolved by (provider, providerRef) lookup, so a customer-scoped CS timeline
  // can query webhook_events directly.
  it('[EC:I9] resolves customerId/paymentId from a local Payment matched by (provider, providerRef)', async () => {
    const { clock, repo, provider } = setup();
    await repo.payments.put({
      id: 'pay_local_1', customerId: 'cus_local_1', provider: 'stripe', providerRef: 'pi_stripe_1', subscriptionId: null,
      amount: { amountMinor: 1000, currency: 'USD' }, status: 'succeeded', kind: 'subscription', period: null,
      occurredAt: clock.now(), failure: null, cashReceipt: null,
    });
    const rawBody = JSON.stringify({ id: 'evt_with_payment', type: 'payment.succeeded', occurredAt: clock.now().toISOString(), paymentRef: 'pi_stripe_1' });

    await receive({ provider, headers: { 'x-sig': 'ok' }, rawBody, repo, clock });

    const stored = await repo.webhookEvents.get('evt_with_payment');
    expect(stored?.paymentId).toBe('pay_local_1');
    expect(stored?.customerId).toBe('cus_local_1');
    expect(stored?.subscriptionId).toBeNull();
  });

  it('[EC:I9] leaves customerId/paymentId/subscriptionId null when no local row matches (unknown providerRef)', async () => {
    const { clock, repo, provider } = setup();
    const rawBody = JSON.stringify({ id: 'evt_no_match', type: 'payment.succeeded', occurredAt: clock.now().toISOString(), paymentRef: 'pi_unknown' });

    await receive({ provider, headers: { 'x-sig': 'ok' }, rawBody, repo, clock });

    const stored = await repo.webhookEvents.get('evt_no_match');
    expect(stored?.paymentId).toBeNull();
    expect(stored?.customerId).toBeNull();
    expect(stored?.subscriptionId).toBeNull();
  });
});
