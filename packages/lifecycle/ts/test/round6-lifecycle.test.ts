// Round-6 audit regressions (scratchpad bp-audit6.md): A6-3 (EC:A50 row amount, A53 resolve), A6-4
// (EC:A47 open attempt), A6-5 (EC:A39 notice once), A6-7 (EC:A54 resume parked), I-1 (EC:A48 claim token).
import { describe, expect, it } from 'vitest';
import { CollectingNotifier, FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen, resolvePolicy } from 'boilpayment-core';
import type { OutboxItem, Payment, Plan, Policy, Subscription } from 'boilpayment-core';
import { dunning, resolveHeldAttempt, resumeParked, scheduler } from '../src/index.js';
import { attemptPaymentId, dunningAttemptKey, providerOrderId, renewalAttemptKey, withAttemptLease } from '../src/charge-attempt.js';
import { FakeSelfSchedulingProvider } from './helpers.js';

const basic = (amountMinor = 5000): Plan => ({ id: 'basic', name: 'Basic', interval: 'month', creditsPerPeriod: 100, usageIncluded: 0, trialDays: 0,
  prices: [{ currency: 'KRW', amountMinor, providerPriceRefs: {} }] });
const mkSub = (start: string, end: string, status: Subscription['status'] = 'active', graceUntil: string | null = null): Subscription => ({
  id: 'sub_1', customerId: 'c1', planId: 'basic', provider: 'toss', providerRef: null, status, currentPeriod: { start: new Date(start), end: new Date(end) },
  anchorDay: 1, cancelAtPeriodEnd: false, graceUntil: graceUntil ? new Date(graceUntil) : null, billingKey: 'bk', scheduledPlanId: null, version: 0,
  currency: 'KRW', createdAt: new Date(start) } as Subscription);

async function setup(sub: Subscription, patch: Partial<Policy['subscription']> = {}) {
  const repo = new InMemoryRepo();
  await repo.plans.put(basic());
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
  const setPrice = (amountMinor: number) => repo.plans.put(basic(amountMinor));
  return { repo, ledger, notifier, provider, policy, clk, tick, retries, cur, usable, notices, moved, setPrice };
}

/** An attempt row written durably but never sent (the worker died before the provider call). */
const unsentRow = (key: string, start: string, end: string, amountMinor = 5000): Payment => ({
  id: attemptPaymentId(key), customerId: 'c1', provider: 'toss', providerRef: providerOrderId(key), subscriptionId: 'sub_1',
  amount: { amountMinor, currency: 'KRW' }, status: 'pending', kind: 'subscription', period: { start: new Date(start), end: new Date(end) },
  occurredAt: new Date(start), failure: null, cashReceipt: null, raw: { boilpaymentAttemptKey: key } } as Payment);

const FEB = { start: new Date('2024-02-01T00:00:00Z'), end: new Date('2024-03-01T00:00:00Z') };

describe('round-6 lifecycle regressions', () => {
  it('EC:A50 (A6-3) the merchant raises the price after the answer was lost: the lookup matches the amount sent, the renewal settles', async () => {
    const t = await setup(mkSub('2024-01-01T00:00:00Z', '2024-02-01T00:00:00Z'));
    t.provider.loseNextAnswer = true;
    await t.tick('2024-02-01T01:00:00Z');
    await t.setPrice(6000);
    await t.tick('2024-02-01T01:10:00Z');
    expect(t.moved('2024-02-01')).toBe(1);
    expect((await t.repo.payments.list()).map((p) => `${p.status}:${p.amount.amountMinor}`)).toEqual(['succeeded:5000']);
    expect((await t.cur()).status).toBe('active');
    expect(await t.usable('2024-02-02T00:00:00Z')).toBe(100);
    expect(t.notices('attempt_lookup_mismatch')).toHaveLength(0);
  });

  it('EC:A50 (A6-3) a re-drive re-sends the amount its key was first written with, not the new price', async () => {
    const t = await setup(mkSub('2024-01-01T00:00:00Z', '2024-02-01T00:00:00Z'));
    const key = renewalAttemptKey({ id: 'sub_1' }, FEB);
    await t.repo.payments.put(unsentRow(key, '2024-02-01T00:00:00Z', '2024-03-01T00:00:00Z'));
    await t.setPrice(6000);
    await t.tick('2024-02-01T01:00:00Z');
    expect(t.provider.lastCharge).toMatchObject({ amountMinor: 5000, idempotencyKey: key });
    expect((await t.cur()).currentPeriod.start.toISOString()).toBe('2024-02-01T00:00:00.000Z');
  });

  it('EC:A50 (A6-3) a legacy dunning charge of another amount settles at the provider amount and tells a person', async () => {
    const t = await setup(mkSub('2024-01-01T00:00:00Z', '2024-02-01T00:00:00Z', 'past_due', '2024-02-08T01:00:00Z'));
    await t.repo.outbox.put({ id: 'dunning-retry-item:sub_1:1', kind: 'dunning.retry', payload: { subscriptionId: 'sub_1', attempt: 1 },
      status: 'sent', attempts: 1, nextAttemptAt: new Date('2024-02-02T01:00:00Z'), createdAt: new Date('2024-02-01T01:00:00Z') } as OutboxItem);
    await t.repo.outbox.put({ id: 'dunning-retry-item:sub_1:2', kind: 'dunning.retry', payload: { subscriptionId: 'sub_1', attempt: 2 },
      status: 'pending', attempts: 0, nextAttemptAt: new Date('2024-02-02T03:00:00Z'), createdAt: new Date('2024-02-02T01:00:00Z') } as OutboxItem);
    t.provider.seedOrder('dunning-retry:sub_1:1', 'succeeded', 4000);
    expect(await t.retries('2024-02-02T03:00:00Z')).toEqual(['recovered']);
    expect((await t.cur()).status).toBe('active');
    expect(await t.usable('2024-02-02T04:00:00Z')).toBe(100);
    expect(t.notices('legacy_settled_at_provider_amount')).toHaveLength(1);
    expect(t.notices('attempt_lookup_mismatch')).toHaveLength(0);
    expect(t.provider.orderIds).toHaveLength(0);
  });

  it('EC:A53 a held attempt is settled by a person: succeeded at the provider amount, its period granted', async () => {
    const t = await setup(mkSub('2024-01-01T00:00:00Z', '2024-02-01T00:00:00Z'));
    t.provider.loseNextAnswer = true;
    await t.tick('2024-02-01T01:00:00Z');
    t.provider.lookupOverride = (_id, found) => (found ? { ...found, amount: { amountMinor: 4500, currency: 'KRW' } } : null);
    await t.tick('2024-02-01T01:10:00Z');
    const [held] = await t.repo.payments.list();
    expect(t.notices('attempt_lookup_mismatch')).toHaveLength(1);
    const r = await resolveHeldAttempt({ paymentId: held.id, decision: 'settle', actor: 'ops@x', provider: t.provider as any, policy: t.policy, ledger: t.ledger, repo: t.repo, clock: t.clk('2024-02-02T00:00:00Z') });
    expect(r.payment.status).toBe('succeeded');
    expect(r.payment.amount.amountMinor).toBe(4500);
    expect(r.sub?.status).toBe('active');
    expect(await t.usable('2024-02-02T01:00:00Z')).toBe(100);
    await t.tick('2024-02-02T02:00:00Z');
    expect(t.moved('2024-02-01')).toBe(1);
    await expect(resolveHeldAttempt({ paymentId: held.id, decision: 'void', actor: 'x', provider: t.provider as any, policy: t.policy, ledger: t.ledger, repo: t.repo, clock: t.clk('2024-02-02T03:00:00Z') }))
      .rejects.toMatchObject({ code: 'attempt_not_held' });
  });

  it('EC:A53 a held refunded order is voided: the row fails, dunning takes over, nothing granted', async () => {
    const t = await setup(mkSub('2024-01-01T00:00:00Z', '2024-02-01T00:00:00Z'));
    t.provider.loseNextAnswer = true;
    await t.tick('2024-02-01T01:00:00Z');
    t.provider.lookupOverride = (_id, found) => (found ? { ...found, status: 'refunded' } : null);
    await t.tick('2024-02-01T01:10:00Z');
    const [held] = await t.repo.payments.list();
    await expect(resolveHeldAttempt({ paymentId: held.id, decision: 'settle', actor: 'x', provider: t.provider as any, policy: t.policy, ledger: t.ledger, repo: t.repo, clock: t.clk('2024-02-02T00:00:00Z') }))
      .rejects.toMatchObject({ code: 'held_order_not_paid' });
    const r = await resolveHeldAttempt({ paymentId: held.id, decision: 'void', actor: 'x', provider: t.provider as any, policy: t.policy, ledger: t.ledger, repo: t.repo, notifier: t.notifier, clock: t.clk('2024-02-02T00:00:00Z') });
    expect(r.payment.status).toBe('failed');
    expect(r.sub?.status).toBe('past_due');
    expect(await t.usable('2024-02-02T01:00:00Z')).toBe(0);
    expect((await dunning.retryDue({ repo: t.repo, clock: t.clk('2024-02-10T00:00:00Z') })).length).toBe(1);
  });

  it('EC:A47 (A6-4) the scheduler attempt for February was written but never sent; cron stopped until April 15: only April is charged', async () => {
    const t = await setup(mkSub('2024-01-01T00:00:00Z', '2024-02-01T00:00:00Z'));
    await t.repo.payments.put(unsentRow(renewalAttemptKey({ id: 'sub_1' }, FEB), '2024-02-01T00:00:00Z', '2024-03-01T00:00:00Z'));
    for (const at of ['2024-04-15T00:00:00Z', '2024-04-15T00:10:00Z', '2024-05-01T01:00:00Z']) await t.tick(at);
    expect(t.moved('2024-02-01')).toBe(0);
    expect(t.moved('2024-04-01')).toBe(1);
    expect(t.moved('2024-05-01')).toBe(1);
    expect((await t.repo.payments.get(attemptPaymentId(renewalAttemptKey({ id: 'sub_1' }, FEB))))?.failure?.code).toBe('order_not_found');
    expect(t.notices('missed_periods_skipped')).toHaveLength(1);
  });

  it('EC:A47 (A6-4) a dunning retry for February written but never sent; retries resume April 15: only April is charged', async () => {
    const t = await setup(mkSub('2024-01-01T00:00:00Z', '2024-02-01T00:00:00Z', 'past_due', '2024-02-08T00:00:00Z'));
    const key = dunningAttemptKey({ id: 'sub_1' }, FEB, 1);
    await t.repo.payments.put(unsentRow(key, '2024-02-01T00:00:00Z', '2024-03-01T00:00:00Z'));
    await t.repo.outbox.put({ id: 'dunning-retry-item:sub_1:1', kind: 'dunning.retry', payload: { subscriptionId: 'sub_1', attempt: 1 },
      status: 'pending', attempts: 0, nextAttemptAt: new Date('2024-02-03T00:00:00Z'), createdAt: new Date('2024-02-01T01:00:00Z') } as OutboxItem);
    expect(await t.retries('2024-04-15T00:00:00Z')).toEqual(['recovered']);
    expect(t.moved('2024-02-01')).toBe(0);
    expect(t.moved('2024-04-01')).toBe(1);
    expect((await t.cur()).currentPeriod.start.toISOString()).toBe('2024-04-01T00:00:00.000Z');
  });

  it('EC:A39 (A6-5) an ended subscription\'s legacy charge is settled and told once, not on every tick', async () => {
    const t = await setup(mkSub('2023-12-01T00:00:00Z', '2024-01-01T00:00:00Z', 'expired'));
    const JAN = { start: new Date('2024-01-01T00:00:00Z'), end: new Date('2024-02-01T00:00:00Z') };
    for (const attempt of [1, 2]) {
      await t.repo.outbox.put({ id: `dunning-retry-item:sub_1:${attempt}`, kind: 'dunning.retry', payload: { subscriptionId: 'sub_1', attempt },
        status: 'sent', attempts: 1, nextAttemptAt: new Date('2024-01-02T01:00:00Z'), createdAt: new Date(`2024-01-0${attempt}T01:00:00Z`) } as OutboxItem);
    }
    t.provider.seedOrder('dunning-retry:sub_1:1', 'succeeded');
    // retry 2 ran on this release (its own row, period in the key): never a legacy key
    await t.repo.payments.put({ ...unsentRow(dunningAttemptKey({ id: 'sub_1' }, JAN, 2), '2024-01-01T00:00:00Z', '2024-02-01T00:00:00Z'), status: 'failed' });
    for (const at of ['2024-02-06T01:00:00Z', '2024-02-06T01:10:00Z', '2024-02-06T01:20:00Z', '2024-02-07T01:00:00Z']) await t.tick(at);
    expect(t.notices('renewal_settled_after_end')).toHaveLength(1);
    expect(await t.usable('2024-01-20T00:00:00Z')).toBe(100);
  });

  it('EC:A54 (A6-7) a parked subscription resumes from the current period and is charged once', async () => {
    const t = await setup(mkSub('2024-01-01T00:00:00Z', '2024-02-01T00:00:00Z'), { missedPeriods: 'needs_human_only' });
    await t.tick('2024-04-15T00:00:00Z');
    expect((await t.cur()).status).toBe('past_due');
    await expect(resumeParked({ subscriptionId: 'nope', actor: 'x', policy: t.policy, repo: t.repo, clock: t.clk('2024-04-16T00:00:00Z') }))
      .rejects.toMatchObject({ code: 'not_parked' });
    const resumed = await resumeParked({ subscriptionId: 'sub_1', actor: 'ops@x', policy: t.policy, repo: t.repo, notifier: t.notifier, clock: t.clk('2024-04-16T00:00:00Z') });
    expect(resumed.status).toBe('active');
    expect(resumed.currentPeriod.start.toISOString()).toBe('2024-03-01T00:00:00.000Z');
    await t.tick('2024-04-16T00:10:00Z');
    await t.tick('2024-04-16T00:20:00Z');
    expect(t.provider.moneyMoved.size).toBe(1);
    expect(t.moved('2024-04-01')).toBe(1);
    expect((await t.cur()).status).toBe('active');
    expect(t.notices('missed_periods_parked')).toHaveLength(1);
    expect(t.notices('missed_periods_resumed')).toHaveLength(1);
  });

  it('EC:A48 (I-1) a claimed lease row carries its owner token at once: a late "unleasedSince" write cannot land on it', async () => {
    const repo = new InMemoryRepo();
    const clock = new FixedClock(new Date('2024-02-01T00:00:00Z'));
    await withAttemptLease(repo, clock, 'k', async () => {
      const row = await repo.operations.get('charge-lease:k');
      expect((row?.result as { token?: string } | null)?.token).toBeTruthy();
      const late = await repo.operations.compareAndSet!({ key: 'charge-lease:k', status: 'in_progress', result: null },
        { ...row!, result: { unleasedSince: clock.now().toISOString() } });
      expect(late).toBe(false);
    });
  });
});
