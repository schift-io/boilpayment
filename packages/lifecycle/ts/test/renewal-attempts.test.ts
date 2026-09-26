// [EC:A34 A35 A36] Self-scheduled renewal + dunning as one charge state machine per (subscription,
// period). Regression tests ported from the round-3 audit PoCs (POC10, POC8a/b/c, toss-orderid, N11):
// a period is charged at most once, every charge leaves a payment row, dunning recovery pays for and
// grants the renewal period, an unknown outcome is re-driven with the same key and enters grace.
import { describe, expect, it } from 'vitest';
import { CollectingNotifier, FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen, resolvePolicy } from 'boilpayment-core';
import type { Plan, Subscription } from 'boilpayment-core';
import { dunning, providerOrderId, scheduler } from '../src/index.js';
import { FakeSelfSchedulingProvider } from './helpers.js';

const basic: Plan = { id: 'basic', name: 'Basic', interval: 'month', creditsPerPeriod: 100, usageIncluded: 0, trialDays: 0,
  prices: [{ currency: 'KRW', amountMinor: 5000, providerPriceRefs: {} }] };
const mkSub = (id = 'sub_1'): Subscription => ({ id, customerId: `c_${id}`, planId: 'basic', provider: 'toss', providerRef: null, status: 'active',
  currentPeriod: { start: new Date('2024-01-01T00:00:00Z'), end: new Date('2024-02-01T00:00:00Z') }, anchorDay: 1, cancelAtPeriodEnd: false,
  graceUntil: null, billingKey: `bk_${id}`, scheduledPlanId: null, version: 0, currency: 'KRW', createdAt: new Date('2024-01-01T00:00:00Z') } as Subscription);

async function setup() {
  const repo = new InMemoryRepo();
  await repo.plans.put(basic);
  await repo.subscriptions.put(mkSub());
  const ledger = new InMemoryLedger(new SequentialIdGen('l_'));
  const notifier = new CollectingNotifier();
  const provider = new FakeSelfSchedulingProvider();
  const policy = resolvePolicy();
  const tick = (at: string) => scheduler.tick({ provider, repo, ledger, policy, clock: new FixedClock(new Date(at)), ids: new SequentialIdGen('i_'), notifier });
  const usable = async (at: string) => (await ledger.balance('c_sub_1', undefined, new Date(at))).available;
  return { repo, ledger, notifier, provider, policy, tick, usable };
}

describe('[EC:A34] a period is charged once, and what is paid for is usable', () => {
  it('[EC:A34] POC10: declined renewal, dunning retry succeeds, next tick does not charge again', async () => {
    const { repo, ledger, notifier, provider, policy, tick, usable } = await setup();
    provider.nextChargeStatus = 'failed';
    await tick('2024-02-01T01:00:00Z');
    expect((await repo.subscriptions.get('sub_1'))?.status).toBe('past_due');

    provider.nextChargeStatus = 'succeeded';
    const rc = new FixedClock(new Date('2024-02-02T02:00:00Z'));
    const [item] = await dunning.retryDue({ repo, clock: rc });
    const r = await dunning.runRetry({ item, provider, repo, ledger, policy, notifier, clock: rc });
    const sub = await repo.subscriptions.get('sub_1');
    expect(r.outcome).toBe('recovered');
    expect([sub?.status, sub?.currentPeriod.start.toISOString(), sub?.currentPeriod.end.toISOString()])
      .toEqual(['active', '2024-02-01T00:00:00.000Z', '2024-03-01T00:00:00.000Z']);
    expect(await usable('2024-02-02T03:00:00Z')).toBe(100); // was 0: the grant for an already-ended period
    const rows = await repo.payments.list();
    expect(rows.map((p) => [p.status, p.period?.start.toISOString()]).sort())
      .toEqual([['failed', '2024-02-01T00:00:00.000Z'], ['succeeded', '2024-02-01T00:00:00.000Z']]); // was 0 rows

    const t = await tick('2024-02-02T04:00:00Z');
    expect(t.charged.length).toBe(0);
    expect(provider.moneyMoved.size).toBe(1); // was 2: the same period charged by dunning and by the next tick
  });

  it('[EC:A34] POC8b: the payment row write fails after the money moved; the next tick finishes without a second charge', async () => {
    const { repo, provider, tick, usable } = await setup();
    const put = repo.payments.put.bind(repo.payments);
    let n = 0;
    repo.payments.put = async (p) => { if (n++ === 1) throw new Error('db down'); return put(p); }; // the write after the charge
    expect((await tick('2024-02-01T01:00:00Z')).errors.map((e) => e.code)).toEqual(['scheduler_error']);
    await tick('2024-02-02T01:00:00Z');
    await tick('2024-02-03T01:00:00Z');
    expect(provider.moneyMoved.size).toBe(1);
    expect((await repo.payments.list()).map((p) => p.status)).toEqual(['succeeded']);
    expect(await usable('2024-02-03T02:00:00Z')).toBe(100);
  });

  it('[EC:A34] POC8a: the ledger fails once after the charge; the stored payment is resumed', async () => {
    const { ledger, provider, tick, usable } = await setup();
    const append = ledger.append.bind(ledger);
    let n = 0;
    ledger.append = async (e) => { if (n++ === 0) throw new Error('db down'); return append(e); };
    await tick('2024-02-01T01:00:00Z');
    await tick('2024-02-02T01:00:00Z');
    expect([provider.moneyMoved.size, await usable('2024-02-02T02:00:00Z')]).toEqual([1, 100]);
  });
});

describe('[EC:A36] an unknown outcome is re-driven, not recharged, and enters grace once', () => {
  it('[EC:A36] POC8c: a pending charge moves the subscription into grace, tells a person once, is re-driven with the same key', async () => {
    const { repo, notifier, provider, tick, usable } = await setup();
    provider.nextChargeStatus = 'pending';
    const first = await tick('2024-02-01T01:00:00Z');
    expect(first.errors.map((e) => e.code)).toEqual(['scheduler_charge_unresolved']);
    const sub = await repo.subscriptions.get('sub_1');
    expect([sub?.status, sub?.graceUntil?.toISOString()]).toEqual(['past_due', '2024-02-08T01:00:00.000Z']); // was active forever
    await tick('2024-02-02T01:00:00Z');
    await tick('2024-02-03T01:00:00Z');
    const keys = new Set((await repo.payments.list()).map((p) => p.id));
    expect(keys.size).toBe(1); // one attempt, re-driven
    expect(notifier.sent.filter((m) => m.type === 'cs.needs_human').length).toBe(1);
    expect(notifier.sent.filter((m) => m.type === 'payment.failed').length).toBe(0); // not a decline

    provider.settle(provider.lastCharge!.idempotencyKey, 'succeeded'); // the provider answers later
    const done = await tick('2024-02-04T01:00:00Z');
    expect(done.charged.length).toBe(1);
    expect([(await repo.subscriptions.get('sub_1'))?.status, provider.moneyMoved.size, await usable('2024-02-04T02:00:00Z')]).toEqual(['active', 1, 100]);
  });

  it('[EC:A34 N11] a dunning retry that gets no answer is not a decline: same attempt later, no new charge, no failure notice', async () => {
    const { repo, ledger, notifier, provider, policy, tick } = await setup();
    provider.nextChargeStatus = 'failed';
    await tick('2024-02-01T01:00:00Z');
    provider.nextChargeThrows = true;
    const rc = new FixedClock(new Date('2024-02-02T02:00:00Z'));
    const [item] = await dunning.retryDue({ repo, clock: rc });
    const before = notifier.sent.filter((m) => m.type === 'payment.failed').length;
    const r = await dunning.runRetry({ item, provider, repo, ledger, policy, notifier, clock: rc });
    expect(r.outcome).toBe('unresolved'); // was 'failed' and a new key scheduled
    expect(notifier.sent.filter((m) => m.type === 'payment.failed').length).toBe(before);
    const items = await repo.outbox.list();
    expect(items.map((i) => [i.status, (i.payload as { attempt: number }).attempt])).toEqual([['pending', 1]]);
    const firstKey = provider.lastCharge!.idempotencyKey;

    provider.nextChargeThrows = false;
    provider.nextChargeStatus = 'succeeded';
    const later = new FixedClock(new Date('2024-02-05T02:00:00Z'));
    const [again] = await dunning.retryDue({ repo, clock: later });
    const r2 = await dunning.runRetry({ item: again, provider, repo, ledger, policy, notifier, clock: later });
    expect([r2.outcome, provider.lastCharge!.idempotencyKey, provider.moneyMoved.size]).toEqual(['recovered', firstKey, 1]);
  });

  it('[EC:A34] a provider 4xx is a decline, a 5xx is not', async () => {
    const { repo, provider, tick } = await setup();
    provider.nextChargeHttpError = 503;
    expect((await tick('2024-02-01T01:00:00Z')).errors.map((e) => e.code)).toEqual(['scheduler_charge_unresolved']);
    expect((await repo.payments.list()).map((p) => p.status)).toEqual(['pending']);
    provider.nextChargeHttpError = 400;
    await tick('2024-02-02T01:00:00Z');
    expect((await repo.payments.list()).map((p) => p.status)).toEqual(['failed']);
  });
});

describe('[EC:A35] provider orderIds', () => {
  it('[EC:A35] scheduler and dunning orderIds fit Toss (6–64 of [A-Za-z0-9_-]) and PortOne paymentId', async () => {
    const { repo, ledger, notifier, provider, policy, tick } = await setup();
    provider.nextChargeStatus = 'failed';
    await tick('2024-02-01T01:00:00Z');
    const rc = new FixedClock(new Date('2024-02-02T02:00:00Z'));
    const [item] = await dunning.retryDue({ repo, clock: rc });
    await dunning.runRetry({ item, provider, repo, ledger, policy, notifier, clock: rc });
    expect(provider.orderIds.length).toBe(2);
    for (const id of provider.orderIds) expect(id).toMatch(/^[A-Za-z0-9_-]{6,64}$/); // was 'charge:<sub>:<ISO>' (72, ':' '.')
    expect(providerOrderId('charge:sub_7f3c2a1e-5b7d-4c1a-9a55-2f0d7e6b1c42:2024-02-01T00:00:00.000Z')).toMatch(/^ord_[0-9a-f]{40}$/);
  });
});
