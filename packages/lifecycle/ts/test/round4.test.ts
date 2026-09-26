// Round-4 audit regressions (scratchpad bp-audit4.md): EC:A37 A38 A39 A40 A41.
import { describe, expect, it } from 'vitest';
import { CollectingNotifier, FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen, resolvePolicy } from 'boilpayment-core';
import type { OutboxItem, Plan, Subscription } from 'boilpayment-core';
import { cancel, dunning, scheduler } from '../src/index.js';
import { FakeSelfSchedulingProvider } from './helpers.js';

const basic: Plan = { id: 'basic', name: 'Basic', interval: 'month', creditsPerPeriod: 100, usageIncluded: 0, trialDays: 0,
  prices: [{ currency: 'KRW', amountMinor: 5000, providerPriceRefs: {} }] };
const mkSub = (): Subscription => ({ id: 'sub_1', customerId: 'c1', planId: 'basic', provider: 'toss', providerRef: null, status: 'active',
  currentPeriod: { start: new Date('2024-01-01T00:00:00Z'), end: new Date('2024-02-01T00:00:00Z') }, anchorDay: 1, cancelAtPeriodEnd: false,
  graceUntil: null, billingKey: 'bk', scheduledPlanId: null, version: 0, currency: 'KRW', createdAt: new Date('2024-01-01T00:00:00Z') } as Subscription);
const RENEWAL_KEY = 'charge:sub_1:2024-02-01T00:00:00.000Z';

async function setup() {
  const repo = new InMemoryRepo();
  await repo.plans.put(basic);
  await repo.subscriptions.put(mkSub());
  const ledger = new InMemoryLedger(new SequentialIdGen('l_'));
  const notifier = new CollectingNotifier();
  const provider = new FakeSelfSchedulingProvider();
  const policy = resolvePolicy();
  const clk = (at: string) => new FixedClock(new Date(at));
  const tick = (at: string) => scheduler.tick({ provider, repo, ledger, policy, clock: clk(at), ids: new SequentialIdGen('i_'), notifier });
  const retries = async (at: string) => {
    const out: string[] = [];
    for (const item of await dunning.retryDue({ repo, clock: clk(at) })) out.push((await dunning.runRetry({ item, provider, repo, ledger, policy, notifier, clock: clk(at) })).outcome);
    return out;
  };
  const sweep = async (at: string) => {
    for (const s of await repo.subscriptions.list({ status: 'past_due' } as Partial<Subscription>)) {
      if (s.graceUntil && s.graceUntil <= new Date(at)) await dunning.onGraceExpired({ sub: s, policy, ledger, repo, notifier, clock: clk(at) });
    }
  };
  const sub = async () => (await repo.subscriptions.get('sub_1'))!;
  const usable = async (at: string) => (await ledger.balance('c1', undefined, new Date(at))).available;
  const kinds = () => notifier.sent.map((n) => (n.payload as { kind?: string } | undefined)?.kind).filter(Boolean);
  return { repo, ledger, notifier, provider, policy, clk, tick, retries, sweep, sub, usable, kinds };
}

describe('round-4 regressions', () => {
  it('EC:A38 (A4-2) an unresolved charge that succeeds after grace expired is recorded and buys its period, once', async () => {
    const t = await setup();
    t.provider.nextChargeStatus = 'pending';
    await t.tick('2024-02-01T01:00:00Z');
    await t.sweep('2024-02-09T01:00:00Z');
    expect((await t.sub()).status).toBe('expired');
    t.provider.settle(RENEWAL_KEY, 'succeeded');
    const r1 = await t.tick('2024-02-10T01:00:00Z');
    await t.tick('2024-02-11T01:00:00Z');
    const rows = await t.repo.payments.list();
    expect(rows.map((p) => p.status)).toEqual(['succeeded']);
    expect(await t.usable('2024-02-11T02:00:00Z')).toBe(100);
    expect((await t.sub()).status).toBe('expired');
    expect(t.kinds().filter((k) => k === 'renewal_settled_after_end')).toHaveLength(1);
    expect(r1.errors).toEqual([]);
    expect(t.provider.orderIds).toHaveLength(1); // settled by lookup, never charged again
  });

  it('EC:A38 an order the provider never received is closed as failed, never charged later', async () => {
    const t = await setup();
    t.provider.nextChargeThrows = true; // request never answered
    await t.tick('2024-02-01T01:00:00Z');
    await t.sweep('2024-02-09T01:00:00Z');
    t.provider.nextChargeThrows = false;
    // the fake stored no answer for the thrown call, so the lookup finds no order
    await t.tick('2024-02-10T01:00:00Z');
    expect((await t.repo.payments.list()).map((p) => p.status)).toEqual(['failed']);
    expect(t.provider.moneyMoved.size).toBe(0);
  });

  it('EC:A40 (A4-6) canceled while past_due: dunning stops, nothing more is charged', async () => {
    const t = await setup();
    t.provider.nextChargeStatus = 'failed';
    await t.tick('2024-02-01T01:00:00Z');
    await cancel({ sub: await t.sub(), policy: t.policy, provider: t.provider, ledger: t.ledger, repo: t.repo, clock: t.clk('2024-02-01T02:00:00Z') } as never);
    t.provider.nextChargeStatus = 'succeeded';
    expect(await t.retries('2024-02-02T02:00:00Z')).toEqual(['skipped']);
    await t.tick('2024-03-01T01:00:00Z');
    expect(t.provider.moneyMoved.size).toBe(0);
    expect((await t.sub()).status).toBe('canceled');
  });

  it('EC:A41 (A4-5) an unresolved scheduler charge that resolves as declined starts dunning with smart retries', async () => {
    const t = await setup();
    t.provider.nextChargeStatus = 'pending';
    await t.tick('2024-02-01T01:00:00Z');
    t.provider.settle(RENEWAL_KEY, 'failed');
    await t.tick('2024-02-01T05:00:00Z');
    const items = (await t.repo.outbox.list()) as OutboxItem[];
    expect(items.filter((i) => i.status === 'pending').map((i) => i.id)).toEqual(['dunning-retry-item:sub_1:1']);
    t.provider.nextChargeStatus = 'succeeded';
    const outcomes: string[] = [];
    for (const at of ['2024-02-02T06:00:00Z', '2024-02-04T06:00:00Z', '2024-02-07T06:00:00Z']) { await t.tick(at); outcomes.push(...await t.retries(at)); }
    expect(outcomes).toContain('recovered');
    expect((await t.sub()).status).toBe('active');
    expect(t.provider.moneyMoved.size).toBe(1);
  });

  it('EC:A37 (A4-4) two concurrent ticks call the provider once per attempt', async () => {
    const t = await setup();
    await Promise.all([t.tick('2024-02-01T01:00:00Z'), t.tick('2024-02-01T01:00:00Z')]);
    expect(t.provider.orderIds).toHaveLength(1);
    expect((await t.repo.payments.list()).map((p) => p.status)).toEqual(['succeeded']);
    expect(await t.usable('2024-02-01T02:00:00Z')).toBe(100);
  });

  it('EC:A39 (A4-3) a dunning charge of an earlier release pays the period: no second charge', async () => {
    const t = await setup();
    // State an earlier release left: retry 1 sent (charged with orderId dunning-retry:sub_1:1), no payment row,
    // subscription recovered to active without advancing its period.
    await t.repo.outbox.put({ id: 'dunning-retry-item:sub_1:1', kind: 'dunning.retry', payload: { subscriptionId: 'sub_1', attempt: 1, dueAt: '2024-02-02T01:00:00.000Z' },
      status: 'sent', attempts: 1, nextAttemptAt: new Date('2024-02-02T01:00:00Z'), createdAt: new Date('2024-02-01T01:00:00Z') } as OutboxItem);
    t.provider.seedOrder('dunning-retry:sub_1:1', 'succeeded');
    await t.tick('2024-02-02T03:00:00Z');
    expect(t.provider.orderIds).toHaveLength(0); // nothing charged by this release
    expect((await t.sub()).currentPeriod.end.toISOString()).toBe('2024-03-01T00:00:00.000Z');
    expect(await t.usable('2024-02-02T04:00:00Z')).toBe(100);
    await t.tick('2024-03-01T01:00:00Z'); // next period renews normally
    expect(t.provider.orderIds).toHaveLength(1);
  });

  it('EC:A39 a legacy charge the provider cannot confirm blocks a new charge and is reported', async () => {
    const t = await setup();
    await t.repo.outbox.put({ id: 'dunning-retry-item:sub_1:1', kind: 'dunning.retry', payload: { subscriptionId: 'sub_1', attempt: 1 },
      status: 'sent', attempts: 1, nextAttemptAt: new Date('2024-02-02T01:00:00Z'), createdAt: new Date('2024-02-01T01:00:00Z') } as OutboxItem);
    t.provider.lookupThrows = true;
    const r = await t.tick('2024-02-02T03:00:00Z');
    expect(r.errors.map((e) => e.code)).toEqual(['legacy_dunning_unverified']);
    // later ticks never re-send the legacy key (a provider replays it only for a limited time)
    const r2 = await t.tick('2024-02-20T03:00:00Z');
    expect(r2.errors.map((e) => e.code)).toEqual(['legacy_dunning_unverified']);
    expect(t.provider.orderIds).toHaveLength(0);
    t.provider.lookupThrows = false; // the provider answers: no such order -> closed, a normal charge follows
    await t.tick('2024-02-21T03:00:00Z');
    expect(t.provider.orderIds).toHaveLength(1);
  });
});
