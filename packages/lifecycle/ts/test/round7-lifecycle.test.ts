// Round-7 audit regressions (scratchpad bp-audit7.md): A7-2 (EC:A55 every legacy key), A7-5 (EC:A56
// past_due behind), A7-6 (EC:A57 upgrade orderId), A7-4/A7-7 (EC:A58 close, void re-query, lease).
import { describe, expect, it } from 'vitest';
import { CollectingNotifier, FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen, resolvePolicy } from 'boilpayment-core';
import type { OutboxItem, Plan, Subscription } from 'boilpayment-core';
import { resolveHeldAttempt, scheduler, upgrade } from '../src/index.js';
import { attemptPaymentId, providerOrderId, renewalAttemptKey, withAttemptLease } from '../src/charge-attempt.js';
import { FakeSelfSchedulingProvider } from './helpers.js';

const plan = (id: string, amountMinor: number, credits: number): Plan => ({ id, name: id, interval: 'month', creditsPerPeriod: credits, usageIncluded: 0,
  trialDays: 0, prices: [{ currency: 'KRW', amountMinor, providerPriceRefs: {} }] });
const mkSub = (start: string, end: string, status: Subscription['status'] = 'active'): Subscription => ({
  id: 'sub_1', customerId: 'c1', planId: 'basic', provider: 'toss', providerRef: null, status, currentPeriod: { start: new Date(start), end: new Date(end) },
  anchorDay: 1, cancelAtPeriodEnd: false, graceUntil: null, billingKey: 'bk', scheduledPlanId: null, version: 0,
  currency: 'KRW', createdAt: new Date(start) } as Subscription);

async function setup(sub: Subscription, policyPatch: Record<string, unknown> = {}) {
  const repo = new InMemoryRepo();
  await repo.plans.put(plan('basic', 5000, 100));
  await repo.plans.put(plan('pro', 10000, 300));
  await repo.subscriptions.put(sub);
  const ledger = new InMemoryLedger(new SequentialIdGen('l_'));
  const notifier = new CollectingNotifier();
  const provider = new FakeSelfSchedulingProvider();
  const policy = resolvePolicy(policyPatch as never);
  const clk = (at: string) => { provider.now = new Date(at); return new FixedClock(new Date(at)); };
  const tick = (at: string) => scheduler.tick({ provider, repo, ledger, policy, clock: clk(at), ids: new SequentialIdGen('i_'), notifier });
  const cur = async () => (await repo.subscriptions.get('sub_1'))!;
  const usable = async (at: string) => (await ledger.balance('c1', undefined, new Date(at))).available;
  const notices = (kind: string) => notifier.sent.filter((n) => (n.payload as { kind?: string } | undefined)?.kind === kind);
  const moved = (periodIso: string) => [...provider.moneyMoved].filter((k) => k.includes(periodIso)).length;
  return { repo, ledger, notifier, provider, policy, clk, tick, cur, usable, notices, moved };
}

/** A renewal held for review: its charge moved money, the answer was lost, the lookup did not match. */
async function heldRenewal(t: Awaited<ReturnType<typeof setup>>, status: 'partially_refunded' | 'succeeded') {
  t.provider.loseNextAnswer = true;
  await t.tick('2024-02-01T01:00:00Z');
  t.provider.lookupOverride = (_id, found) => (found ? { ...found, status, amount: { amountMinor: status === 'succeeded' ? 6000 : 5000, currency: 'KRW' } } : null);
  await t.tick('2024-02-01T01:10:00Z');
  const [held] = await t.repo.payments.list();
  expect(t.notices('attempt_lookup_mismatch')).toHaveLength(1);
  return held;
}

const TOSS_ORDER_ID = /^[A-Za-z0-9_-]{6,64}$/;

describe('round-7 lifecycle regressions', () => {
  it('EC:A55 (A7-2) two legacy dunning charges both moved money: the first pays the period, the second is found and told once', async () => {
    const t = await setup(mkSub('2023-12-01T00:00:00Z', '2024-01-01T00:00:00Z', 'expired'));
    for (const attempt of [1, 2]) {
      await t.repo.outbox.put({ id: `dunning-retry-item:sub_1:${attempt}`, kind: 'dunning.retry', payload: { subscriptionId: 'sub_1', attempt },
        status: 'sent', attempts: 1, nextAttemptAt: new Date('2024-01-02T01:00:00Z'), createdAt: new Date(`2024-01-0${attempt}T01:00:00Z`) } as OutboxItem);
      t.provider.seedOrder(`dunning-retry:sub_1:${attempt}`, 'succeeded');
    }
    for (const at of ['2024-02-06T01:00:00Z', '2024-02-06T01:10:00Z', '2024-02-06T01:20:00Z']) await t.tick(at);
    const rows = (await t.repo.payments.list()).map((p) => `${p.providerRef}=${p.status}`).sort();
    expect(rows).toEqual(['dunning-retry:sub_1:1=succeeded', 'dunning-retry:sub_1:2=succeeded']);
    expect(t.notices('renewal_settled_after_end')).toHaveLength(1);
    expect(t.notices('renewal_double_charge')).toHaveLength(1);
    expect(await t.usable('2024-01-20T00:00:00Z')).toBe(100); // one period granted once
    const before = t.provider.lookups.length;
    await t.tick('2024-02-07T01:00:00Z');
    expect(t.provider.lookups.length).toBe(before); // both keys settled: never asked again
  });

  it('EC:A56 (A7-5) past_due only because February got no answer, cron back after February ended: the lookup closes it and March is charged once', async () => {
    const t = await setup(mkSub('2024-01-01T00:00:00Z', '2024-02-01T00:00:00Z'), { dunning: { graceDays: 45 } });
    t.provider.nextChargeThrows = true; // the request never reached the provider
    await t.tick('2024-02-01T01:00:00Z');
    expect((await t.cur()).status).toBe('past_due');
    t.provider.nextChargeThrows = false;
    for (const at of ['2024-03-05T09:00:00Z', '2024-03-10T09:00:00Z', '2024-03-20T09:00:00Z']) await t.tick(at);
    expect(t.moved('2024-02-01')).toBe(0);
    expect(t.moved('2024-03-01')).toBe(1);
    expect((await t.repo.payments.get(attemptPaymentId(renewalAttemptKey({ id: 'sub_1' }, { start: new Date('2024-02-01T00:00:00Z'), end: new Date('2024-03-01T00:00:00Z') }))))?.failure?.code).toBe('order_not_found');
    const s = await t.cur();
    expect([s.status, s.currentPeriod.start.toISOString()]).toEqual(['active', '2024-03-01T00:00:00.000Z']);
    expect(t.notices('missed_periods_skipped')).toHaveLength(1);
  });

  it('EC:A57 (A7-6) the upgrade charge sends a valid orderId, and a retry after a lost answer asks first instead of charging again', async () => {
    const t = await setup(mkSub('2024-02-01T00:00:00Z', '2024-03-01T00:00:00Z'));
    const input = () => ({ sub: t.cur(), newPlan: plan('pro', 10000, 300), policy: t.policy, provider: t.provider, ledger: t.ledger, repo: t.repo,
      clock: t.clk('2024-02-15T00:00:00Z'), ids: new SequentialIdGen('u_') });
    t.provider.loseNextAnswer = true;
    await expect(upgrade({ ...input(), sub: await t.cur() })).rejects.toThrow();
    const r = await upgrade({ ...input(), sub: await t.cur() });
    expect(r.sub.planId).toBe('pro');
    expect(t.provider.moneyMoved.size).toBe(1);
    expect(t.provider.orderIds.every((o) => TOSS_ORDER_ID.test(o))).toBe(true);
    expect(t.provider.orderIds).toHaveLength(1);
  });

  it('EC:A57 (A7-6) an earlier release charged the upgrade under its raw key and lost the answer: the retry finds it and charges nothing', async () => {
    const t = await setup(mkSub('2024-02-01T00:00:00Z', '2024-03-01T00:00:00Z'));
    const opKey = 'upgrade:sub_1:pro:2024-02-01T00:00:00.000Z';
    const rawKey = 'charge:upgrade:sub_1:pro:2024-02-01T00:00:00.000Z';
    // what the earlier release left: the operation failed after the charge, which moved money under the raw key
    await t.repo.operations.claim({ id: opKey, key: opKey, kind: 'lifecycle.upgrade', payloadHash: 'x', status: 'in_progress', result: null, error: null,
      createdAt: new Date('2024-02-15T00:00:00Z'), completedAt: null, attempts: 0 });
    const op = (await t.repo.operations.get(opKey))!;
    const { hashPayload } = await import('boilpayment-core');
    await t.repo.operations.put({ ...op, status: 'failed', payloadHash: hashPayload({ subId: 'sub_1', newPlanId: 'pro', periodStart: '2024-02-01T00:00:00.000Z' }) });
    t.provider.seedOrder(rawKey, 'succeeded', 2500);
    const r = await upgrade({ sub: await t.cur(), newPlan: plan('pro', 10000, 300), policy: t.policy, provider: t.provider, ledger: t.ledger, repo: t.repo,
      clock: t.clk('2024-02-15T00:00:00Z'), ids: new SequentialIdGen('u_') });
    expect(r.sub.planId).toBe('pro');
    expect(t.provider.orderIds).toEqual([]);
    expect(t.provider.lookups).toContain(rawKey);
  });

  it('EC:A58 (A7-4) a held order that was partly refunded: void is refused, close ends the period with no grant and no second charge', async () => {
    const t = await setup(mkSub('2024-01-01T00:00:00Z', '2024-02-01T00:00:00Z'));
    const held = await heldRenewal(t, 'partially_refunded');
    const base = { paymentId: held.id, actor: 'ops@x', provider: t.provider, policy: t.policy, ledger: t.ledger, repo: t.repo, notifier: t.notifier };
    await expect(resolveHeldAttempt({ ...base, decision: 'void', clock: t.clk('2024-02-02T00:00:00Z') })).rejects.toMatchObject({ code: 'held_order_moved_money' });
    await expect(resolveHeldAttempt({ ...base, decision: 'settle', clock: t.clk('2024-02-02T00:00:00Z') })).rejects.toMatchObject({ code: 'held_order_not_paid' });
    const r = await resolveHeldAttempt({ ...base, decision: 'close', clock: t.clk('2024-02-02T00:00:00Z') });
    expect([r.payment.status, r.payment.failure?.code]).toEqual(['failed', 'review_closed']);
    expect([r.sub?.status, r.sub?.currentPeriod.start.toISOString()]).toEqual(['active', '2024-02-01T00:00:00.000Z']);
    for (const at of ['2024-02-02T02:00:00Z', '2024-02-03T02:00:00Z']) await t.tick(at);
    expect(t.moved('2024-02-01')).toBe(1); // the one charge that was held
    expect(await t.usable('2024-02-05T00:00:00Z')).toBe(0); // closed: no grant
    await t.tick('2024-03-01T01:00:00Z');
    expect(t.moved('2024-03-01')).toBe(1); // the next period renews as usual
  });

  it('EC:A58 (A7-4) void is refused when the provider shows the held order paid', async () => {
    const t = await setup(mkSub('2024-01-01T00:00:00Z', '2024-02-01T00:00:00Z'));
    const held = await heldRenewal(t, 'succeeded');
    await expect(resolveHeldAttempt({ paymentId: held.id, decision: 'void', actor: 'x', provider: t.provider, policy: t.policy, ledger: t.ledger, repo: t.repo,
      notifier: t.notifier, clock: t.clk('2024-02-02T00:00:00Z') })).rejects.toMatchObject({ code: 'held_order_moved_money', details: { status: 'succeeded' } });
    expect((await t.repo.payments.get(held.id))?.status).toBe('pending');
  });

  it('EC:A58 (A7-7) a decision while another worker holds the attempt is refused, and the row is untouched', async () => {
    const t = await setup(mkSub('2024-01-01T00:00:00Z', '2024-02-01T00:00:00Z'));
    const held = await heldRenewal(t, 'succeeded');
    const key = (held.raw as { boilpaymentAttemptKey: string }).boilpaymentAttemptKey;
    expect(providerOrderId(key)).toBe(held.providerRef);
    await withAttemptLease(t.repo, t.clk('2024-02-02T00:00:00Z'), key, async () => {
      await expect(resolveHeldAttempt({ paymentId: held.id, decision: 'settle', actor: 'x', provider: t.provider, policy: t.policy, ledger: t.ledger,
        repo: t.repo, clock: t.clk('2024-02-02T00:00:00Z') })).rejects.toMatchObject({ code: 'attempt_in_flight' });
    });
    expect((await t.repo.payments.get(held.id))?.status).toBe('pending');
    const r = await resolveHeldAttempt({ paymentId: held.id, decision: 'settle', actor: 'x', provider: t.provider, policy: t.policy, ledger: t.ledger,
      repo: t.repo, clock: t.clk('2024-02-02T00:01:00Z') });
    expect(r.payment.status).toBe('succeeded');
  });
});
