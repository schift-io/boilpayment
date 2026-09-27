// Round-5 audit regressions (scratchpad bp-audit5.md): EC:A47 (A5-1) A49 (A5-2) A39 (A5-3) A50 (A5-6)
// A48 (A5-7) A38 (A5-8).
import { describe, expect, it } from 'vitest';
import { CollectingNotifier, FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen, resolvePolicy } from 'boilpayment-core';
import type { OutboxItem, Payment, Plan, Policy, Subscription } from 'boilpayment-core';
import { dunning, scheduler } from '../src/index.js';
import { withAttemptLease, ATTEMPT_LEASE_MS } from '../src/charge-attempt.js';
import { FakeSelfSchedulingProvider } from './helpers.js';

const basic: Plan = { id: 'basic', name: 'Basic', interval: 'month', creditsPerPeriod: 100, usageIncluded: 0, trialDays: 0,
  prices: [{ currency: 'KRW', amountMinor: 5000, providerPriceRefs: {} }] };
const mkSub = (start: string, end: string, status: Subscription['status'] = 'active'): Subscription => ({ id: 'sub_1', customerId: 'c1', planId: 'basic',
  provider: 'toss', providerRef: null, status, currentPeriod: { start: new Date(start), end: new Date(end) }, anchorDay: 1, cancelAtPeriodEnd: false,
  graceUntil: status === 'past_due' ? new Date('2024-02-08T01:00:00Z') : null, billingKey: 'bk', scheduledPlanId: null, version: 0, currency: 'KRW',
  createdAt: new Date(start) } as Subscription);

async function setup(sub: Subscription, patch: Partial<Policy['subscription']> = {}) {
  const repo = new InMemoryRepo();
  await repo.plans.put(basic);
  await repo.subscriptions.put(sub);
  const ledger = new InMemoryLedger(new SequentialIdGen('l_'));
  const notifier = new CollectingNotifier();
  const provider = new FakeSelfSchedulingProvider();
  const policy = resolvePolicy({ subscription: patch } as never);
  const clk = (at: string) => { provider.now = new Date(at); return new FixedClock(new Date(at)); };
  const tick = (at: string) => scheduler.tick({ provider, repo, ledger, policy, clock: clk(at), ids: new SequentialIdGen('i_'), notifier });
  const retries = async (at: string) => {
    const out: string[] = [];
    for (const item of await dunning.retryDue({ repo, clock: clk(at) })) out.push((await dunning.runRetry({ item, provider, repo, ledger, policy, notifier, clock: clk(at) })).outcome);
    return out;
  };
  const cur = async () => (await repo.subscriptions.get('sub_1'))!;
  const usable = async (at: string) => (await ledger.balance('c1', undefined, new Date(at))).available;
  const notices = (kind: string) => notifier.sent.filter((n) => (n.payload as { kind?: string } | undefined)?.kind === kind);
  const moved = (periodIso: string) => [...provider.moneyMoved].filter((k) => k.includes(periodIso)).length;
  return { repo, ledger, notifier, provider, policy, clk, tick, retries, cur, usable, notices, moved };
}

const retryItem = (attempt: number, status: 'sent' | 'pending', createdAt: string, due: string): OutboxItem => ({
  id: `dunning-retry-item:sub_1:${attempt}`, kind: 'dunning.retry', payload: { subscriptionId: 'sub_1', attempt, dueAt: due },
  status, attempts: status === 'sent' ? 1 : 0, nextAttemptAt: new Date(due), createdAt: new Date(createdAt) } as OutboxItem);

describe('round-5 regressions', () => {
  it('EC:A47 (A5-1) a subscription four periods behind is charged once, for the period containing now; one case lists the skipped periods', async () => {
    const t = await setup(mkSub('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'));
    for (const at of ['2026-05-15T09:00:00Z', '2026-05-15T09:10:00Z', '2026-05-15T09:20:00Z', '2026-05-15T09:30:00Z', '2026-05-15T09:40:00Z']) await t.tick(at);
    expect(t.provider.moneyMoved.size).toBe(1);
    expect(t.moved('2026-05-01')).toBe(1);
    expect((await t.cur()).currentPeriod.start.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(await t.usable('2026-05-15T10:00:00Z')).toBe(100);
    const cases = t.notices('missed_periods_skipped');
    expect(cases).toHaveLength(1);
    expect((cases[0].payload as { skipped: string[] }).skipped).toEqual(['2026-02-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z']);
  });

  it('EC:A47 needs_human_only charges nothing and parks the subscription until a person acts', async () => {
    const t = await setup(mkSub('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'), { missedPeriods: 'needs_human_only' });
    for (const at of ['2026-05-15T09:00:00Z', '2026-05-15T09:10:00Z', '2026-05-20T09:00:00Z']) await t.tick(at);
    expect(t.provider.orderIds).toHaveLength(0);
    const sub = await t.cur();
    expect(sub.status).toBe('past_due');
    expect(sub.graceUntil).toBeNull();
    expect(t.notices('missed_periods_parked')).toHaveLength(1);
  });

  it('EC:A47 one period behind is the ordinary renewal (no skip, no case)', async () => {
    const t = await setup(mkSub('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'));
    await t.tick('2026-02-10T09:00:00Z');
    expect(t.moved('2026-02-01')).toBe(1);
    expect(t.notices('missed_periods_skipped')).toHaveLength(0);
  });

  it('EC:A49 (A5-2) an answer lost for 16 days is settled by lookup, never charged again', async () => {
    const t = await setup(mkSub('2024-01-01T00:00:00Z', '2024-02-01T00:00:00Z'));
    t.provider.loseNextAnswer = true;
    await t.tick('2024-02-01T01:00:00Z');
    await t.tick('2024-02-17T01:00:00Z');
    await t.retries('2024-02-19T01:00:00Z');
    await t.tick('2024-02-20T01:00:00Z');
    expect(t.moved('2024-02-01')).toBe(1);
    expect(t.provider.orderIds).toHaveLength(1); // looked up, not re-sent
    expect((await t.repo.payments.list()).map((p) => p.status)).toEqual(['succeeded']);
    expect(await t.usable('2024-02-20T02:00:00Z')).toBe(100);
  });

  it('EC:A49 a duplicate-order refusal is never a decline: no dunning charge follows', async () => {
    const t = await setup(mkSub('2024-01-01T00:00:00Z', '2024-02-01T00:00:00Z'));
    t.provider.loseNextAnswer = true;
    await t.tick('2024-02-01T01:00:00Z');
    t.provider.lookupThrows = true; // the provider cannot be asked: stay unresolved, do not re-send blind
    await t.tick('2024-02-17T01:00:00Z');
    await t.retries('2024-02-19T01:00:00Z');
    expect(t.moved('2024-02-01')).toBe(1);
    expect(t.provider.orderIds).toHaveLength(1);
    expect((await t.repo.payments.list()).map((p) => p.status)).toEqual(['pending']);
    t.provider.lookupThrows = false;
    await t.tick('2024-02-21T01:00:00Z');
    expect((await t.repo.payments.list()).map((p) => p.status)).toEqual(['succeeded']);
    expect(t.moved('2024-02-01')).toBe(1);
  });

  it('EC:A39 (A5-3) a past_due subscription whose earlier-release dunning charge moved money is not charged again', async () => {
    const t = await setup(mkSub('2024-01-01T00:00:00Z', '2024-02-01T00:00:00Z', 'past_due'));
    await t.repo.outbox.put(retryItem(1, 'sent', '2024-02-01T01:30:00Z', '2024-02-02T02:00:00Z'));
    await t.repo.outbox.put(retryItem(2, 'pending', '2024-02-02T02:00:00Z', '2024-02-05T05:00:00Z'));
    t.provider.seedOrder('dunning-retry:sub_1:1', 'succeeded');
    expect(await t.retries('2024-02-05T05:00:00Z')).toEqual(['recovered']);
    expect(t.provider.orderIds).toHaveLength(0);
    expect((await t.cur()).status).toBe('active');
    expect(await t.usable('2024-02-05T06:00:00Z')).toBe(100);
    await t.tick('2024-03-01T01:00:00Z');
    expect(t.provider.moneyMoved.size).toBe(2); // the legacy February + March
  });

  it('EC:A39 (A5-3) an expired subscription whose earlier-release charge moved money gets a row, its period and one notice', async () => {
    const t = await setup(mkSub('2023-12-01T00:00:00Z', '2024-01-01T00:00:00Z', 'expired'));
    await t.repo.outbox.put(retryItem(1, 'sent', '2024-01-01T01:00:00Z', '2024-01-02T01:00:00Z'));
    t.provider.seedOrder('dunning-retry:sub_1:1', 'succeeded');
    await t.tick('2024-02-06T01:00:00Z');
    await t.tick('2024-02-07T01:00:00Z');
    const rows = await t.repo.payments.list();
    expect(rows.map((p) => p.status)).toEqual(['succeeded']);
    expect(rows[0].period?.start.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect(t.notices('renewal_settled_after_end')).toHaveLength(1);
    expect((await t.cur()).status).toBe('expired');
    expect(t.provider.orderIds).toHaveLength(0);
  });

  it('EC:A50 (A5-6) a lookup whose amount, currency or customer differs is sent to a person: no grant, no new charge', async () => {
    // A6-3 — a legacy row's amount is unknown, so an amount-only difference settles it (see the round-6 test).
    for (const bad of [{ amount: { amountMinor: 5000, currency: 'USD' } }, { customerId: 'someone_else' }, { status: 'partially_refunded' as const }]) {
      const t = await setup(mkSub('2024-01-01T00:00:00Z', '2024-02-01T00:00:00Z'));
      await t.repo.outbox.put(retryItem(1, 'sent', '2024-02-01T01:00:00Z', '2024-02-02T01:00:00Z'));
      t.provider.seedOrder('dunning-retry:sub_1:1', 'succeeded');
      t.provider.lookupOverride = (_id, found) => (found ? ({ ...found, ...bad } as Payment) : null);
      const r = await t.tick('2024-02-02T03:00:00Z');
      await t.tick('2024-02-03T03:00:00Z');
      expect(t.provider.orderIds).toHaveLength(0);
      expect(await t.usable('2024-02-03T04:00:00Z')).toBe(0);
      expect(t.notices('attempt_lookup_mismatch')).toHaveLength(1);
      expect(r.errors.length).toBeGreaterThan(0);
    }
  });

  it('EC:A38 (A5-8) a pending attempt of a period the subscription already moved past is settled by lookup', async () => {
    const t = await setup(mkSub('2024-02-01T00:00:00Z', '2024-03-01T00:00:00Z'));
    // An earlier build charged February (money + grant) but left its attempt row pending.
    t.provider.seedOrder('ord_left_pending', 'succeeded');
    await t.repo.payments.put({ id: 'pay_rn_left', customerId: 'c1', provider: 'toss', providerRef: 'ord_left_pending', subscriptionId: 'sub_1',
      amount: { amountMinor: 5000, currency: 'KRW' }, status: 'pending', kind: 'subscription',
      period: { start: new Date('2024-02-01T00:00:00Z'), end: new Date('2024-03-01T00:00:00Z') }, occurredAt: new Date('2024-02-01T01:00:00Z'),
      failure: null, cashReceipt: null, raw: { boilpaymentAttemptKey: 'charge:sub_1:2024-02-01T00:00:00.000Z', boilpaymentLegacyOrderId: 'ord_left_pending' } } as Payment);
    await t.tick('2024-02-10T01:00:00Z');
    expect((await t.repo.payments.get('pay_rn_left'))!.status).toBe('succeeded');
    expect(t.provider.orderIds).toHaveLength(0);
  });

  it('EC:A48 (A5-7) a stale lease is taken over by one caller only, and a finished holder never releases another holder', async () => {
    const repo = new InMemoryRepo();
    const clock = new FixedClock(new Date('2024-02-01T00:00:00Z'));
    const later = new FixedClock(new Date(Date.parse('2024-02-01T00:00:00Z') + ATTEMPT_LEASE_MS + 60_000));
    let inside = 0;
    let maxInside = 0;
    const body = async () => { inside += 1; maxInside = Math.max(maxInside, inside); await new Promise((r) => setTimeout(r, 5)); inside -= 1; };
    // A holds the lease and hangs (never finishes inside the lease time).
    let releaseA!: () => void;
    const aDone = withAttemptLease(repo, clock, 'k', () => new Promise<void>((r) => { inside += 1; maxInside = Math.max(maxInside, inside); releaseA = () => { inside -= 1; r(); }; }));
    await new Promise((r) => setTimeout(r, 1));
    // B and C both see the stale lease at the same time.
    const [b, c] = await Promise.all([withAttemptLease(repo, later, 'k', body), withAttemptLease(repo, later, 'k', body)]);
    expect([b.held, c.held].filter(Boolean)).toHaveLength(1);
    // A finally returns: it must not release a lease it no longer owns.
    const d = withAttemptLease(repo, later, 'k', async () => { await new Promise((r) => setTimeout(r, 20)); });
    await new Promise((r) => setTimeout(r, 1));
    releaseA();
    await aDone;
    const e = await withAttemptLease(repo, later, 'k', body);
    expect(e.held).toBe(false); // D still holds it
    await d;
    expect(maxInside).toBeLessThanOrEqual(2); // A (hung, stale) + one new holder, never three
  });
});
