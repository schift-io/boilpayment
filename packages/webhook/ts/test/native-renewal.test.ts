// EC:E16 — a native provider (Stripe/Polar) renews on its own and sends payment.succeeded for a
// NEW invoice. No local Payment row exists for that invoice yet; the local subscription does.
import { describe, expect, it } from 'vitest';
import { CollectingNotifier, DEFAULT_POLICY, FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen } from 'boilpayment-core';
import type { CsCase, NormalizedEvent, Payment, Subscription } from 'boilpayment-core';
import type { LifecycleDeps } from '../src/index.js';
import { defaultHandlers, process as processWebhook, receive } from '../src/index.js';
import { FakeProvider, jsonVerify } from './helpers.js';

const period2 = { start: new Date('2026-03-01T00:00:00Z'), end: new Date('2026-04-01T00:00:00Z') };

function setup(
  providerPayment: Partial<Payment> = {},
  subscriptionStatus: Subscription['status'] = 'active',
  providerSubscriptionStatus: Subscription['status'] = subscriptionStatus,
) {
  const clock = new FixedClock(new Date('2026-03-01T00:05:00Z'));
  const repo = new InMemoryRepo();
  const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
  const notifier = new CollectingNotifier();
  const sub: Subscription = {
    id: 'sub_local', customerId: 'cust_1', planId: 'plan_pro', provider: 'stripe', providerRef: 'sub_123',
    status: subscriptionStatus, currentPeriod: { start: new Date('2026-02-01T00:00:00Z'), end: period2.start },
    anchorDay: 1, cancelAtPeriodEnd: false, graceUntil: null, billingKey: null, scheduledPlanId: null, version: 0, createdAt: clock.now(),
  };
  const remote: Payment = {
    id: 'in_renew_2', customerId: '', provider: 'stripe', providerRef: 'in_renew_2', subscriptionId: 'sub_123',
    amount: { amountMinor: 2000, currency: 'USD' }, status: 'succeeded', kind: 'subscription', period: period2,
    occurredAt: clock.now(), failure: null, cashReceipt: null, raw: { invoice: 'provider-raw' }, ...providerPayment,
  };
  const provider = new FakeProvider({
    name: 'stripe', verify: jsonVerify('stripe'),
    getPaymentImpl: () => remote,
    getSubscriptionImpl: () => ({ ...sub, status: providerSubscriptionStatus, currentPeriod: period2 }),
  });
  const renewed: { sub: string; payment: Payment }[] = [];
  const failed: Subscription[] = [];
  const lifecycle: LifecycleDeps = {
    onRenewalPaid: async (input) => { renewed.push({ sub: input.sub.id, payment: input.payment as Payment }); },
    dunning: { onPaymentFailed: async (input) => { failed.push(input.sub); } },
  };
  const handlers = defaultHandlers({ policy: DEFAULT_POLICY, ledger, repo, notifier, clock, ids: new SequentialIdGen('pay_'), lifecycle });
  const deliver = async (id: string, type = 'payment.succeeded') => {
    const rawBody = JSON.stringify({ id, type, occurredAt: clock.now().toISOString(), customerRef: 'cus_1', subscriptionRef: 'sub_123', paymentRef: 'in_renew_2' });
    const r = await receive({ provider, headers: { 'x-sig': 'ok' }, rawBody, repo, clock });
    await processWebhook({ eventId: r.eventId!, providers: { stripe: provider }, handlers, repo, clock });
    return repo.webhookEvents.get(r.eventId!);
  };
  return { repo, sub, provider, notifier, renewed, failed, deliver };
}

describe('EC:E16 native renewal — payment row created from the provider, then renewed', () => {
  it('[SB-07] failed renewal verifies the advanced provider period but duns the stored paid period', async () => {
    const t = setup({}, 'active', 'past_due');
    await t.repo.subscriptions.put(t.sub);

    await t.deliver('evt_failed_advanced_period', 'subscription.payment_failed');

    expect(t.provider.getSubscriptionCalled).toBe(true);
    expect(t.failed).toHaveLength(1);
    expect(t.failed[0]?.status).toBe('past_due');
    expect(t.failed[0]?.currentPeriod).toEqual(t.sub.currentPeriod);
  });

  it('[EC:E16] records the renewal invoice for the known subscription and calls onRenewalPaid', async () => {
    const t = setup();
    await t.repo.subscriptions.put(t.sub);
    const record = await t.deliver('evt_renew_1');
    expect(record?.error).toBeNull();
    expect(record?.status).toBe('processed');
    const payments = await t.repo.payments.list({ providerRef: 'in_renew_2' } as Partial<Payment>);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ customerId: 'cust_1', subscriptionId: 'sub_local', kind: 'subscription', status: 'succeeded', amount: { amountMinor: 2000, currency: 'USD' } });
    expect(payments[0]?.raw).toEqual({ invoice: 'provider-raw' });
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

  it.each(['expired', 'canceled'] as const)('[SB-10] parks a late successful renewal for a locally %s subscription exactly once', async (status) => {
    const t = setup({}, status, 'active');
    await t.repo.subscriptions.put(t.sub);

    await t.deliver('evt_late_renewal_1');
    await t.deliver('evt_late_renewal_redelivery');

    expect(t.renewed).toEqual([]);
    expect((await t.repo.subscriptions.get(t.sub.id))?.status).toBe(status);
    const payments = await t.repo.payments.list({ providerRef: 'in_renew_2' } as Partial<Payment>);
    expect(payments).toHaveLength(1);
    const payment = payments[0];
    if (!payment) throw new Error('expected the late renewal payment to be recorded');
    const cases = await t.repo.csCases.list({ referenceId: payment.id } as Partial<CsCase>);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ customerId: 'cust_1', status: 'needs_human', referenceId: payment.id });
    expect(t.notifier.sent.filter((notice) => notice.type === 'cs.needs_human')).toEqual([
      expect.objectContaining({ customerId: 'cust_1', payload: expect.objectContaining({ paymentId: payment.id }) }),
    ]);
  });
});

describe('SB-03 Stripe trial subscription checkout persistence', () => {
  it('[SB-03] persists the trialing subscription without credits, then grants the first paid invoice once', async () => {
    const clock = new FixedClock(new Date('2026-03-01T00:00:00Z'));
    const repo = new InMemoryRepo();
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const notifier = new CollectingNotifier();
    const checkoutId = 'cs_trial_1';
    const subscriptionRef = 'sub_trial_1';
    const subscriptionId = `subscription:stripe:${subscriptionRef}`;
    const trialPeriod = { start: clock.now(), end: new Date('2026-03-15T00:00:00Z') };
    const paidPeriod = { start: trialPeriod.end, end: new Date('2026-04-15T00:00:00Z') };
    let remoteStatus: Subscription['status'] = 'trialing';
    const remoteSub: Subscription = {
      id: subscriptionRef, customerId: 'cus_provider', planId: 'provider_plan', provider: 'stripe', providerRef: subscriptionRef,
      status: 'trialing', currentPeriod: trialPeriod, anchorDay: 15, cancelAtPeriodEnd: false, graceUntil: null,
      billingKey: null, scheduledPlanId: null, version: 0, createdAt: clock.now(),
    };
    const renewal: Payment = {
      id: 'in_trial_paid', customerId: '', provider: 'stripe', providerRef: 'in_trial_paid', subscriptionId: subscriptionRef,
      amount: { amountMinor: 2000, currency: 'USD' }, status: 'succeeded', kind: 'subscription', period: paidPeriod,
      occurredAt: paidPeriod.start, failure: null, cashReceipt: null,
    };
    const verify = ({ rawBody }: { headers: Record<string, string>; rawBody: string }): NormalizedEvent => {
      const raw = JSON.parse(rawBody);
      const object = raw.data.object;
      const checkout = raw.type === 'checkout.session.completed';
      return {
        id: raw.id, provider: 'stripe', type: checkout ? 'subscription.created' : 'payment.succeeded',
        occurredAt: clock.now(), customerRef: object.customer, subscriptionRef: object.subscription,
        paymentRef: checkout ? null : object.id, amount: null, raw,
      };
    };
    const provider = new FakeProvider({
      name: 'stripe', verify,
      getPaymentImpl: () => renewal,
      getSubscriptionImpl: () => ({ ...remoteSub, status: remoteStatus, currentPeriod: remoteStatus === 'trialing' ? trialPeriod : paidPeriod }),
    });
    const lifecycle: LifecycleDeps = {
      onRenewalPaid: async (input) => {
        await input.ledger.append({
          customerId: input.sub.customerId, pool: 'paid', kind: 'grant', amount: 100,
          unitPriceMinor: null, currency: null, expiresAt: input.payment.period?.end ?? null, source: 'subscription',
          reference: { subscriptionId: input.sub.id, paymentId: input.payment.id },
          idempotencyKey: `renewal:${input.payment.id}`, actor: 'system', reason: null,
        });
      },
      dunning: { onPaymentFailed: async () => {} },
    };
    await repo.operations.put({
      id: `checkout-entitlement-by-id:${checkoutId}`, key: `checkout-entitlement-by-id:${checkoutId}`,
      kind: 'checkout.entitlement', payloadHash: 'snapshot', status: 'done',
      result: { customerId: 'cust_local', provider: 'stripe', plan: { id: 'plan_trial' }, price: { currency: 'USD' } },
      error: null, createdAt: clock.now(), completedAt: clock.now(), attempts: 1,
    });
    const handlers = defaultHandlers({ policy: DEFAULT_POLICY, ledger, repo, notifier, clock, ids: new SequentialIdGen('pay_'), lifecycle });
    const deliver = async (raw: Record<string, unknown>) => {
      const received = await receive({ provider, headers: {}, rawBody: JSON.stringify(raw), repo, clock });
      await processWebhook({ eventId: received.eventId!, providers: { stripe: provider }, handlers, repo, clock });
      return repo.webhookEvents.get(received.eventId!);
    };

    const created = await deliver({
      id: 'evt_trial_created', type: 'checkout.session.completed',
      data: { object: { id: checkoutId, mode: 'subscription', customer: 'cus_provider', subscription: subscriptionRef } },
    });
    expect(created?.status).toBe('processed');
    expect(await repo.subscriptions.get(subscriptionId)).toMatchObject({
      id: subscriptionId, customerId: 'cust_local', planId: 'plan_trial', provider: 'stripe', providerRef: subscriptionRef,
      currency: 'USD', status: 'trialing', currentPeriod: trialPeriod,
    });
    expect((await ledger.balance('cust_local', 'paid', clock.now())).available).toBe(0);

    remoteStatus = 'active';
    const paid = await deliver({
      id: 'evt_trial_paid', type: 'invoice.paid',
      data: { object: { id: renewal.providerRef, customer: 'cus_provider', subscription: subscriptionRef } },
    });
    expect(paid?.status).toBe('processed');
    expect((await ledger.balance('cust_local', 'paid', paidPeriod.start)).available).toBe(100);
    expect(await repo.payments.list({ providerRef: renewal.providerRef } as Partial<Payment>)).toHaveLength(1);
  });

  it('[SB-03] ignores a direct dashboard subscription without checkout snapshot evidence', async () => {
    const clock = new FixedClock(new Date('2026-03-01T00:00:00Z'));
    const repo = new InMemoryRepo();
    const remote: Subscription = {
      id: 'sub_dashboard', customerId: 'cus_provider', planId: 'provider_plan', provider: 'stripe', providerRef: 'sub_dashboard',
      status: 'trialing', currentPeriod: { start: clock.now(), end: new Date('2026-03-15T00:00:00Z') }, anchorDay: 15,
      cancelAtPeriodEnd: false, graceUntil: null, billingKey: null, scheduledPlanId: null, version: 0, createdAt: clock.now(),
    };
    const provider = new FakeProvider({
      name: 'stripe',
      verify: () => ({ id: 'evt_dashboard', provider: 'stripe', type: 'subscription.created', occurredAt: clock.now(),
        customerRef: 'cus_provider', subscriptionRef: remote.providerRef, paymentRef: null, amount: null,
        raw: { type: 'customer.subscription.created', data: { object: { id: remote.providerRef } } } }),
      getSubscriptionImpl: () => remote,
    });
    const handlers = defaultHandlers({ policy: DEFAULT_POLICY, ledger: new InMemoryLedger(new SequentialIdGen('led_')),
      repo, notifier: new CollectingNotifier(), clock, ids: new SequentialIdGen('pay_') });
    const received = await receive({ provider, headers: {}, rawBody: '{}', repo, clock });
    await processWebhook({ eventId: received.eventId!, providers: { stripe: provider }, handlers, repo, clock });

    expect(await repo.subscriptions.list()).toEqual([]);
    expect(provider.getSubscriptionCalled).toBe(false);
  });
});
