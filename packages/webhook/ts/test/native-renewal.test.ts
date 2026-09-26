// EC:E16 — a native provider (Stripe/Polar) renews on its own and sends payment.succeeded for a
// NEW invoice. No local Payment row exists for that invoice yet; the local subscription does.
import { describe, expect, it } from 'vitest';
import { CollectingNotifier, DEFAULT_POLICY, FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen } from 'boilpayment-core';
import type { Payment, Subscription } from 'boilpayment-core';
import type { LifecycleDeps } from '../src/index.js';
import { defaultHandlers, process as processWebhook, receive } from '../src/index.js';
import { FakeProvider, jsonVerify } from './helpers.js';

const period2 = { start: new Date('2026-03-01T00:00:00Z'), end: new Date('2026-04-01T00:00:00Z') };

function setup(providerPayment: Partial<Payment> = {}) {
  const clock = new FixedClock(new Date('2026-03-01T00:05:00Z'));
  const repo = new InMemoryRepo();
  const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
  const notifier = new CollectingNotifier();
  const sub: Subscription = {
    id: 'sub_local', customerId: 'cust_1', planId: 'plan_pro', provider: 'stripe', providerRef: 'sub_123',
    status: 'active', currentPeriod: { start: new Date('2026-02-01T00:00:00Z'), end: period2.start },
    anchorDay: 1, cancelAtPeriodEnd: false, graceUntil: null, billingKey: null, scheduledPlanId: null, version: 0, createdAt: clock.now(),
  };
  const remote: Payment = {
    id: 'in_renew_2', customerId: '', provider: 'stripe', providerRef: 'in_renew_2', subscriptionId: 'sub_123',
    amount: { amountMinor: 2000, currency: 'USD' }, status: 'succeeded', kind: 'subscription', period: period2,
    occurredAt: clock.now(), failure: null, cashReceipt: null, ...providerPayment,
  };
  const provider = new FakeProvider({
    name: 'stripe', verify: jsonVerify('stripe'),
    getPaymentImpl: () => remote,
    getSubscriptionImpl: () => ({ ...sub, currentPeriod: period2 }),
  });
  const renewed: { sub: string; payment: Payment }[] = [];
  const lifecycle: LifecycleDeps = {
    onRenewalPaid: async (input) => { renewed.push({ sub: input.sub.id, payment: input.payment as Payment }); },
    dunning: { onPaymentFailed: async () => {} },
  };
  const handlers = defaultHandlers({ policy: DEFAULT_POLICY, ledger, repo, notifier, clock, ids: new SequentialIdGen('pay_'), lifecycle });
  const deliver = async (id: string) => {
    const rawBody = JSON.stringify({ id, type: 'payment.succeeded', occurredAt: clock.now().toISOString(), customerRef: 'cus_1', subscriptionRef: 'sub_123', paymentRef: 'in_renew_2' });
    const r = await receive({ provider, headers: { 'x-sig': 'ok' }, rawBody, repo, clock });
    await processWebhook({ eventId: r.eventId!, providers: { stripe: provider }, handlers, repo, clock });
    return repo.webhookEvents.get(r.eventId!);
  };
  return { repo, sub, notifier, renewed, deliver };
}

describe('EC:E16 native renewal — payment row created from the provider, then renewed', () => {
  it('[EC:E16] records the renewal invoice for the known subscription and calls onRenewalPaid', async () => {
    const t = setup();
    await t.repo.subscriptions.put(t.sub);
    const record = await t.deliver('evt_renew_1');
    expect(record?.error).toBeNull();
    expect(record?.status).toBe('processed');
    const payments = await t.repo.payments.list({ providerRef: 'in_renew_2' } as Partial<Payment>);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ customerId: 'cust_1', subscriptionId: 'sub_local', kind: 'subscription', status: 'succeeded', amount: { amountMinor: 2000, currency: 'USD' } });
    expect(t.renewed.map((r) => r.sub)).toEqual(['sub_local']);
    expect(t.renewed[0].payment.id).toBe(payments[0].id);
    expect(t.notifier.sent).toEqual([]);
  });

  it('[EC:E16] a redelivery of the same invoice does not create a second payment row', async () => {
    const t = setup();
    await t.repo.subscriptions.put(t.sub);
    await t.deliver('evt_renew_1');
    await t.deliver('evt_renew_1_again');
    expect(await t.repo.payments.list({ providerRef: 'in_renew_2' } as Partial<Payment>)).toHaveLength(1);
  });

  it('[EC:E16] a provider payment that belongs to another subscription is refused (unknown_provider_ref)', async () => {
    const t = setup({ subscriptionId: 'sub_OTHER' });
    await t.repo.subscriptions.put(t.sub);
    const record = await t.deliver('evt_renew_foreign');
    expect(record?.status).toBe('failed');
    expect(record?.error).toBe('unknown_provider_ref');
    expect(await t.repo.payments.list({ providerRef: 'in_renew_2' } as Partial<Payment>)).toHaveLength(0);
    expect(t.renewed).toEqual([]);
  });

  it('[EC:E16] unknown subscription still fails as an unknown payment, nothing written', async () => {
    const t = setup();
    const record = await t.deliver('evt_renew_nosub');
    expect(record?.error).toBe('unknown_provider_ref');
    expect(t.notifier.sent[0]).toMatchObject({ type: 'reconcile.mismatch', payload: { kind: 'payment', providerRef: 'in_renew_2' } });
    expect(await t.repo.payments.list()).toHaveLength(0);
  });
});
