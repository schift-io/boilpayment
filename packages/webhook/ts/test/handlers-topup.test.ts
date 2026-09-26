// Phase 6 regression test — examples/e2e/FINDINGS.md #4 (read-only flag, RESOLVED):
// defaultHandlers' one-time top-up branch (onPaymentSucceeded, no subscriptionRef) now
// REQUIRES resolveTopupCredits(payment) to resolve a credits amount. Unresolved -> the
// webhook record fails with error 'topup_credits_unresolved' instead of a null-amount
// ledger entry. See packages/webhook/ts/src/handlers.ts.
import { describe, expect, it } from 'vitest';
import { CollectingNotifier, DEFAULT_POLICY, FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen, runIdempotent } from 'boilpayment-core';
import type { CreditsDeps, Payment } from 'boilpayment-core';
import { defaultHandlers, process as processWebhook, receive } from '../src/index.js';
import { FakeProvider, jsonVerify } from './helpers.js';

function makeTopupPayment(clock: FixedClock, overrides: Partial<Payment> = {}): Payment {
  return {
    id: 'pay_topup', customerId: 'cust_1', provider: 'stripe', providerRef: 'pi_topup', subscriptionId: null,
    amount: { amountMinor: 999, currency: 'USD' }, status: 'succeeded', kind: 'topup', period: null,
    occurredAt: clock.now(), failure: null, ...overrides,
  };
}

describe('webhook.defaultHandlers — one-time top-up branch [FINDINGS #4]', () => {
  it('[EC:topup] record fails with topup_credits_unresolved when resolveTopupCredits cannot resolve an amount, and credits.topup is never called', async () => {
    const clock = new FixedClock(new Date('2026-02-02T00:00:00Z'));
    const repo = new InMemoryRepo();
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const notifier = new CollectingNotifier();
    const payment = makeTopupPayment(clock);
    await repo.payments.put(payment);

    const provider = new FakeProvider({ verify: jsonVerify(), getPaymentImpl: () => payment });
    const creditsCalls: unknown[] = [];
    const credits: CreditsDeps = { topup: async (input) => { creditsCalls.push(input); } };

    const handlers = defaultHandlers({
      policy: DEFAULT_POLICY, ledger, repo, notifier, clock, ids: new SequentialIdGen('id_'),
      credits, resolveTopupCredits: async () => null,
    });

    const rawBody = JSON.stringify({ id: 'evt_topup_unresolved', type: 'payment.succeeded', occurredAt: clock.now().toISOString(), paymentRef: payment.providerRef });
    const r = await receive({ provider, headers: { 'x-sig': 'ok' }, rawBody, repo, clock });
    await processWebhook({ eventId: r.eventId!, providers: { stripe: provider }, handlers, repo, clock });

    const record = await repo.webhookEvents.get(r.eventId!);
    expect(record?.status).toBe('failed');
    expect(record?.error).toBe('topup_credits_unresolved');
    expect(creditsCalls).toHaveLength(0);
  });

  it('[EC:topup] succeeds and calls credits.topup with the resolved credits amount when resolveTopupCredits resolves', async () => {
    const clock = new FixedClock(new Date('2026-02-02T00:00:00Z'));
    const repo = new InMemoryRepo();
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const notifier = new CollectingNotifier();
    const payment = makeTopupPayment(clock, { id: 'pay_topup2', providerRef: 'pi_topup2' });
    await repo.payments.put(payment);

    const provider = new FakeProvider({ verify: jsonVerify(), getPaymentImpl: () => payment });
    const creditsCalls: Array<{ customerId: string; credits: number }> = [];
    const credits: CreditsDeps = {
      topup: async (input) => { creditsCalls.push({ customerId: input.customerId, credits: input.credits }); },
    };

    const handlers = defaultHandlers({
      policy: DEFAULT_POLICY, ledger, repo, notifier, clock, ids: new SequentialIdGen('id_'),
      credits, resolveTopupCredits: async (p) => (p.id === payment.id ? 250 : null),
    });

    const rawBody = JSON.stringify({ id: 'evt_topup_resolved', type: 'payment.succeeded', occurredAt: clock.now().toISOString(), paymentRef: payment.providerRef });
    const r = await receive({ provider, headers: { 'x-sig': 'ok' }, rawBody, repo, clock });
    await processWebhook({ eventId: r.eventId!, providers: { stripe: provider }, handlers, repo, clock });

    const record = await repo.webhookEvents.get(r.eventId!);
    expect(record?.status).toBe('processed');
    expect(record?.error).toBeNull();
    expect(creditsCalls).toHaveLength(1);
    expect(creditsCalls[0].credits).toBe(250);
    expect(creditsCalls[0].customerId).toBe(payment.customerId);
  });

  it('[EC:K1/B10 repo threading] repo reaches credits.topup, so a replayed payment.succeeded for the same one-time payment grants exactly once', async () => {
    const clock = new FixedClock(new Date('2026-02-02T00:00:00Z'));
    const repo = new InMemoryRepo();
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const notifier = new CollectingNotifier();
    const payment = makeTopupPayment(clock, { id: 'pay_topup3', providerRef: 'pi_topup3' });
    await repo.payments.put(payment);

    const provider = new FakeProvider({ verify: jsonVerify(), getPaymentImpl: () => payment });
    let grantCount = 0;
    // Mirrors how the real boilpayment-credits topup() uses runIdempotent, keyed the same
    // way (topup:{payment.id}) -- this only proves anything if `input.repo` actually reaches this
    // call site, which is exactly the gap CreditsDeps.topup previously had (no `repo` in its input
    // shape, so a webhook-triggered top-up could only be deduped by the ledger's idempotency_key
    // UNIQUE constraint, not by the operation-level in-progress/replay guarantees of J1-J3).
    const credits: CreditsDeps = {
      topup: async (input) => {
        const { result } = await runIdempotent({
          repo: input.repo,
          clock,
          key: `topup:${input.payment.id}`,
          kind: 'credits.topup',
          payload: { paymentId: input.payment.id, credits: input.credits },
          fn: async () => {
            grantCount += 1;
            return { granted: input.credits };
          },
        });
        return result;
      },
    };

    const handlers = defaultHandlers({
      policy: DEFAULT_POLICY, ledger, repo, notifier, clock, ids: new SequentialIdGen('id_'),
      credits, resolveTopupCredits: async () => 250,
    });

    // Two separate webhook deliveries (different provider event ids) for the SAME underlying
    // payment -- simulates the provider redelivering payment.succeeded (e.g. after an ack timeout).
    const raw1 = JSON.stringify({ id: 'evt_topup_redelivery_1', type: 'payment.succeeded', occurredAt: clock.now().toISOString(), paymentRef: payment.providerRef });
    const r1 = await receive({ provider, headers: { 'x-sig': 'ok' }, rawBody: raw1, repo, clock });
    await processWebhook({ eventId: r1.eventId!, providers: { stripe: provider }, handlers, repo, clock });

    const raw2 = JSON.stringify({ id: 'evt_topup_redelivery_2', type: 'payment.succeeded', occurredAt: clock.now().toISOString(), paymentRef: payment.providerRef });
    const r2 = await receive({ provider, headers: { 'x-sig': 'ok' }, rawBody: raw2, repo, clock });
    await processWebhook({ eventId: r2.eventId!, providers: { stripe: provider }, handlers, repo, clock });

    expect(grantCount).toBe(1); // the grant only actually ran once, across two webhook deliveries
    const op = await repo.operations.get(`topup:${payment.id}`);
    expect(op?.status).toBe('done');
  });
});
