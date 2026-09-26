// [EC:E19] A top-up is granted only when the payment re-fetched from the provider has succeeded:
// a forged/early notification for a pending virtual-account payment, or a payment refunded before
// the webhook retry, is refused (record fails, no credits).
import { describe, expect, it } from 'vitest';
import { CollectingNotifier, DEFAULT_POLICY, FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen } from 'boilpayment-core';
import type { CreditsDeps, Payment, PaymentStatus } from 'boilpayment-core';
import { defaultHandlers, process as processWebhook, receive } from '../src/index.js';
import { FakeProvider, jsonVerify } from './helpers.js';

async function runTopup(status: PaymentStatus) {
  const clock = new FixedClock(new Date('2026-02-02T00:00:00Z'));
  const repo = new InMemoryRepo();
  const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
  const local: Payment = { id: 'pay_va', customerId: 'cust_1', provider: 'stripe', providerRef: 'pi_va', subscriptionId: null,
    amount: { amountMinor: 5000, currency: 'KRW' }, status: 'pending', kind: 'topup', period: null, occurredAt: clock.now(), failure: null };
  await repo.payments.put(local);
  const provider = new FakeProvider({ verify: jsonVerify(), getPaymentImpl: () => ({ ...local, status }) });
  const granted: number[] = [];
  const credits: CreditsDeps = { topup: async (input) => { granted.push(input.credits); } };
  const handlers = defaultHandlers({ policy: DEFAULT_POLICY, ledger, repo, notifier: new CollectingNotifier(), clock,
    ids: new SequentialIdGen('id_'), credits, resolveTopupCredits: async () => 5000 });
  const rawBody = JSON.stringify({ id: `evt_${status}`, type: 'payment.succeeded', occurredAt: clock.now().toISOString(), paymentRef: 'pi_va' });
  const r = await receive({ provider, headers: { 'x-sig': 'ok' }, rawBody, repo, clock });
  await processWebhook({ eventId: r.eventId!, providers: { stripe: provider }, handlers, repo, clock });
  const record = await repo.webhookEvents.get(r.eventId!);
  return { status: record?.status, error: record?.error, granted };
}

describe('[EC:E19] top-up needs a succeeded payment', () => {
  it.each(['pending', 'refunded', 'failed'] as const)('[EC:E19] provider status %s: record fails, no credits', async (status) => {
    const out = await runTopup(status);
    expect(out).toEqual({ status: 'failed', error: expect.stringContaining('not succeeded'), granted: [] });
  });
  it('[EC:E19] provider status succeeded: credits granted', async () => {
    expect((await runTopup('succeeded')).granted).toEqual([5000]);
  });
});
