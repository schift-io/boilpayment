// Round-7 audit A7-8 (EC:I11): every notification the kit itself sends renders with no `{placeholder}`
// left, in both locales. The payloads come from the real senders (scheduler decline, dunning retries,
// grace expiry, an unanswered charge, credits expiry, a CS escalation), not from hand-written fixtures.
import { describe, expect, it } from 'vitest';
import { CollectingNotifier, FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen, resolvePolicy } from 'boilpayment-sdk/core';
import type { Money, Payment, PaymentProvider, PaymentStatus, Plan, Subscription } from 'boilpayment-sdk/core';
import { dunning, scheduler } from 'boilpayment-sdk/lifecycle';
import { notifyExpiring } from 'boilpayment-sdk/credits';
import { escalate, openCase } from 'boilpayment-sdk/cs';
import { renderNotification } from 'boilpayment-sdk/notify';

class Fake {
  readonly name = 'toss' as const;
  nextStatus: PaymentStatus = 'failed';
  throwNext = false;
  capabilities() { return { nativeSubscriptions: false, partialRefund: true, meters: false, scheduling: 'self' as const, webhookSignature: true }; }
  async chargeBillingKey(i: { amount: Money; orderId: string; customerRef: string }): Promise<Payment> {
    if (this.throwNext) { this.throwNext = false; throw new Error('socket hang up'); }
    return { id: 'x', customerId: i.customerRef, provider: 'toss', providerRef: 'pk_' + i.orderId, subscriptionId: null, amount: i.amount, status: this.nextStatus,
      kind: 'subscription', period: null, occurredAt: new Date('2024-02-01T01:00:00Z'), cashReceipt: null,
      failure: this.nextStatus === 'failed' ? { code: 'card_declined', providerCode: null, retryable: true, userMessage: 'd' } : null };
  }
}

const plan: Plan = { id: 'basic', name: 'Basic', interval: 'month', creditsPerPeriod: 100, usageIncluded: 0, trialDays: 0,
  prices: [{ currency: 'KRW', amountMinor: 5000, providerPriceRefs: {} }] };
const sub = (id: string): Subscription => ({ id, customerId: 'c1', planId: 'basic', provider: 'toss', providerRef: null, status: 'active',
  currentPeriod: { start: new Date('2024-01-01T00:00:00Z'), end: new Date('2024-02-01T00:00:00Z') }, anchorDay: 1, cancelAtPeriodEnd: false,
  graceUntil: null, billingKey: 'bk', scheduledPlanId: null, version: 0, currency: 'KRW', createdAt: new Date('2024-01-01T00:00:00Z') } as Subscription);

describe('round-7 notification payloads', () => {
  it('EC:I11 every notification a real flow sends renders without a placeholder, en and ko', async () => {
    const repo = new InMemoryRepo(); const ledger = new InMemoryLedger(new SequentialIdGen('l_'));
    const notifier = new CollectingNotifier(); const policy = resolvePolicy(); const provider = new Fake();
    const p = provider as unknown as PaymentProvider;
    const clk = (at: string) => new FixedClock(new Date(at));
    await repo.plans.put(plan);
    await repo.customers.put({ id: 'c1', email: null, providerRefs: [], status: 'active', createdAt: new Date('2024-01-01T00:00:00Z') } as any);
    await repo.subscriptions.put(sub('sub_1'));
    await repo.subscriptions.put(sub('sub_2'));

    // sub_2: the charge gets no answer -> cs.needs_human (renewal_charge_unresolved)
    provider.throwNext = true;
    await repo.subscriptions.put({ ...(await repo.subscriptions.get('sub_1'))!, cancelAtPeriodEnd: true }); // sub_2 goes first
    await scheduler.tick({ provider: p, repo, ledger, policy, clock: clk('2024-02-01T01:00:00Z'), ids: new SequentialIdGen('a_'), notifier });
    await repo.subscriptions.put({ ...(await repo.subscriptions.get('sub_1'))!, cancelAtPeriodEnd: false });
    // sub_1: declined -> payment.failed + grace.started; every retry declined -> payment.failed (attempt) + grace.ending
    await scheduler.tick({ provider: p, repo, ledger, policy, clock: clk('2024-02-01T02:00:00Z'), ids: new SequentialIdGen('b_'), notifier });
    for (const at of ['2024-02-02T03:00:00Z', '2024-02-05T04:00:00Z', '2024-02-07T05:00:00Z']) {
      for (const item of await dunning.retryDue({ repo, clock: clk(at) })) {
        await dunning.runRetry({ item, provider: p, repo, ledger, policy, notifier, clock: clk(at) });
      }
    }
    // grace ends -> grace.ending
    const s1 = (await repo.subscriptions.get('sub_1'))!;
    await dunning.onGraceExpired({ sub: s1, policy, ledger, repo, notifier, clock: clk('2024-02-09T00:00:00Z') });
    // credits about to expire -> credits.expiring
    await ledger.append({ customerId: 'c1', pool: 'paid', kind: 'grant', amount: 50, source: 'topup', reference: {}, idempotencyKey: 'g1',
      actor: 'system', reason: null, unitPriceMinor: null, currency: null, expiresAt: new Date('2024-02-12T00:00:00Z') });
    await notifyExpiring({ ledger, repo, notifier, policy: resolvePolicy({ credits: { expiryNoticeDays: 7 } } as any), clock: clk('2024-02-10T00:00:00Z') });
    // a CS case escalated -> cs.needs_human
    const c = await openCase({ customerId: 'c1', kind: 'refund', referenceId: 'pay_1', policy, repo, clock: clk('2024-02-10T00:00:00Z'), ids: new SequentialIdGen('c_') });
    await escalate({ case: c, repo, clock: clk('2024-02-10T00:00:00Z'), notifier, reason: 'over the auto-approve limit' });

    const types = new Set(notifier.sent.map((n) => n.type));
    expect([...types].sort()).toEqual(['credits.expiring', 'cs.needs_human', 'grace.ending', 'grace.started', 'payment.failed']);
    expect(notifier.sent.filter((n) => n.type === 'payment.failed').length).toBeGreaterThan(1); // the decline and the retries
    for (const n of notifier.sent) {
      for (const locale of ['en', 'ko'] as const) {
        const out = renderNotification(n, locale);
        expect(`${out.subject} ${out.text}`, `${n.type} ${locale}: ${JSON.stringify(n.payload)}`).not.toMatch(/\{\w+\}/);
      }
    }
  });
});
