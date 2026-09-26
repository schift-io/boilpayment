// EC:A45 (round-4 audit A4-9) — PortOne sends Transaction.Paid for the renewal charge our scheduler made.
// The event names no subscription; the local attempt row (kind subscription) does. It must complete that
// renewal (once), never fall into the top-up branch.
import { describe, expect, it } from 'vitest';
import { CollectingNotifier, DEFAULT_POLICY, FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen } from 'boilpayment-core';
import type { Payment, Subscription } from 'boilpayment-core';
import type { LifecycleDeps } from '../src/index.js';
import { defaultHandlers, process as processWebhook, receive } from '../src/index.js';
import { FakeProvider, jsonVerify } from './helpers.js';

const period2 = { start: new Date('2026-03-01T00:00:00Z'), end: new Date('2026-04-01T00:00:00Z') };

function setup(remoteStatus: Payment['status']) {
  const clock = new FixedClock(new Date('2026-03-01T00:05:00Z'));
  const repo = new InMemoryRepo();
  const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
  const sub: Subscription = {
    id: 'sub_local', customerId: 'cust_1', planId: 'plan_pro', provider: 'portone', providerRef: null,
    status: 'active', currentPeriod: { start: new Date('2026-02-01T00:00:00Z'), end: period2.start },
    anchorDay: 1, cancelAtPeriodEnd: false, graceUntil: null, billingKey: 'bk', scheduledPlanId: null, version: 0, createdAt: clock.now(),
  };
  const row: Payment = {
    id: 'pay_rn_1', customerId: 'cust_1', provider: 'portone', providerRef: 'ord_abc', subscriptionId: 'sub_local',
    amount: { amountMinor: 5000, currency: 'KRW' }, status: 'pending', kind: 'subscription', period: period2,
    occurredAt: clock.now(), failure: null, cashReceipt: null, raw: { boilpaymentAttemptKey: 'charge:sub_local:2026-03-01T00:00:00.000Z' },
  };
  const provider = new FakeProvider({
    name: 'portone', verify: jsonVerify('portone'),
    getPaymentImpl: () => ({ ...row, id: 'remote', customerId: '', subscriptionId: null, status: remoteStatus }),
  });
  const renewed: string[] = [];
  const topups: string[] = [];
  const lifecycle: LifecycleDeps = {
    onRenewalPaid: async (input) => { renewed.push(`${input.sub.id}:${(input.payment as Payment).period?.start.toISOString()}`); },
    dunning: { onPaymentFailed: async () => {} },
  };
  const handlers = defaultHandlers({
    policy: DEFAULT_POLICY, ledger, repo, notifier: new CollectingNotifier(), clock, ids: new SequentialIdGen('p_'), lifecycle,
    credits: { topup: async () => { topups.push('topup'); } } as never,
  });
  const deliver = async (id: string) => {
    const rawBody = JSON.stringify({ id, type: 'payment.succeeded', occurredAt: clock.now().toISOString(), customerRef: null, subscriptionRef: null, paymentRef: 'ord_abc' });
    const r = await receive({ provider, headers: { 'x-sig': 'ok' }, rawBody, repo, clock });
    await processWebhook({ eventId: r.eventId!, providers: { portone: provider }, handlers, repo, clock });
    return repo.webhookEvents.get(r.eventId!);
  };
  return { repo, sub, row, renewed, topups, deliver };
}

describe('EC:A45 self-scheduled renewal webhook', () => {
  it('completes the renewal of the attempt row and records it succeeded; no top-up', async () => {
    const t = setup('succeeded');
    await t.repo.subscriptions.put(t.sub);
    await t.repo.payments.put(t.row);
    const record = await t.deliver('evt_paid_1');
    expect(record?.error).toBeNull();
    expect(record?.status).toBe('processed');
    expect((await t.repo.payments.get('pay_rn_1'))?.status).toBe('succeeded');
    expect(t.renewed).toEqual(['sub_local:2026-03-01T00:00:00.000Z']);
    expect(t.topups).toEqual([]);
  });

  it('a payment that has not succeeded fails the record, nothing granted', async () => {
    const t = setup('pending');
    await t.repo.subscriptions.put(t.sub);
    await t.repo.payments.put(t.row);
    const record = await t.deliver('evt_paid_2');
    expect(record?.status).toBe('failed');
    expect(record?.error).toBe('Renewal payment has not succeeded');
    expect(t.renewed).toEqual([]);
    expect(t.topups).toEqual([]);
  });
});
