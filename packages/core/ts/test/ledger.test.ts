// Regression tests for InMemoryLedger.consume/append/balance.
// spec: packages/core/spec/core.pseudo.md [EC:B3] [EC:B4] [EC:B5] [EC:B12] [EC:B14]
import { describe, expect, it } from 'vitest';
import { InMemoryLedger } from '../src/memory.js';
import { FixedClock, SequentialIdGen } from '../src/clock.js';
import { ConsumeInput, NewLedgerEntry } from '../src/types.js';

function mkGrant(overrides: Partial<NewLedgerEntry> & { customerId: string; pool: NewLedgerEntry['pool']; amount: number; idempotencyKey: string }): NewLedgerEntry {
  return {
    kind: 'grant',
    unitPriceMinor: null,
    currency: null,
    expiresAt: null,
    source: 'subscription',
    reference: {},
    actor: 'system',
    reason: null,
    ...overrides,
  };
}

function mkConsume(overrides: Partial<ConsumeInput> & { customerId: string; poolOrder: ConsumeInput['poolOrder']; amount: number; idempotencyKey: string; now: Date }): ConsumeInput {
  return {
    meta: {},
    negativeBalance: 'block',
    negativeFloor: 0,
    ...overrides,
  };
}

const NOW = new Date('2026-01-01T00:00:00.000Z');

describe('EC:B3 consume order — poolOrder is drained in the given sequence, expiring-first within a pool', () => {
  it('EC:B3 poolOrder=[paid,promo,trial] (expiring_first mapping) drains paid then promo', async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    await ledger.append(mkGrant({ customerId: 'c1', pool: 'paid', amount: 10, idempotencyKey: 'g_paid' }));
    await ledger.append(mkGrant({ customerId: 'c1', pool: 'promo', amount: 10, idempotencyKey: 'g_promo' }));
    await ledger.append(mkGrant({ customerId: 'c1', pool: 'trial', amount: 10, idempotencyKey: 'g_trial' }));

    const res = await ledger.consume(mkConsume({ customerId: 'c1', poolOrder: ['paid', 'promo', 'trial'], amount: 15, idempotencyKey: 'k1', now: NOW }));
    expect(res.ok).toBe(true);
    expect(res.entries.map((e) => [e.pool, e.amount])).toEqual([
      ['paid', -10],
      ['promo', -5],
    ]);
  });

  it('EC:B3 poolOrder=[promo,trial,paid] (promo_first_then_expiring mapping) drains promo then trial', async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    await ledger.append(mkGrant({ customerId: 'c1', pool: 'paid', amount: 10, idempotencyKey: 'g_paid' }));
    await ledger.append(mkGrant({ customerId: 'c1', pool: 'promo', amount: 10, idempotencyKey: 'g_promo' }));
    await ledger.append(mkGrant({ customerId: 'c1', pool: 'trial', amount: 10, idempotencyKey: 'g_trial' }));

    const res = await ledger.consume(mkConsume({ customerId: 'c1', poolOrder: ['promo', 'trial', 'paid'], amount: 15, idempotencyKey: 'k1', now: NOW }));
    expect(res.ok).toBe(true);
    expect(res.entries.map((e) => [e.pool, e.amount])).toEqual([
      ['promo', -10],
      ['trial', -5],
    ]);
  });

  it('EC:B3 poolOrder=[paid,trial,promo] (paid_first mapping) drains paid then trial', async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    await ledger.append(mkGrant({ customerId: 'c1', pool: 'paid', amount: 10, idempotencyKey: 'g_paid' }));
    await ledger.append(mkGrant({ customerId: 'c1', pool: 'promo', amount: 10, idempotencyKey: 'g_promo' }));
    await ledger.append(mkGrant({ customerId: 'c1', pool: 'trial', amount: 10, idempotencyKey: 'g_trial' }));

    const res = await ledger.consume(mkConsume({ customerId: 'c1', poolOrder: ['paid', 'trial', 'promo'], amount: 15, idempotencyKey: 'k1', now: NOW }));
    expect(res.ok).toBe(true);
    expect(res.entries.map((e) => [e.pool, e.amount])).toEqual([
      ['paid', -10],
      ['trial', -5],
    ]);
  });

  it('EC:B3 within a pool, buckets drain soonest-expiry-first, null-expiry last', async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const soon = new Date('2026-01-10T00:00:00.000Z');
    const later = new Date('2026-01-20T00:00:00.000Z');
    await ledger.append(mkGrant({ customerId: 'c1', pool: 'paid', amount: 5, idempotencyKey: 'g_null', expiresAt: null }));
    await ledger.append(mkGrant({ customerId: 'c1', pool: 'paid', amount: 5, idempotencyKey: 'g_later', expiresAt: later }));
    await ledger.append(mkGrant({ customerId: 'c1', pool: 'paid', amount: 5, idempotencyKey: 'g_soon', expiresAt: soon }));

    const res = await ledger.consume(mkConsume({ customerId: 'c1', poolOrder: ['paid'], amount: 12, idempotencyKey: 'k1', now: NOW }));
    expect(res.ok).toBe(true);
    // soon (5) -> later (5) -> null (2)
    expect(res.entries.map((e) => e.amount)).toEqual([-5, -5, -2]);
  });
});

describe('EC:B14 expiry filter at consume/balance time', () => {
  it('[SB-07] linked grace expiry extends a dated grant but never converts a null expiry', async () => {
    const clock = new FixedClock(NOW);
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'), clock);
    const dated = (await ledger.append(mkGrant({
      customerId: 'c1', pool: 'paid', amount: 10, idempotencyKey: 'g_dated',
      expiresAt: new Date('2025-12-31T00:00:00.000Z'),
    }))).entry;
    const unbounded = (await ledger.append(mkGrant({
      customerId: 'c1', pool: 'paid', amount: 5, idempotencyKey: 'g_unbounded', expiresAt: null,
    }))).entry;
    const graceUntil = new Date('2026-01-08T00:00:00.000Z');
    for (const grant of [dated, unbounded]) {
      await ledger.append({
        customerId: 'c1', pool: 'paid', kind: 'adjust', amount: 0, unitPriceMinor: null,
        currency: null, expiresAt: graceUntil, source: 'subscription', reference: { grantId: grant.id },
        idempotencyKey: `extend:${grant.id}`, actor: 'system', reason: 'SB-07 grace_expiry_extension',
      });
    }
    await ledger.append({
      customerId: 'c1', pool: 'paid', kind: 'adjust', amount: 0, unitPriceMinor: null,
      currency: null, expiresAt: new Date('2026-01-04T00:00:00.000Z'), source: 'subscription',
      reference: { grantId: unbounded.id }, idempotencyKey: `end:${unbounded.id}`,
      actor: 'system', reason: 'SB-08 grace_expiry_end',
    });

    const balance = await ledger.balance('c1', 'paid', NOW);
    expect(balance.available).toBe(15);
    expect(balance.expiring).toEqual([{ expiresAt: graceUntil, amount: 10 }]);
  });

  it('[SB-08] the first grace-end marker caps an extension without shortening the original expiry', async () => {
    const clock = new FixedClock(NOW);
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'), clock);
    const originalExpiry = new Date('2026-01-02T00:00:00.000Z');
    const grant = (await ledger.append(mkGrant({
      customerId: 'c1', pool: 'paid', amount: 10, idempotencyKey: 'g_recovered', expiresAt: originalExpiry,
    }))).entry;
    const graceUntil = new Date('2026-01-08T00:00:00.000Z');
    const recoveredAt = new Date('2026-01-04T00:00:00.000Z');
    const duplicateAt = new Date('2026-01-05T00:00:00.000Z');
    for (const [reason, expiresAt, suffix] of [
      ['SB-07 grace_expiry_extension', graceUntil, 'extension'],
      ['SB-08 grace_expiry_end', recoveredAt, 'first-end'],
      ['SB-08 grace_expiry_end', duplicateAt, 'duplicate-end'],
    ] as const) {
      await ledger.append({
        customerId: 'c1', pool: 'paid', kind: 'adjust', amount: 0, unitPriceMinor: null,
        currency: null, expiresAt, source: 'subscription', reference: { grantId: grant.id },
        idempotencyKey: `${suffix}:${grant.id}`, actor: 'system', reason,
      });
    }

    expect((await ledger.balance('c1', 'paid', new Date('2026-01-03T00:00:00.000Z'))).available).toBe(10);
    expect((await ledger.balance('c1', 'paid', recoveredAt)).available).toBe(0);
  });

  it('EC:B14 a grant whose expiresAt <= now is excluded from consume even though the batch has not run', async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const past = new Date('2025-12-31T00:00:00.000Z'); // before NOW
    await ledger.append(mkGrant({ customerId: 'c1', pool: 'paid', amount: 10, idempotencyKey: 'g_expired', expiresAt: past }));
    await ledger.append(mkGrant({ customerId: 'c1', pool: 'paid', amount: 5, idempotencyKey: 'g_live', expiresAt: null }));

    const res = await ledger.consume(mkConsume({ customerId: 'c1', poolOrder: ['paid'], amount: 5, idempotencyKey: 'k1', now: NOW }));
    expect(res.ok).toBe(true);
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0].reference.grantId).toBe((await ledger.entries('c1')).find((e) => e.idempotencyKey === 'g_live')!.id);

    const insufficient = await ledger.consume(mkConsume({ customerId: 'c1', poolOrder: ['paid'], amount: 1, idempotencyKey: 'k2', now: NOW }));
    expect(insufficient.ok).toBe(false); // the expired 10 is not usable, only 0 remain after k1
  });

  it('EC:B14 balance() excludes expired buckets from available and expiring', async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const past = new Date('2025-12-31T00:00:00.000Z');
    await ledger.append(mkGrant({ customerId: 'c1', pool: 'paid', amount: 10, idempotencyKey: 'g_expired', expiresAt: past }));
    await ledger.append(mkGrant({ customerId: 'c1', pool: 'paid', amount: 5, idempotencyKey: 'g_live', expiresAt: null }));

    const bal = await ledger.balance('c1', undefined, NOW);
    expect(bal.available).toBe(5);
    expect(bal.expiring).toEqual([]);
  });
});

describe('EC:B4 negative balance policy', () => {
  it("EC:B4 negativeBalance='block' rejects the whole request atomically, no entries written", async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    await ledger.append(mkGrant({ customerId: 'c1', pool: 'paid', amount: 10, idempotencyKey: 'g1' }));
    const res = await ledger.consume(mkConsume({ customerId: 'c1', poolOrder: ['paid'], amount: 15, idempotencyKey: 'k1', now: NOW, negativeBalance: 'block' }));
    expect(res.ok).toBe(false);
    expect(res.shortfall).toBe(5);
    expect(res.entries).toEqual([]);
    const bal = await ledger.balance('c1', undefined, NOW);
    expect(bal.available).toBe(10); // untouched
  });

  it("EC:B4 negativeBalance='allow_to_floor' allows down to the floor, rejects entirely if the request would cross it", async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    await ledger.append(mkGrant({ customerId: 'c1', pool: 'paid', amount: 10, idempotencyKey: 'g1' }));

    // room to floor(-5) after draining the 10 available bucket is 5 (10 - (-5))... but bucket itself
    // is drawn first; requesting 15 leaves remaining=5 after bucket, floor=-5 gives room=10-(-5)=15,
    // so this succeeds with an unbucketed overflow draw of 5.
    const res = await ledger.consume(
      mkConsume({ customerId: 'c1', poolOrder: ['paid'], amount: 15, idempotencyKey: 'k1', now: NOW, negativeBalance: 'allow_to_floor', negativeFloor: -5 }),
    );
    expect(res.ok).toBe(true);
    expect(res.entries.map((e) => [e.pool, e.amount, e.reference.grantId ?? null])).toEqual([
      ['paid', -10, expect.any(String)],
      ['paid', -5, null],
    ]);
    const bal = await ledger.balance('c1', undefined, NOW);
    expect(bal.available).toBe(-5);

    // now at floor: any further consume must be rejected entirely (no partial fulfillment)
    const res2 = await ledger.consume(
      mkConsume({ customerId: 'c1', poolOrder: ['paid'], amount: 1, idempotencyKey: 'k2', now: NOW, negativeBalance: 'allow_to_floor', negativeFloor: -5 }),
    );
    expect(res2.ok).toBe(false);
    expect(res2.shortfall).toBe(1);
  });

  it("EC:B4 negativeBalance='allow_unbounded' always succeeds, driving balance arbitrarily negative", async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    await ledger.append(mkGrant({ customerId: 'c1', pool: 'paid', amount: 10, idempotencyKey: 'g1' }));
    const res = await ledger.consume(
      mkConsume({ customerId: 'c1', poolOrder: ['paid'], amount: 1000, idempotencyKey: 'k1', now: NOW, negativeBalance: 'allow_unbounded' }),
    );
    expect(res.ok).toBe(true);
    expect(res.shortfall).toBe(0);
    const bal = await ledger.balance('c1', undefined, NOW);
    expect(bal.available).toBe(10 - 1000);
  });
});

describe('EC:B12 idempotency', () => {
  it('EC:B12 append() with a re-used idempotencyKey is a no-op, returns the original row', async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const first = await ledger.append(mkGrant({ customerId: 'c1', pool: 'paid', amount: 10, idempotencyKey: 'dup' }));
    expect(first.duplicated).toBe(false);
    const second = await ledger.append(mkGrant({ customerId: 'c1', pool: 'paid', amount: 999, idempotencyKey: 'dup' }));
    expect(second.duplicated).toBe(true);
    expect(second.entry).toEqual(first.entry); // amount from the first call, not 999
    const bal = await ledger.balance('c1', undefined, NOW);
    expect(bal.available).toBe(10);
  });

  it('EC:B12 consume() with a re-used idempotencyKey is cached and does not double-consume', async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    await ledger.append(mkGrant({ customerId: 'c1', pool: 'paid', amount: 10, idempotencyKey: 'g1' }));
    const first = await ledger.consume(mkConsume({ customerId: 'c1', poolOrder: ['paid'], amount: 4, idempotencyKey: 'req-1', now: NOW }));
    expect(first.duplicated).toBe(false);
    const second = await ledger.consume(mkConsume({ customerId: 'c1', poolOrder: ['paid'], amount: 4, idempotencyKey: 'req-1', now: NOW }));
    expect(second.duplicated).toBe(true);
    expect(second.ok).toBe(first.ok);
    expect(second.entries).toHaveLength(first.entries.length);
    const bal = await ledger.balance('c1', undefined, NOW);
    expect(bal.available).toBe(6); // only consumed once
  });
});

describe('holds', () => {
  it('a hold entry reduces available and is reported separately as held; release restores available', async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    await ledger.append(mkGrant({ customerId: 'c1', pool: 'paid', amount: 100, idempotencyKey: 'g1' }));

    await ledger.append({
      customerId: 'c1', pool: 'paid', kind: 'hold', amount: -20, unitPriceMinor: null, currency: null,
      expiresAt: null, source: 'refund', reference: {}, idempotencyKey: 'hold_1', actor: 'system', reason: 'refund_pending',
    });
    let bal = await ledger.balance('c1', undefined, NOW);
    expect(bal.available).toBe(80);
    expect(bal.held).toBe(20);

    await ledger.append({
      customerId: 'c1', pool: 'paid', kind: 'release', amount: 20, unitPriceMinor: null, currency: null,
      expiresAt: null, source: 'refund', reference: {}, idempotencyKey: 'release_1', actor: 'system', reason: 'refund_failed',
    });
    bal = await ledger.balance('c1', undefined, NOW);
    expect(bal.available).toBe(100);
    expect(bal.held).toBeCloseTo(0, 10); // InMemoryLedger's -total can be -0 after a full release
  });
});

// EC:I9 finding (2026-09-09) — append()'s createdAt used to always be wall-clock time, ignoring
// the injected Clock (found 3x independently: refund.evaluate FINDINGS#1, a dispute regression
// test, cs.timeline). Fixed by an optional clock param on the constructor.
describe('InMemoryLedger — injected clock', () => {
  it('append() stamps createdAt from the injected FixedClock, not wall-clock time', async () => {
    const fixed = new FixedClock(new Date('2020-01-01T00:00:00.000Z'));
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'), fixed);
    const { entry } = await ledger.append(mkGrant({ customerId: 'c1', pool: 'paid', amount: 10, idempotencyKey: 'g_clock_1' }));
    expect(entry.createdAt.toISOString()).toBe('2020-01-01T00:00:00.000Z');

    fixed.advance(60_000);
    const { entry: entry2 } = await ledger.append(mkGrant({ customerId: 'c1', pool: 'paid', amount: 5, idempotencyKey: 'g_clock_2' }));
    expect(entry2.createdAt.toISOString()).toBe('2020-01-01T00:01:00.000Z');
  });

  it('balance() honors the injected clock (now is a required param) for expiry filtering, not wall-clock time', async () => {
    const fixed = new FixedClock(new Date('2020-01-01T00:00:00.000Z'));
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'), fixed);
    await ledger.append({
      customerId: 'c1', pool: 'paid', kind: 'grant', amount: 10, unitPriceMinor: null, currency: null,
      expiresAt: new Date('2020-01-01T00:00:30.000Z'), source: 'subscription', reference: {}, idempotencyKey: 'g_exp_1', actor: 'system', reason: null,
    });
    // Not yet expired per the fixed clock (still at 00:00:00).
    expect((await ledger.balance('c1', undefined, fixed.now())).available).toBe(10);
    fixed.advance(60_000); // now 00:01:00 — past the grant's 00:00:30 expiry
    expect((await ledger.balance('c1', undefined, fixed.now())).available).toBe(0);
  });

  it('defaults to SystemClock (wall-clock) when no clock is passed — existing call sites unaffected', async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const before = Date.now();
    const { entry } = await ledger.append(mkGrant({ customerId: 'c1', pool: 'paid', amount: 10, idempotencyKey: 'g_default_clock' }));
    const after = Date.now();
    expect(entry.createdAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(entry.createdAt.getTime()).toBeLessThanOrEqual(after);
  });
});

describe('EC:L5 InMemoryLedger.consume — reference passthrough', () => {
  it('EC:L5 keeps every caller-supplied reference field (a whitelist here silently dropped correlationId)', async () => {
    const ids = new SequentialIdGen('l_');
    const clock = new FixedClock(new Date('2026-01-01T00:00:00Z'));
    const ledger = new InMemoryLedger(ids, clock);
    await ledger.append({
      customerId: 'c', pool: 'paid', kind: 'grant', amount: 100, unitPriceMinor: 1, currency: 'USD',
      expiresAt: null, source: 'topup', reference: {}, idempotencyKey: 'g1', actor: 'system', reason: null,
    });
    const res = await ledger.consume({
      customerId: 'c', poolOrder: ['paid'], amount: 10, idempotencyKey: 'c1',
      meta: { correlationId: 'corr_abc', paymentId: 'p1', caseId: 'case_1' },
      now: clock.now(), negativeBalance: 'block', negativeFloor: 0,
    });
    const ref = res.entries[0].reference;
    expect(ref.correlationId).toBe('corr_abc');
    expect(ref.paymentId).toBe('p1');
    expect(ref.caseId).toBe('case_1');
    expect(ref.grantId).toBeDefined(); // consume() owns this one
  });
});
