// [EC:B20] Idempotency keys are scoped to the customer. Another customer reusing a key is a new
// operation: it is charged and never receives the first customer's ledger rows.
import { describe, expect, it } from 'vitest';
import { InMemoryLedger, SequentialIdGen } from '../src/index.js';

const grant = (customerId: string, key: string) => ({
  customerId, pool: 'paid' as const, kind: 'grant' as const, amount: 100, unitPriceMinor: null, currency: null,
  expiresAt: null, source: 'manual' as const, reference: {}, idempotencyKey: key, actor: 'test', reason: null,
});

const consume = (customerId: string, amount: number, now: Date) => ({
  customerId, poolOrder: ['paid' as const], amount, idempotencyKey: 'req-1', meta: {}, now, negativeBalance: 'block' as const, negativeFloor: 0,
});

describe('[EC:B20] idempotency keys per customer (in-memory ledger)', () => {
  it('[EC:B20] B reusing A\'s consume key is charged and sees none of A\'s rows', async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const now = new Date('2026-09-27T00:00:00Z');
    await ledger.append(grant('A', 'g-A'));
    await ledger.append(grant('B', 'g-B'));
    await ledger.consume(consume('A', 30, now));
    const b = await ledger.consume(consume('B', 50, now));
    expect(b.duplicated ?? false).toBe(false);
    expect(b.entries.every((e) => e.customerId === 'B')).toBe(true);
    expect((await ledger.balance('A', undefined, now)).available).toBe(70);
    expect((await ledger.balance('B', undefined, now)).available).toBe(50);
  });

  it('[EC:B20] append with another customer\'s key writes a new row for that customer', async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const a = await ledger.append(grant('A', 'same'));
    const b = await ledger.append(grant('B', 'same'));
    expect([b.duplicated, b.entry.customerId, b.entry.id !== a.entry.id]).toEqual([false, 'B', true]);
  });

  it('[EC:B20] the same customer repeating a key is still a duplicate (EC:B12)', async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const a = await ledger.append(grant('A', 'k'));
    const again = await ledger.append(grant('A', 'k'));
    expect([again.duplicated, again.entry.id]).toEqual([true, a.entry.id]);
  });
});
