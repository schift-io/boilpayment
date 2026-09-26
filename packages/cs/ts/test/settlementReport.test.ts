// EC:I10 monthly settlement report — spec: packages/cs/spec/cs.pseudo.md
import { describe, expect, it } from 'vitest';
import { FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen } from 'boilpayment-core';
import type { Payment, Refund } from 'boilpayment-core';
import { settlementReport } from '../src/settlementReport.js';

const JAN = new Date('2026-01-01T00:00:00Z');
const FEB = new Date('2026-02-01T00:00:00Z');
const pay = (id: string, at: string, amountMinor: number, currency: string, kind: Payment['kind'], status: Payment['status'] = 'succeeded'): Payment => ({
  id, customerId: 'c1', provider: 'stripe', providerRef: `pi_${id}`, subscriptionId: null, amount: { amountMinor, currency },
  status, kind, period: null, occurredAt: new Date(at), failure: null,
});
const refund = (id: string, at: string, amountMinor: number, currency: string, status: Refund['status'] = 'succeeded'): Refund => ({
  id, paymentId: 'p1', customerId: 'c1', amount: { amountMinor, currency }, status, providerRef: `re_${id}`, creditsRevoked: 0,
  ruleId: 'D2', reason: null, failure: null, createdAt: new Date(at),
});

describe('EC:I10 settlementReport', () => {
  it('groups payments, refunds and ledger movements inside [from, to), per currency and per source', async () => {
    const clock = new FixedClock(new Date('2026-01-10T00:00:00Z'));
    const ledger = new InMemoryLedger(new SequentialIdGen('l_'), clock);
    const repo = new InMemoryRepo();
    await repo.customers.put({ id: 'c1', email: null, providerRefs: [], status: 'active', createdAt: clock.now() });
    for (const p of [
      pay('p1', '2026-01-05T00:00:00Z', 1000, 'USD', 'subscription'),
      pay('p2', '2026-01-20T00:00:00Z', 500, 'USD', 'topup'),
      pay('p3', '2026-01-21T00:00:00Z', 9900, 'KRW', 'topup'),
      pay('p4', '2026-01-22T00:00:00Z', 700, 'USD', 'topup', 'failed'),
      pay('p5', '2026-02-01T00:00:00Z', 999, 'USD', 'topup'), // outside (to is exclusive)
    ]) await repo.payments.put(p);
    await repo.refunds.put(refund('r1', '2026-01-25T00:00:00Z', 300, 'USD'));
    await repo.refunds.put(refund('r2', '2026-01-26T00:00:00Z', 100, 'USD', 'failed'));
    await ledger.append({ customerId: 'c1', pool: 'paid', kind: 'grant', amount: 100, unitPriceMinor: 10, currency: 'USD', expiresAt: null, source: 'subscription', reference: {}, idempotencyKey: 'g1', actor: 's', reason: null });
    await ledger.append({ customerId: 'c1', pool: 'paid', kind: 'grant', amount: 50, unitPriceMinor: 10, currency: 'USD', expiresAt: null, source: 'topup', reference: {}, idempotencyKey: 'g2', actor: 's', reason: null });
    await ledger.consume({ customerId: 'c1', poolOrder: ['paid'], amount: 30, idempotencyKey: 'u1', meta: {}, now: clock.now(), negativeBalance: 'block', negativeFloor: 0 });
    clock.advance(40 * 86_400_000); // Feb 19 — outside
    await ledger.append({ customerId: 'c1', pool: 'paid', kind: 'grant', amount: 7, unitPriceMinor: null, currency: null, expiresAt: null, source: 'manual', reference: {}, idempotencyKey: 'g3', actor: 's', reason: 'r' });

    const r = await settlementReport({ repo, ledger, from: JAN, to: FEB });
    expect(r.payments).toEqual([
      { currency: 'KRW', kind: 'topup', status: 'succeeded', count: 1, amountMinor: 9900 },
      { currency: 'USD', kind: 'subscription', status: 'succeeded', count: 1, amountMinor: 1000 },
      { currency: 'USD', kind: 'topup', status: 'failed', count: 1, amountMinor: 700 },
      { currency: 'USD', kind: 'topup', status: 'succeeded', count: 1, amountMinor: 500 },
    ]);
    expect(r.refunds).toEqual([{ currency: 'USD', count: 1, amountMinor: 300 }]);
    expect(r.net).toEqual([{ currency: 'KRW', amountMinor: 9900 }, { currency: 'USD', amountMinor: 1200 }]);
    expect(r.credits).toEqual([
      { kind: 'consume', source: 'usage', count: 1, amount: -30 },
      { kind: 'grant', source: 'subscription', count: 1, amount: 100 },
      { kind: 'grant', source: 'topup', count: 1, amount: 50 },
    ]);
  });

  it('writes nothing and refuses an empty window', async () => {
    const repo = new InMemoryRepo(); const ledger = new InMemoryLedger(new SequentialIdGen('l_'));
    await expect(settlementReport({ repo, ledger, from: FEB, to: JAN })).rejects.toThrow(/from must be before to/);
    const r = await settlementReport({ repo, ledger, from: JAN, to: FEB });
    expect(r).toMatchObject({ payments: [], refunds: [], net: [], credits: [] });
    expect(await repo.payments.list()).toHaveLength(0);
  });
});
