// [EC:B21] In-memory consume: a row key another operation already holds is refused, never answered
// with that other row (which would look like a successful debit that never happened).
import { describe, it, expect } from 'vitest';
import { FixedClock, InMemoryLedger, PaymentKitError, UuidIdGen } from '../src/index.js';

describe('[EC:B21] in-memory consume key collision', () => {
  it('[EC:B21] a grant holding "k#0" makes consume("k") fail instead of returning the grant', async () => {
    const clock = new FixedClock(new Date('2026-01-01T00:00:00Z'));
    const ledger = new InMemoryLedger(new UuidIdGen(), clock);
    const base = { customerId: 'c', pool: 'paid' as const, kind: 'grant' as const, unitPriceMinor: null, currency: null,
      expiresAt: null, source: 'topup' as const, reference: {}, actor: 't', reason: null };
    await ledger.append({ ...base, amount: 100, idempotencyKey: 'g' });
    await ledger.append({ ...base, amount: 5, idempotencyKey: 'k#0' });
    const run = () => ledger.consume({ customerId: 'c', poolOrder: ['paid'], amount: 30, idempotencyKey: 'k', meta: {},
      now: clock.now(), negativeBalance: 'block', negativeFloor: 0 });
    await expect(run()).rejects.toMatchObject({ code: 'idempotency_key_conflict' });
    expect(PaymentKitError).toBeDefined();
    expect((await ledger.balance('c', undefined, clock.now())).available).toBe(105);
  });
});
