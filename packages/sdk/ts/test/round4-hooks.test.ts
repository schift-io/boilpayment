// Round-4 audit regressions (bp-audit4.md A4-10, EC:A46 A38): reconcile over self-scheduled attempt rows.
// Fake/env ported from the auditor's PoC; a getPaymentByOrderId lookup is added to the fake.
import { describe, expect, it } from 'vitest';
import { CollectingNotifier, FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen, resolvePolicy } from 'boilpayment-core';
import type { Money, Payment, PaymentProvider, PaymentStatus, Plan, Refund, Subscription } from 'boilpayment-core';
import { dunning, scheduler } from 'boilpayment-lifecycle';
import { topup, grantForPeriod } from 'boilpayment-credits';
import { recoverMissingGrants } from 'boilpayment-cs';

class Fake {
  constructor(readonly name: 'toss' | 'portone') {}
  answers = new Map<string, Payment>();
  byRef = new Map<string, Payment>();
  nextStatus: PaymentStatus = 'succeeded';
  refunds: string[] = [];
  capabilities() { return { nativeSubscriptions: false, partialRefund: true, meters: false, scheduling: 'self' as const, webhookSignature: true }; }
  async chargeBillingKey(i: { amount: Money; orderId: string; customerRef: string; idempotencyKey: string }): Promise<Payment> {
    const r = this.answers.get(i.idempotencyKey); if (r) return r;
    const ref = this.name === 'portone' ? i.orderId : 'pk_' + i.orderId;
    const p: Payment = { id: 'x', customerId: i.customerRef, provider: this.name, providerRef: ref, subscriptionId: null, amount: i.amount, status: this.nextStatus,
      kind: 'subscription', period: null, occurredAt: new Date('2024-02-01T01:00:00Z'), cashReceipt: null,
      failure: this.nextStatus === 'failed' ? { code: 'card_declined', providerCode: null, retryable: true, userMessage: 'd' } : null };
    this.answers.set(i.idempotencyKey, p); this.byRef.set(ref, p); return p;
  }
  settle(key: string, status: PaymentStatus) { const p = this.answers.get(key)!; const q = { ...p, status }; this.answers.set(key, q); this.byRef.set(p.providerRef, q); }
  async getPaymentByOrderId(orderId: string): Promise<Payment | null> { return this.byRef.get(orderId) ?? this.byRef.get('pk_' + orderId) ?? null; }
  async getPayment(ref: string): Promise<Payment> { const p = this.byRef.get(ref); if (!p) throw new Error('not found ' + ref); return p; }
  async listPayments() { return [...this.byRef.values()]; }
  async refund(i: { paymentRef: string; amount: Money; idempotencyKey: string }): Promise<Refund> {
    this.refunds.push(`${i.paymentRef}:${i.amount.amountMinor}`);
    return { id: 'r', paymentId: '', provider: this.name, providerRef: 're_' + i.idempotencyKey.slice(-8), amount: i.amount, status: 'succeeded', reason: null, failure: null, createdAt: new Date('2024-02-02T00:00:00Z') } as unknown as Refund;
  }
}

const plan: Plan = { id: 'basic', name: 'Basic', interval: 'month', creditsPerPeriod: 100, usageIncluded: 0, trialDays: 0,
  prices: [{ currency: 'KRW', amountMinor: 5000, providerPriceRefs: {} }] };
const mkSub = (provider: 'toss' | 'portone'): Subscription => ({ id: 'sub_1', customerId: 'c1', planId: 'basic', provider, providerRef: null, status: 'active',
  currentPeriod: { start: new Date('2024-01-01T00:00:00Z'), end: new Date('2024-02-01T00:00:00Z') }, anchorDay: 1, cancelAtPeriodEnd: false,
  graceUntil: null, billingKey: 'bk', scheduledPlanId: null, version: 0, currency: 'KRW', createdAt: new Date('2024-01-01T00:00:00Z') } as Subscription);

async function env(providerName: 'toss' | 'portone') {
  const repo = new InMemoryRepo(); const ledger = new InMemoryLedger(new SequentialIdGen('l_'));
  const notifier = new CollectingNotifier(); const policy = resolvePolicy(); const provider = new Fake(providerName);
  await repo.plans.put(plan);
  await repo.customers.put({ id: 'c1', email: null, providerRefs: [{ provider: providerName, ref: 'c1' }], status: 'active', createdAt: new Date('2024-01-01T00:00:00Z') } as any);
  await repo.subscriptions.put(mkSub(providerName));
  const clk = (at: string) => new FixedClock(new Date(at));
  const tick = (at: string) => scheduler.tick({ provider: provider as unknown as PaymentProvider, repo, ledger, policy, clock: clk(at), ids: new SequentialIdGen('i_'), notifier });
  const deps = (at: string) => ({ policy, providers: { [providerName]: provider as unknown as PaymentProvider }, ledger, repo, clock: clk(at), ids: new SequentialIdGen('s_'), notifier });
  return { repo, ledger, notifier, policy, provider, clk, tick, deps };
}

describe('round-4 reconcile over attempt rows', () => {
  it('EC:A46 reconcile opens no case for declined or scheduler-owned attempts and repeats no notice; EC:A38 the tick settles the late success', async () => {
    const t = await env('toss');
    t.provider.nextStatus = 'failed';
    await t.tick('2024-02-01T01:00:00Z'); // declined attempt row
    t.provider.nextStatus = 'pending';
    const clk = t.clk('2024-02-02T02:00:00Z');
    for (const item of await dunning.retryDue({ repo: t.repo, clock: clk })) await dunning.runRetry({ item, provider: t.provider as unknown as PaymentProvider, repo: t.repo, ledger: t.ledger, policy: t.policy, notifier: t.notifier, clock: clk });
    t.provider.settle('dunning-retry:sub_1:2024-02-01T00:00:00.000Z:1', 'succeeded'); // the retry did take the money
    const s = (await t.repo.subscriptions.get('sub_1'))!;
    await dunning.onGraceExpired({ sub: s, policy: t.policy, ledger: t.ledger, repo: t.repo, notifier: t.notifier, clock: t.clk('2024-02-09T00:00:00Z') });
    const noticesBefore = t.notifier.sent.length;
    const cases = await recoverMissingGrants({ ...t.deps('2024-02-10T00:00:00Z'), grants: { topup, grantForPeriod } } as never);
    const again = await recoverMissingGrants({ ...t.deps('2024-02-11T00:00:00Z'), grants: { topup, grantForPeriod } } as never);
    expect(cases).toEqual([]);
    expect(again).toEqual([]);
    expect(await t.repo.csCases.list()).toEqual([]);
    expect(t.notifier.sent.length).toBe(noticesBefore);
    const r = await t.tick('2024-02-10T01:00:00Z');
    expect(r.errors).toEqual([]);
    expect((await t.repo.payments.list()).map((p) => p.status).sort()).toEqual(['failed', 'succeeded']);
    expect((await t.ledger.balance('c1', undefined, new Date('2024-02-10T02:00:00Z'))).available).toBe(100);
    expect(t.notifier.sent.filter((n) => (n.payload as { kind?: string }).kind === 'renewal_settled_after_end')).toHaveLength(1);
  });
});
