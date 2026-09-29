// Phase 6 regression tests — packages/webhook/ts/src/process.ts + handlers.ts wiring.
// Ground truth measured via `tsx packages/webhook/ts/examples/smoke.ts` this session.
import { describe, expect, it } from 'vitest';
import { CollectingNotifier, DEFAULT_POLICY, FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen } from 'boilpayment-core';
import type { HandlerCtx, HandlerMap, LifecycleDeps } from '../src/index.js';
import { defaultHandlers, process as processWebhook, receive } from '../src/index.js';
import { FakeProvider, jsonVerify } from './helpers.js';

function setup() {
  const clock = new FixedClock(new Date('2026-02-02T00:00:00Z'));
  const repo = new InMemoryRepo();
  return { clock, repo };
}

describe('webhook.process — dispatch and status transitions', () => {
  it('[EC:process] dispatches to the registered handler for the event type and marks the record processed', async () => {
    const { clock, repo } = setup();
    const provider = new FakeProvider({ verify: jsonVerify() });
    const rawBody = JSON.stringify({ id: 'evt_dispatch', type: 'payment.succeeded', occurredAt: clock.now().toISOString() });
    const r = await receive({ provider, headers: { 'x-sig': 'ok' }, rawBody, repo, clock });

    const calls: HandlerCtx[] = [];
    const handlers: HandlerMap = { 'payment.succeeded': async (ctx) => { calls.push(ctx); } };
    await processWebhook({ eventId: r.eventId!, providers: { stripe: provider }, handlers, repo, clock });

    const record = await repo.webhookEvents.get(r.eventId!);
    expect(record?.status).toBe('processed');
    expect(record?.processedAt).not.toBeNull();
    expect(record?.error).toBeNull();
    expect(record?.attempts).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].event.id).toBe('evt_dispatch');
  });

  it('[EC:process] marks the record failed on handler error, and a retry increments attempts and can succeed', async () => {
    const { clock, repo } = setup();
    const provider = new FakeProvider({ verify: jsonVerify() });
    const rawBody = JSON.stringify({ id: 'evt_retry', type: 'payment.succeeded', occurredAt: clock.now().toISOString() });
    const r = await receive({ provider, headers: { 'x-sig': 'ok' }, rawBody, repo, clock });

    const handlers: HandlerMap = { 'payment.succeeded': async () => { throw new Error('boom'); } };
    await processWebhook({ eventId: r.eventId!, providers: { stripe: provider }, handlers, repo, clock });

    let record = await repo.webhookEvents.get(r.eventId!);
    expect(record?.status).toBe('failed');
    expect(record?.error).toBe('boom');
    expect(record?.attempts).toBe(1);

    // simulate processPending() retrying the same failed record after the handler is fixed
    handlers['payment.succeeded'] = async () => {};
    await processWebhook({ eventId: r.eventId!, providers: { stripe: provider }, handlers, repo, clock });

    record = await repo.webhookEvents.get(r.eventId!);
    expect(record?.status).toBe('processed');
    expect(record?.error).toBeNull();
    expect(record?.attempts).toBe(2);
  });

  it('[EC:E3] an event whose paymentRef does not resolve to a known local payment fails the record with unknown_provider_ref and notifies reconcile.mismatch', async () => {
    const { clock, repo } = setup();
    const provider = new FakeProvider({
      name: 'stripe',
      verify: jsonVerify('stripe'),
      getPaymentImpl: () => ({
        id: 'pi_UNKNOWN', customerId: '', provider: 'stripe', providerRef: 'pi_UNKNOWN', subscriptionId: null,
        amount: { amountMinor: 1000, currency: 'USD' }, status: 'succeeded', kind: 'topup', period: null,
        occurredAt: clock.now(), failure: null, cashReceipt: null, saleEvidence: null,
      }),
    });
    const notifier = new CollectingNotifier();
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));

    const rawBody = JSON.stringify({
      id: 'evt_unknown_ref', type: 'payment.succeeded', occurredAt: clock.now().toISOString(),
      paymentRef: 'pi_UNKNOWN', subscriptionRef: 'sub_UNKNOWN',
    });
    const r = await receive({ provider, headers: { 'x-sig': 'ok' }, rawBody, repo, clock });

    const handlers = defaultHandlers({ policy: DEFAULT_POLICY, ledger, repo, notifier, clock, ids: new SequentialIdGen('id_') });
    await processWebhook({ eventId: r.eventId!, providers: { stripe: provider }, handlers, repo, clock });

    const record = await repo.webhookEvents.get(r.eventId!);
    expect(record?.status).toBe('failed');
    expect(record?.error).toBe('unknown_provider_ref');

    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]).toEqual({
      type: 'reconcile.mismatch',
      customerId: null,
      payload: { kind: 'payment', providerRef: 'pi_UNKNOWN', provider: 'stripe' },
    });
  });
});

describe('webhook.process — nativeSubscriptions=false capability gating (EC:F)', () => {
  it('[EC:F] skips provider.getSubscription() entirely for a subscription-linked payment.succeeded event', async () => {
    const { clock, repo } = setup();
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const notifier = new CollectingNotifier();

    const sub = {
      id: 'sub_local', customerId: 'cust_1', planId: 'plan_pro', provider: 'toss' as const, providerRef: 'toss_sub_1',
      status: 'active' as const, currentPeriod: { start: new Date('2026-02-01T00:00:00Z'), end: new Date('2026-03-01T00:00:00Z') },
      anchorDay: 1, cancelAtPeriodEnd: false, graceUntil: null, billingKey: 'bk_1', scheduledPlanId: null, createdAt: clock.now(),
    };
    const payment = {
      id: 'pay_local', customerId: 'cust_1', provider: 'toss' as const, providerRef: 'toss_pi_1', subscriptionId: sub.id,
      amount: { amountMinor: 1000, currency: 'KRW' }, status: 'succeeded' as const, kind: 'subscription' as const,
      period: sub.currentPeriod, occurredAt: clock.now(), failure: null,
    };
    await repo.subscriptions.put(sub);
    await repo.payments.put(payment);

    const provider = new FakeProvider({
      name: 'toss',
      nativeSubscriptions: false,
      verify: jsonVerify('toss'),
      getPaymentImpl: () => payment,
      getSubscriptionImpl: () => { throw new Error('getSubscription must never be called when nativeSubscriptions=false'); },
    });

    const lifecycleCalls: string[] = [];
    const lifecycle: LifecycleDeps = {
      onRenewalPaid: async (input) => { lifecycleCalls.push(input.sub.id); },
      dunning: { onPaymentFailed: async () => {} },
    };
    const handlers = defaultHandlers({ policy: DEFAULT_POLICY, ledger, repo, notifier, clock, ids: new SequentialIdGen('id_'), lifecycle });

    const rawBody = JSON.stringify({
      id: 'evt_toss_sub', type: 'payment.succeeded', occurredAt: clock.now().toISOString(),
      paymentRef: payment.providerRef, subscriptionRef: sub.providerRef,
    });
    const r = await receive({ provider, headers: { 'x-sig': 'ok' }, rawBody, repo, clock });
    // process() must not throw even though getSubscriptionImpl would throw if called
    await processWebhook({ eventId: r.eventId!, providers: { toss: provider }, handlers, repo, clock });

    const record = await repo.webhookEvents.get(r.eventId!);
    expect(record?.status).toBe('processed');
    expect(provider.getSubscriptionCalled).toBe(false);
    expect(provider.getPaymentCalled).toBe(true);
    expect(lifecycleCalls).toEqual(['sub_local']);
  });

  it('[EC:F] a payment-only event (no subscriptionRef) still processes normally with nativeSubscriptions=false', async () => {
    const { clock, repo } = setup();
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const notifier = new CollectingNotifier();

    const payment = {
      id: 'pay_local2', customerId: 'cust_1', provider: 'toss' as const, providerRef: 'toss_pi_2', subscriptionId: null,
      amount: { amountMinor: 500, currency: 'KRW' }, status: 'succeeded' as const, kind: 'topup' as const,
      period: null, occurredAt: clock.now(), failure: null,
    };
    await repo.payments.put(payment);

    const provider = new FakeProvider({
      name: 'toss',
      nativeSubscriptions: false,
      verify: jsonVerify('toss'),
      getPaymentImpl: () => payment,
      getSubscriptionImpl: () => { throw new Error('getSubscription must never be called'); },
    });

    // no lifecycle/credits deps injected — payment-only event with no subscriptionRef is a no-op past resolution.
    const handlers = defaultHandlers({ policy: DEFAULT_POLICY, ledger, repo, notifier, clock, ids: new SequentialIdGen('id_') });

    const rawBody = JSON.stringify({ id: 'evt_toss_payment_only', type: 'payment.succeeded', occurredAt: clock.now().toISOString(), paymentRef: payment.providerRef });
    const r = await receive({ provider, headers: { 'x-sig': 'ok' }, rawBody, repo, clock });
    await processWebhook({ eventId: r.eventId!, providers: { toss: provider }, handlers, repo, clock });

    const record = await repo.webhookEvents.get(r.eventId!);
    expect(record?.status).toBe('processed');
    expect(provider.getSubscriptionCalled).toBe(false);
  });
});
