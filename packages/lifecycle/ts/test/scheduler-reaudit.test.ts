// Re-audit regressions for the self-scheduled renewal loop:
// [EC:A29] a scheduled plan change is charged at the new plan's price (same plan that is granted).
// [EC:A30] one subscription's unresolved charge or local failure never stops the others, and a charge
//          that succeeded before a local failure is resumed next tick without charging again.
// [EC:A31] a plan without the subscription's currency is not left silently active: dunning + a person told.
// [EC:A32] a late renewal payment never reactivates a canceled subscription.
import { describe, it, expect } from 'vitest';
import { CollectingNotifier, FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen, resolvePolicy } from 'boilpayment-core';
import type { LedgerStore, NewLedgerEntry, Payment, Plan, Subscription } from 'boilpayment-core';
import { onRenewalPaid, scheduler } from '../src/index.js';
import { FakeSelfSchedulingProvider } from './helpers.js';

const plan = (id: string, credits: number, amountMinor: number, currency = 'KRW'): Plan => ({ id, name: id, interval: 'month',
  creditsPerPeriod: credits, usageIncluded: 0, trialDays: 0, prices: [{ currency, amountMinor, providerPriceRefs: {} }] });
const sub = (id: string, extra: Partial<Subscription> = {}): Subscription => ({ id, customerId: `c_${id}`, planId: 'pro', provider: 'toss',
  providerRef: null, status: 'active', currentPeriod: { start: new Date('2024-01-01T00:00:00Z'), end: new Date('2024-02-01T00:00:00Z') },
  anchorDay: 1, cancelAtPeriodEnd: false, graceUntil: null, billingKey: `bk_${id}`, scheduledPlanId: null, version: 0, currency: 'KRW',
  createdAt: new Date('2024-01-01T00:00:00Z'), ...extra });
const at = (day: string) => new FixedClock(new Date(`${day}T01:00:00Z`));
const endOf = async (repo: InMemoryRepo, id: string) => (await repo.subscriptions.get(id))!.currentPeriod.end.toISOString().slice(0, 10);

async function setup(subs: Subscription[]) {
  const repo = new InMemoryRepo();
  for (const p of [plan('pro', 1000, 50000), plan('basic', 100, 5000)]) await repo.plans.put(p);
  for (const s of subs) await repo.subscriptions.put(s);
  return { repo, ledger: new InMemoryLedger(new SequentialIdGen('l_')), notifier: new CollectingNotifier() };
}

describe('scheduler re-audit', () => {
  it('[EC:A29] a scheduled downgrade renews at the new plan price and grants the new plan', async () => {
    const { repo, ledger } = await setup([sub('s1', { scheduledPlanId: 'basic' })]);
    const provider = new FakeSelfSchedulingProvider();
    await scheduler.tick({ provider, repo, ledger, policy: resolvePolicy(), clock: at('2024-02-01'), ids: new SequentialIdGen('i_') });
    expect(provider.lastCharge?.amountMinor).toBe(5000);
    expect((await repo.subscriptions.get('s1'))!.planId).toBe('basic');
    expect((await ledger.balance('c_s1', undefined, new Date('2024-02-02'))).available).toBe(100);
  });

  it('[EC:A30] an unresolved charge is reported and the other subscriptions still renew', async () => {
    const { repo, ledger } = await setup([sub('s1'), sub('s2'), sub('s3')]);
    class P extends FakeSelfSchedulingProvider {
      async chargeBillingKey(i: Parameters<FakeSelfSchedulingProvider['chargeBillingKey']>[0]) {
        const p = await super.chargeBillingKey(i); return i.billingKey === 'bk_s1' ? { ...p, status: 'pending' as const } : p;
      }
    }
    const r = await scheduler.tick({ provider: new P(), repo, ledger, policy: resolvePolicy(), clock: at('2024-02-01'), ids: new SequentialIdGen('i_') });
    expect(r.errors.map((e) => [e.subscriptionId, e.code])).toEqual([['s1', 'scheduler_charge_unresolved']]);
    expect([await endOf(repo, 's1'), await endOf(repo, 's2'), await endOf(repo, 's3')]).toEqual(['2024-02-01', '2024-03-01', '2024-03-01']);
  });

  it('[EC:A30] a charge that succeeded before a local failure is resumed next tick without a second charge', async () => {
    const { repo, ledger } = await setup([sub('s1')]);
    let failGrantOnce = true;
    const flaky: LedgerStore = Object.create(ledger);
    flaky.append = async (e: NewLedgerEntry) => {
      if (failGrantOnce && e.kind === 'grant') { failGrantOnce = false; throw new Error('db blip'); }
      return ledger.append(e);
    };
    const provider = new FakeSelfSchedulingProvider(); let charges = 0; const orig = provider.chargeBillingKey.bind(provider);
    provider.chargeBillingKey = async (i) => { charges++; return orig(i); };
    const first = await scheduler.tick({ provider, repo, ledger: flaky, policy: resolvePolicy(), clock: at('2024-02-01'), ids: new SequentialIdGen('i_') });
    expect(first.errors.map((e) => e.subscriptionId)).toEqual(['s1']);
    await scheduler.tick({ provider, repo, ledger: flaky, policy: resolvePolicy(), clock: at('2024-02-02'), ids: new SequentialIdGen('j_') });
    expect(charges).toBe(1);
    expect(await endOf(repo, 's1')).toBe('2024-03-01');
    expect((await ledger.balance('c_s1', undefined, new Date('2024-02-03'))).available).toBe(1000);
    expect((await repo.payments.list()).length).toBe(1);
  });

  it('[EC:A31] a scheduled plan that no longer exists is not charged; the rest renew; a person is told', async () => {
    const { repo, ledger, notifier } = await setup([sub('s1', { scheduledPlanId: 'plan_deleted' }), sub('s2')]);
    const provider = new FakeSelfSchedulingProvider(); let charges = 0; const orig = provider.chargeBillingKey.bind(provider);
    provider.chargeBillingKey = async (i) => { charges++; return orig(i); };
    await scheduler.tick({ provider, repo, ledger, notifier, policy: resolvePolicy(), clock: at('2024-02-01'), ids: new SequentialIdGen('i_') });
    expect(charges).toBe(1); // s2 only
    expect((await repo.subscriptions.get('s1'))!.status).toBe('past_due');
    expect(await endOf(repo, 's2')).toBe('2024-03-01');
    expect(notifier.sent.some((n) => n.type === 'cs.needs_human' && n.payload.kind === 'plan_price_missing' && n.payload.subscriptionId === 's1')).toBe(true);
  });

  it('[EC:A31] a plan without the subscription currency goes to dunning and is told once, not active forever', async () => {
    const { repo, ledger, notifier } = await setup([sub('s1', { currency: 'USD' })]);
    const provider = new FakeSelfSchedulingProvider();
    for (const day of ['2024-02-01', '2024-03-15']) {
      await scheduler.tick({ provider, repo, ledger, notifier, policy: resolvePolicy(), clock: at(day), ids: new SequentialIdGen(`i${day}`) });
    }
    expect(provider.lastCharge).toBeNull();
    expect((await repo.subscriptions.get('s1'))!.status).not.toBe('active');
    expect(notifier.sent.filter((n) => n.type === 'cs.needs_human' && n.payload.kind === 'plan_price_missing').length).toBe(1);
  });

  it('[EC:A32] a late renewal payment grants the paid period but keeps a canceled subscription canceled', async () => {
    const { repo, ledger } = await setup([sub('s1', { status: 'canceled' })]);
    const s = (await repo.subscriptions.get('s1'))!;
    const payment: Payment = { id: 'pay_1', customerId: 'c_s1', provider: 'toss', providerRef: 'tx_1', subscriptionId: 's1',
      amount: { amountMinor: 50000, currency: 'KRW' }, status: 'succeeded', kind: 'subscription',
      period: { start: new Date('2024-02-01T00:00:00Z'), end: new Date('2024-03-01T00:00:00Z') }, occurredAt: new Date('2024-02-01T00:00:00Z'), failure: null };
    const r = await onRenewalPaid({ sub: s, payment, policy: resolvePolicy(), ledger, repo, clock: at('2024-02-01') });
    expect(r.sub.status).toBe('canceled');
    expect((await repo.subscriptions.get('s1'))!.status).toBe('canceled');
    expect((await ledger.balance('c_s1', undefined, new Date('2024-02-02'))).available).toBe(1000);
  });
});
