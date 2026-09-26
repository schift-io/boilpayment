// spec: packages/lifecycle/spec/lifecycle.pseudo.md [EC:A23]
import { describe, expect, it } from 'vitest';
import {
  CollectingLogger,
  FixedClock,
  InMemoryLedger,
  InMemoryRepo,
  PaymentKitError,
  Subscription,
  SequentialIdGen,
  resolvePolicy,
} from 'boilpayment-core';
import { cancel, reactivate } from '../src/index.js';
import { FakeCorrelatingProvider, FakeNativeProvider, FakeSelfSchedulingProvider } from './helpers.js';

function mkSub(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 'sub_1', customerId: 'cust_1', planId: 'plan_a', provider: 'stripe', providerRef: 'stripe_sub_1',
    status: 'active', currentPeriod: { start: new Date('2024-01-01T00:00:00.000Z'), end: new Date('2024-02-01T00:00:00.000Z') },
    anchorDay: 1, cancelAtPeriodEnd: false, graceUntil: null, billingKey: null, scheduledPlanId: null,
    version: 0, createdAt: new Date('2024-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

async function setup(paidBalance: number, now = new Date('2024-01-16T00:00:00.000Z')) {
  const clock = new FixedClock(now);
  const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
  const repo = new InMemoryRepo();
  if (paidBalance > 0) {
    await ledger.append({
      customerId: 'cust_1', pool: 'paid', kind: 'grant', amount: paidBalance, unitPriceMinor: 5, currency: 'USD',
      expiresAt: null, source: 'subscription', reference: {}, idempotencyKey: 'seed_grant', actor: 'system', reason: null,
    });
  }
  return { clock, ledger, repo };
}

describe('EC:A23 reactivate', () => {
  it('cancelAtPeriodEnd=true -> clears it, status stays active, provider uncancelSubscription called (providerNotified:true)', async () => {
    const { clock, ledger, repo } = await setup(0);
    const sub = mkSub({ status: 'active', cancelAtPeriodEnd: true });
    await repo.subscriptions.put(sub);
    const provider = new FakeNativeProvider();
    provider.setDummySub(sub);
    const policy = resolvePolicy();

    const res = await reactivate({ sub, policy, provider, ledger, repo, clock });
    expect(res.sub.status).toBe('active');
    expect(res.sub.cancelAtPeriodEnd).toBe(false);
    expect(provider.uncancelSubscriptionCalled).toBe(1);
    expect(res.providerNotified).toBe(true);
  });

  it("status='canceled' and now < currentPeriod.end -> back to active, providerNotified:true", async () => {
    const { clock, ledger, repo } = await setup(0);
    const sub = mkSub({ status: 'canceled', cancelAtPeriodEnd: false });
    await repo.subscriptions.put(sub);
    const provider = new FakeNativeProvider();
    provider.setDummySub(sub);
    const policy = resolvePolicy();

    const res = await reactivate({ sub, policy, provider, ledger, repo, clock });
    expect(res.sub.status).toBe('active');
    expect(res.sub.cancelAtPeriodEnd).toBe(false);
    expect(res.providerNotified).toBe(true);
  });

  it("native provider throws PaymentKitError('unsupported') -> repo repair still happens, providerNotified:false", async () => {
    const { clock, ledger, repo } = await setup(0);
    const sub = mkSub({ status: 'active', cancelAtPeriodEnd: true });
    await repo.subscriptions.put(sub);
    const provider = new FakeNativeProvider();
    provider.setDummySub(sub);
    provider.nextUncancelThrows = new PaymentKitError('uncancel not implemented for this adapter', 'unsupported');
    const policy = resolvePolicy();

    const res = await reactivate({ sub, policy, provider, ledger, repo, clock });
    expect(res.sub.status).toBe('active');
    expect(res.sub.cancelAtPeriodEnd).toBe(false);
    expect(res.providerNotified).toBe(false);
    // repo row was still corrected despite the provider call failing with 'unsupported'.
    expect((await repo.subscriptions.get(sub.id))?.cancelAtPeriodEnd).toBe(false);
  });

  it("native provider throws PaymentKitError('not_reactivatable') (e.g. Stripe subscription already fully canceled) -> propagates, no repo write", async () => {
    const { clock, ledger, repo } = await setup(0);
    const sub = mkSub({ status: 'active', cancelAtPeriodEnd: true });
    await repo.subscriptions.put(sub);
    const provider = new FakeNativeProvider();
    provider.setDummySub(sub);
    provider.nextUncancelThrows = new PaymentKitError('stripe subscription sub_1 is fully canceled and cannot be reactivated (status=canceled)', 'not_reactivatable');
    const policy = resolvePolicy();

    await expect(reactivate({ sub, policy, provider, ledger, repo, clock })).rejects.toMatchObject({ code: 'not_reactivatable' });
    // the Repo row was never corrected — the provider-side error propagated instead.
    expect((await repo.subscriptions.get(sub.id))?.cancelAtPeriodEnd).toBe(true);
  });

  it('EC:L5 — a correlationId scopes the uncancelSubscription call to the provider withCorrelationId clone, reaching its logger', async () => {
    const { clock, ledger, repo } = await setup(0);
    const sub = mkSub({ status: 'active', cancelAtPeriodEnd: true });
    await repo.subscriptions.put(sub);
    const logger = new CollectingLogger();
    const provider = new FakeCorrelatingProvider(logger);
    provider.setDummySub(sub);
    const policy = resolvePolicy();

    await reactivate({ sub, policy, provider, ledger, repo, clock, correlationId: 'corr_reactivate_1' });
    const entry = logger.entries.find((e) => e.event === 'provider.request');
    expect(entry?.correlationId).toBe('corr_reactivate_1');
  });

  it("status='expired' -> throws PaymentKitError('not_reactivatable')", async () => {
    const { clock, ledger, repo } = await setup(0);
    const sub = mkSub({ status: 'expired', cancelAtPeriodEnd: false });
    await repo.subscriptions.put(sub);
    const provider = new FakeNativeProvider();
    const policy = resolvePolicy();

    await expect(reactivate({ sub, policy, provider, ledger, repo, clock })).rejects.toMatchObject({ code: 'not_reactivatable' });
  });

  it("status='canceled' but the period already ended -> throws not_reactivatable (start a new subscription)", async () => {
    const { clock, ledger, repo } = await setup(0, new Date('2024-03-01T00:00:00.000Z'));
    const sub = mkSub({ status: 'canceled', cancelAtPeriodEnd: false });
    await repo.subscriptions.put(sub);
    const provider = new FakeNativeProvider();
    const policy = resolvePolicy();

    await expect(reactivate({ sub, policy, provider, ledger, repo, clock })).rejects.toMatchObject({ code: 'not_reactivatable' });
  });

  it('active with no pending cancellation -> throws not_reactivatable (nothing to undo)', async () => {
    const { clock, ledger, repo } = await setup(0);
    const sub = mkSub({ status: 'active', cancelAtPeriodEnd: false });
    await repo.subscriptions.put(sub);
    const provider = new FakeNativeProvider();
    const policy = resolvePolicy();

    await expect(reactivate({ sub, policy, provider, ledger, repo, clock })).rejects.toMatchObject({ code: 'not_reactivatable' });
  });

  it('self-scheduling provider (Toss-shaped) never gets a provider call, providerNotified:false, repo repair still happens', async () => {
    const { clock, ledger, repo } = await setup(0);
    const sub = mkSub({ id: 'sub_toss_1', customerId: 'cust_toss_1', provider: 'toss', providerRef: 'toss_sub_1', status: 'canceled' });
    await repo.subscriptions.put(sub);
    const provider = new FakeSelfSchedulingProvider(); // every method not exercised throws loudly
    const policy = resolvePolicy();

    const res = await reactivate({ sub, policy, provider, ledger, repo, clock });
    expect(res.sub.status).toBe('active');
    expect(res.providerNotified).toBe(false);
    expect((await repo.subscriptions.get(sub.id))?.status).toBe('active');
  });

  describe('policy.cancel.credits === revoke_immediately restore', () => {
    it('cancel (revoke_immediately) then reactivate restores the full revoked balance, attributed per bucket with original expiry preserved', async () => {
      const { clock, ledger, repo } = await setup(0);
      const inA = new Date('2024-01-20T00:00:00.000Z');
      const inB = new Date('2024-01-25T00:00:00.000Z');
      await ledger.append({
        customerId: 'cust_1', pool: 'paid', kind: 'grant', amount: 40, unitPriceMinor: 2, currency: 'USD',
        expiresAt: inA, source: 'subscription', reference: {}, idempotencyKey: 'grantA', actor: 'system', reason: null,
      });
      await ledger.append({
        customerId: 'cust_1', pool: 'paid', kind: 'grant', amount: 60, unitPriceMinor: 3, currency: 'USD',
        expiresAt: inB, source: 'subscription', reference: {}, idempotencyKey: 'grantB', actor: 'system', reason: null,
      });

      const sub = mkSub();
      await repo.subscriptions.put(sub);
      const provider = new FakeNativeProvider();
      provider.setDummySub(sub);
      const policy = resolvePolicy({ cancel: { credits: 'revoke_immediately' } });

      const cancelRes = await cancel({ sub, policy, provider, ledger, repo, clock });
      expect(cancelRes.revoked?.revoked).toBe(100);
      expect((await ledger.balance('cust_1', undefined, clock.now())).available).toBe(0);

      const canceledSub = cancelRes.sub;
      const reactivateRes = await reactivate({ sub: canceledSub, policy, provider, ledger, repo, clock });
      expect(reactivateRes.sub.status).toBe('active');
      expect(reactivateRes.restored?.restored).toBe(100);

      const balAfter = await ledger.balance('cust_1', undefined, clock.now());
      expect(balAfter.available).toBe(100);

      // per-bucket attribution: restored amounts land back with their ORIGINAL expiry, not a fresh one.
      const paidEntries = await ledger.entries('cust_1', { pool: 'paid' });
      const restoreEntries = paidEntries.filter((e) => e.idempotencyKey.startsWith('restore:reactivate:'));
      const byExpiry = new Map<number, number>();
      for (const e of restoreEntries) {
        const key = e.expiresAt ? e.expiresAt.getTime() : 0;
        byExpiry.set(key, (byExpiry.get(key) ?? 0) + e.amount);
      }
      expect(byExpiry.get(inA.getTime())).toBe(40);
      expect(byExpiry.get(inB.getTime())).toBe(60);
    });

    it('is idempotent — calling reactivate twice does not double-restore', async () => {
      const { clock, ledger, repo } = await setup(100);
      const sub = mkSub();
      await repo.subscriptions.put(sub);
      const provider = new FakeNativeProvider();
      provider.setDummySub(sub);
      const policy = resolvePolicy({ cancel: { credits: 'revoke_immediately' } });

      const cancelRes = await cancel({ sub, policy, provider, ledger, repo, clock });
      const canceledSub = cancelRes.sub;

      const first = await reactivate({ sub: canceledSub, policy, provider, ledger, repo, clock });
      expect(first.restored?.restored).toBe(100);

      const second = await reactivate({ sub: canceledSub, policy, provider, ledger, repo, clock });
      expect(second.sub.status).toBe('active');
      // replayed idempotent result — balance still 100, not 200
      expect((await ledger.balance('cust_1', undefined, clock.now())).available).toBe(100);
    });
  });
});
