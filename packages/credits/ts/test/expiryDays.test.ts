// EC:B19 per-source default expiry — spec: packages/credits/spec/credits.pseudo.md
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, FixedClock, InMemoryLedger, SequentialIdGen, resolvePolicy } from 'boilpayment-core';
import { defaultExpiry, grantPromo, grantTrial, manualGrant } from '../src/grant.js';

const NOW = new Date('2026-05-15T00:00:00Z');
const DAY = 86_400_000;
const policy = resolvePolicy({ credits: { expiryDays: { promo: 30, trial: 14, manual: 90, regrant: 365 } } });
function harness() {
  const clock = new FixedClock(NOW);
  return { clock, ledger: new InMemoryLedger(new SequentialIdGen('x_'), clock) };
}

describe('EC:B19 credits.expiryDays', () => {
  it('defaults are null: every source keeps today\'s "never" behaviour', () => {
    for (const s of ['promo', 'trial', 'manual', 'regrant'] as const) expect(defaultExpiry(DEFAULT_POLICY, s, NOW)).toBeNull();
  });

  it('promo / trial / manual grants take the source default when the caller passes policy and no expiresAt', async () => {
    const { clock, ledger } = harness();
    const p = await grantPromo({ customerId: 'c', amount: 10, ledger, clock, idempotencyKey: 'p', policy });
    const t = await grantTrial({ customerId: 'c', amount: 10, ledger, clock, idempotencyKey: 't', policy });
    const m = await manualGrant({ customerId: 'c', pool: 'paid', amount: 10, reason: 'goodwill', actor: 'ops', ledger, clock, idempotencyKey: 'm', policy });
    expect(p.entry!.expiresAt).toEqual(new Date(+NOW + 30 * DAY));
    expect(t.entry!.expiresAt).toEqual(new Date(+NOW + 14 * DAY));
    expect(m.entry!.expiresAt).toEqual(new Date(+NOW + 90 * DAY));
  });

  it('an explicit expiresAt wins, and without policy nothing changes', async () => {
    const { clock, ledger } = harness();
    const explicit = new Date(+NOW + DAY);
    const a = await grantPromo({ customerId: 'c', amount: 10, ledger, clock, idempotencyKey: 'a', policy, expiresAt: explicit });
    const b = await grantPromo({ customerId: 'c', amount: 10, ledger, clock, idempotencyKey: 'b' });
    expect(a.entry!.expiresAt).toEqual(explicit);
    expect(b.entry!.expiresAt).toBeNull();
  });

  it('expired source defaults drop out of the balance (expiring_first still applies)', async () => {
    const { clock, ledger } = harness();
    await grantPromo({ customerId: 'c', amount: 10, ledger, clock, idempotencyKey: 'p', policy });
    await manualGrant({ customerId: 'c', pool: 'promo', amount: 5, reason: 'r', actor: 'ops', ledger, clock, idempotencyKey: 'm', policy });
    clock.advance(31 * DAY);
    expect((await ledger.balance('c', 'promo', clock.now())).available).toBe(5);
  });

  it('rejects zero or negative days', () => {
    expect(() => resolvePolicy({ credits: { expiryDays: { promo: 0 } } })).toThrow(/credits.expiryDays.promo/);
  });
});
