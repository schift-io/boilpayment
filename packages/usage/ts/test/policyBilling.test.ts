import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen } from '@schift/payment-kit-core';
import { check, closePeriod, record, resettlePeriod } from '../src/index.js';
import { mkSub } from './fixtures.js';

describe('configured usage billing rules', () => {
  it('uses promotional credits first when configured by the seller', async () => {
    // Given two funded pools and a promotional-first rule.
    const ids = new SequentialIdGen('policy_');
    const clock = new FixedClock(new Date('2026-05-20T00:00:00Z'));
    const repo = new InMemoryRepo();
    const ledger = new InMemoryLedger(ids);
    const sub = mkSub();
    const policy = { ...DEFAULT_POLICY, credits: { ...DEFAULT_POLICY.credits, consumeOrder: 'promo_first_then_expiring' as const }, usage: { ...DEFAULT_POLICY.usage, creditConversion: { unit: 'call', creditsPerUnit: 10 } } };
    for (const pool of ['paid', 'promo'] as const) {
      await ledger.append({ customerId: sub.customerId, pool, kind: 'grant', amount: 50, unitPriceMinor: null, currency: null, expiresAt: null, source: 'promo', reference: {}, idempotencyKey: pool, actor: 'test', reason: null });
    }
    // When a customer uses three units.
    const result = await check({ customerId: sub.customerId, meter: 'call', quantity: 3, sub, policy, repo, ledger, clock, idempotencyKey: 'usage' });
    // Then paid credits remain untouched.
    expect(result.allow).toBe(true);
    expect((await ledger.balance(sub.customerId, 'paid', clock.now())).available).toBe(50);
    expect((await ledger.balance(sub.customerId, 'promo', clock.now())).available).toBe(20);
  });

  it.each(['close', 'resettle'] as const)('%s refuses to invent a billing currency', async (operation) => {
    // Given billable usage without a plan or selected billing currency.
    const ids = new SequentialIdGen('currency_');
    const clock = new FixedClock(new Date('2026-05-20T00:00:00Z'));
    const repo = new InMemoryRepo();
    const sub = mkSub();
    const policy = { ...DEFAULT_POLICY, usage: { ...DEFAULT_POLICY.usage, includedQuantity: 0, overage: 'bill_overage' as const, overageUnitPriceMinor: 250 } };
    await record({ event: { customerId: sub.customerId, meter: 'call', quantity: 3, occurredAt: clock.now(), idempotencyKey: 'usage' }, sub, policy, repo, clock, ids });
    // When the usage is settled, then the missing rule is explicit.
    const result = operation === 'close'
      ? closePeriod({ sub, policy, repo, clock, ids })
      : resettlePeriod({ sub, periodStart: sub.currentPeriod.start, policy, repo, clock, settledTotal: 0 });
    await expect(result).rejects.toMatchObject({ code: 'billing_currency_required' });
  });
});
