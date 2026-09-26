// [EC:B20] usage.record dedupes by (customer, idempotency key): another customer's event with the
// same key is recorded, not answered with the first customer's event.
import { describe, expect, it } from 'vitest';
import { FixedClock, InMemoryRepo, SequentialIdGen } from 'boilpayment-core';
import { record } from '../src/record.js';
import { basePolicy, mkSub } from './fixtures.js';

describe('[EC:B20] usage.record key scope', () => {
  it('[EC:B20] two customers, same key, two events', async () => {
    const ids = new SequentialIdGen('id_');
    const clock = new FixedClock(new Date('2026-05-15T00:00:00Z'));
    const repo = new InMemoryRepo();
    const subA = mkSub({ id: 'sub_A', customerId: 'A' });
    const subB = mkSub({ id: 'sub_B', customerId: 'B' });
    const ev = (customerId: string, quantity: number) => ({ customerId, meter: 'api_call', quantity, occurredAt: clock.now(), idempotencyKey: 'evt-1' });
    await record({ event: ev('A', 3), sub: subA, policy: basePolicy, repo, clock, ids });
    const b = await record({ event: ev('B', 7), sub: subB, policy: basePolicy, repo, clock, ids });
    expect([b.duplicated, b.event.customerId, b.event.quantity]).toEqual([false, 'B', 7]);
  });
});
