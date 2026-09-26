// spec: packages/credits/spec/credits.pseudo.md [EC:B14]
import { describe, expect, it } from 'vitest';
import { FixedClock, InMemoryLedger, SequentialIdGen } from '@schift/payment-kit-core';
import { expireDue } from '../src/index.js';

describe('EC:B14 expireDue — bookkeeping only, neutral to balance', () => {
  it('writing expire rows for due grants does not change balance() before or after', async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const clock = new FixedClock(new Date('2024-01-01T00:00:00.000Z'));
    const expiresAt = new Date('2024-01-15T00:00:00.000Z');
    await ledger.append({
      customerId: 'cust_1', pool: 'paid', kind: 'grant', amount: 100, unitPriceMinor: null, currency: null,
      expiresAt, source: 'subscription', reference: {}, idempotencyKey: 'g1', actor: 'system', reason: null,
    });
    await ledger.consume({
      customerId: 'cust_1', poolOrder: ['paid'], amount: 40, idempotencyKey: 'consume_1',
      meta: {}, now: clock.now(), negativeBalance: 'block', negativeFloor: 0,
    }); // 60 remaining on the grant

    clock.advance(20 * 86_400_000); // past expiresAt — balance() already excludes this bucket
    const balBefore = await ledger.balance('cust_1', undefined, clock.now());
    expect(balBefore.available).toBe(0);

    const result = await expireDue({ ledger, clock, customerId: 'cust_1' });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].amount).toBe(-60); // writes off the 60 that was never consumed
    expect(result.entries[0].kind).toBe('expire');

    const balAfter = await ledger.balance('cust_1', undefined, clock.now());
    expect(balAfter.available).toBe(0); // unchanged — expireDue is bookkeeping, not a balance effect
  });

  it('calling expireDue again for the same grant is idempotent — same expire row (expire:{grantId}), no second row written', async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const clock = new FixedClock(new Date('2024-01-01T00:00:00.000Z'));
    await ledger.append({
      customerId: 'cust_1', pool: 'paid', kind: 'grant', amount: 100, unitPriceMinor: null, currency: null,
      expiresAt: new Date('2024-01-15T00:00:00.000Z'), source: 'subscription', reference: {}, idempotencyKey: 'g1', actor: 'system', reason: null,
    });
    clock.advance(20 * 86_400_000);
    const first = await expireDue({ ledger, clock, customerId: 'cust_1' });
    expect(first.entries).toHaveLength(1);
    const second = await expireDue({ ledger, clock, customerId: 'cust_1' });
    // expire:{grantId} is idempotent at the ledger.append level: the second call returns the same
    // (deduplicated) row rather than a fresh one — confirm no second distinct ledger row exists.
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0].id).toBe(first.entries[0].id);
    const allExpireEntries = (await ledger.entries('cust_1')).filter((e) => e.kind === 'expire');
    expect(allExpireEntries).toHaveLength(1);
  });

  it('a fully-consumed grant produces no expire entry (remaining <= 0)', async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const clock = new FixedClock(new Date('2024-01-01T00:00:00.000Z'));
    await ledger.append({
      customerId: 'cust_1', pool: 'paid', kind: 'grant', amount: 100, unitPriceMinor: null, currency: null,
      expiresAt: new Date('2024-01-15T00:00:00.000Z'), source: 'subscription', reference: {}, idempotencyKey: 'g1', actor: 'system', reason: null,
    });
    await ledger.consume({
      customerId: 'cust_1', poolOrder: ['paid'], amount: 100, idempotencyKey: 'consume_1',
      meta: {}, now: clock.now(), negativeBalance: 'block', negativeFloor: 0,
    });
    clock.advance(20 * 86_400_000);
    const res = await expireDue({ ledger, clock, customerId: 'cust_1' });
    expect(res.entries).toHaveLength(0);
  });
});
