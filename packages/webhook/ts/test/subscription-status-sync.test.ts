// [EC:A27] subscription.updated moves a local subscription into / out of the non-entitled states
// (paused, incomplete) from the provider's re-fetched status. Other transitions stay with their
// own handlers (dunning, renewal, cancel).
import { describe, expect, it } from 'vitest';
import { CollectingNotifier, DEFAULT_POLICY, FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen } from 'boilpayment-core';
import type { Subscription, SubscriptionStatus } from 'boilpayment-core';
import { defaultHandlers, process as processWebhook, receive } from '../src/index.js';
import { FakeProvider, jsonVerify } from './helpers.js';

function setup(local: SubscriptionStatus) {
  const clock = new FixedClock(new Date('2026-03-01T00:05:00Z'));
  const repo = new InMemoryRepo();
  const sub: Subscription = {
    id: 'sub_local', customerId: 'cust_1', planId: 'plan_pro', provider: 'stripe', providerRef: 'sub_123',
    status: local, currentPeriod: { start: new Date('2026-02-01T00:00:00Z'), end: new Date('2026-03-01T00:00:00Z') },
    anchorDay: 1, cancelAtPeriodEnd: false, graceUntil: null, billingKey: null, scheduledPlanId: null, version: 0, createdAt: clock.now(),
  };
  let remote: SubscriptionStatus = 'active';
  const provider = new FakeProvider({ name: 'stripe', verify: jsonVerify('stripe'), getSubscriptionImpl: () => ({ ...sub, status: remote }) });
  const handlers = defaultHandlers({ policy: DEFAULT_POLICY, ledger: new InMemoryLedger(new SequentialIdGen('led_')), repo,
    notifier: new CollectingNotifier(), clock, ids: new SequentialIdGen('pay_') });
  let n = 0;
  const deliver = async (status: SubscriptionStatus) => {
    remote = status;
    const rawBody = JSON.stringify({ id: `evt_${++n}`, type: 'subscription.updated', occurredAt: clock.now().toISOString(), customerRef: 'cus_1', subscriptionRef: 'sub_123', paymentRef: null });
    const r = await receive({ provider, headers: { 'x-sig': 'ok' }, rawBody, repo, clock });
    await processWebhook({ eventId: r.eventId!, providers: { stripe: provider }, handlers, repo, clock });
    return (await repo.subscriptions.get('sub_local'))?.status;
  };
  return { repo, sub, deliver };
}

describe('[EC:A27] subscription.updated status sync', () => {
  it('[EC:A27] active -> paused -> active (resume)', async () => {
    const t = setup('active');
    await t.repo.subscriptions.put(t.sub);
    expect([await t.deliver('paused'), await t.deliver('active')]).toEqual(['paused', 'active']);
  });
  it('[EC:A27] incomplete -> active once the first payment lands', async () => {
    const t = setup('incomplete');
    await t.repo.subscriptions.put(t.sub);
    expect(await t.deliver('active')).toBe('active');
  });
  it('[EC:A27] other transitions are left to their own handlers (past_due stays with dunning)', async () => {
    const t = setup('past_due');
    await t.repo.subscriptions.put(t.sub);
    expect(await t.deliver('active')).toBe('past_due');
  });
  it('[EC:A27] unknown subscription is a no-op', async () => {
    const t = setup('active');
    expect(await t.deliver('paused')).toBeUndefined();
  });
});
