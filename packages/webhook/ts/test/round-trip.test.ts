// Phase 6 regression test — mirrors examples/e2e/round-trip.ts step 02: webhook.receive +
// webhook.process on a payment.succeeded event drives lifecycle.onRenewalPaid (injected as a
// LifecycleDeps fake, per spec/webhook.pseudo.md — lifecycle is duck-typed, not imported) and
// results in a fresh 100-credit grant; replaying the identical event is a true no-op.
import { describe, expect, it } from 'vitest';
import { CollectingNotifier, DEFAULT_POLICY, FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen } from 'boilpayment-core';
import type { Payment, Subscription } from 'boilpayment-core';
import type { LifecycleDeps } from '../src/index.js';
import { defaultHandlers, process as processWebhook, receive } from '../src/index.js';
import { FakeProvider, jsonVerify } from './helpers.js';

describe('webhook receive+process round trip [EC:E5][EC:E3]', () => {
  it('grants 100 credits via lifecycle.onRenewalPaid on first delivery; replay leaves balance unchanged at 100', async () => {
    const clock = new FixedClock(new Date('2026-01-01T00:00:00Z'));
    const repo = new InMemoryRepo();
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const notifier = new CollectingNotifier();

    const sub: Subscription = {
      id: 'sub1', customerId: 'cust1', planId: 'planA', provider: 'stripe', providerRef: 'sub_1',
      status: 'active', currentPeriod: { start: clock.now(), end: new Date('2026-02-01T00:00:00Z') },
      anchorDay: 1, cancelAtPeriodEnd: false, graceUntil: null, billingKey: null, scheduledPlanId: null, createdAt: clock.now(),
    };
    const payment: Payment = {
      id: 'pay1', customerId: 'cust1', provider: 'stripe', providerRef: 'pay_1', subscriptionId: 'sub1',
      amount: { amountMinor: 1000, currency: 'USD' }, status: 'succeeded', kind: 'subscription',
      period: sub.currentPeriod, occurredAt: clock.now(), failure: null,
    };
    await repo.subscriptions.put(sub);
    await repo.payments.put(payment);

    const provider = new FakeProvider({
      verify: jsonVerify(),
      getPaymentImpl: () => payment,
      getSubscriptionImpl: () => sub,
    });

    // Fake lifecycle.onRenewalPaid: appends a 100-credit grant idempotently keyed by payment id
    // (a real lifecycle package would do the same — see examples/e2e/round-trip.ts line 02, where
    // planA.creditsPerPeriod=100 and the resulting balance is 100).
    const lifecycle: LifecycleDeps = {
      onRenewalPaid: async (input) => {
        await input.ledger.append({
          customerId: input.payment.customerId, pool: 'paid', kind: 'grant', amount: 100,
          unitPriceMinor: null, currency: null, expiresAt: null, source: 'subscription',
          reference: { subscriptionId: input.sub.id, paymentId: input.payment.id },
          idempotencyKey: `renewal:${input.payment.id}`, actor: 'system', reason: null,
        });
      },
      dunning: { onPaymentFailed: async () => {} },
    };
    const handlers = defaultHandlers({ policy: DEFAULT_POLICY, ledger, repo, notifier, clock, ids: new SequentialIdGen('id_'), lifecycle });

    const rawBody = JSON.stringify({
      id: 'evt_1', type: 'payment.succeeded', occurredAt: clock.now().toISOString(),
      subscriptionRef: sub.providerRef, paymentRef: payment.providerRef,
    });

    const r1 = await receive({ provider, headers: { 'x-sig': 'ok' }, rawBody, repo, clock });
    expect(r1.duplicated).toBe(false);
    await processWebhook({ eventId: r1.eventId!, providers: { stripe: provider }, handlers, repo, clock });

    let bal = await ledger.balance('cust1', 'paid', clock.now());
    expect(bal.available).toBe(100);

    // ── replay the identical event: receive() dedupes; even if process() is invoked again on the
    //    same record, the ledger append is idempotent by key, so the balance does not move. ──
    const r2 = await receive({ provider, headers: { 'x-sig': 'ok' }, rawBody, repo, clock });
    expect(r2.duplicated).toBe(true);
    expect(r2.eventId).toBe(r1.eventId);
    await processWebhook({ eventId: r2.eventId!, providers: { stripe: provider }, handlers, repo, clock });

    bal = await ledger.balance('cust1', 'paid', clock.now());
    expect(bal.available).toBe(100);
  });
});
