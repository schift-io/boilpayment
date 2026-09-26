// EC:C4 — see spec/usage.pseudo.md
import { describe, expect, it } from 'vitest';
import { Customer, DEFAULT_POLICY, FixedClock, InMemoryRepo, SequentialIdGen } from 'boilpayment-core';
import { flushOutbox } from '../src/flushOutbox.js';
import { record } from '../src/record.js';
import { FakeProvider, mkSub } from './fixtures.js';

function harness() {
  const ids = new SequentialIdGen('id_');
  const clock = new FixedClock(new Date('2026-05-01T00:00:00Z'));
  const repo = new InMemoryRepo();
  return { ids, clock, repo };
}

const linkedCustomer: Customer = {
  id: 'cust_1', email: null, providerRefs: [{ provider: 'stripe', ref: 'cus_stripe_1' }], status: 'active',
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

describe('EC:C4 usage.flushOutbox — no_provider_ref is a terminal failure, never retried', () => {
  it('a customer with no providerRefs for this provider fails immediately with error="no_provider_ref" and status="failed"', async () => {
    const { ids, clock, repo } = harness();
    const sub = mkSub();
    const provider = new FakeProvider({ meters: true });
    // customer is NOT registered in repo.customers at all -> customer lookup returns null -> no providerRef
    await record({ event: { customerId: sub.customerId, meter: 'api_call', quantity: 1, occurredAt: clock.now(), idempotencyKey: 'evt_1' }, sub, policy: DEFAULT_POLICY, repo, clock, ids, provider });

    const result = await flushOutbox({ repo, providers: { stripe: provider }, clock });

    expect(result).toEqual({ sent: 0, failed: 1, retried: 0 });
    const [item] = await repo.outbox.list({ kind: 'usage.report' } as never);
    expect(item.status).toBe('failed');
    expect(item.attempts).toBe(1);
    expect((item.payload as { error?: string }).error).toBe('no_provider_ref');
    expect(provider.reportUsageCalls).toHaveLength(0); // never reaches the provider call
  });

  it('a no_provider_ref item stays "failed" across repeated flush calls -- it is never retried', async () => {
    const { ids, clock, repo } = harness();
    const sub = mkSub();
    const provider = new FakeProvider({ meters: true });
    await record({ event: { customerId: sub.customerId, meter: 'api_call', quantity: 1, occurredAt: clock.now(), idempotencyKey: 'evt_1' }, sub, policy: DEFAULT_POLICY, repo, clock, ids, provider });

    await flushOutbox({ repo, providers: { stripe: provider }, clock });
    clock.advance(60 * 60 * 1000); // even after plenty of time passes
    const secondResult = await flushOutbox({ repo, providers: { stripe: provider }, clock });

    expect(secondResult).toEqual({ sent: 0, failed: 0, retried: 0 }); // nothing left to do -- item isn't 'pending' anymore
    const [item] = await repo.outbox.list({ kind: 'usage.report' } as never);
    expect(item.status).toBe('failed');
    expect(item.attempts).toBe(1); // unchanged
  });
});

describe('EC:C4 usage.flushOutbox — success path', () => {
  it('a resolvable providerRef + successful reportUsage call moves the item to "sent" and increments attempts', async () => {
    const { ids, clock, repo } = harness();
    const sub = mkSub();
    const provider = new FakeProvider({ meters: true }); // never fails
    await repo.customers.put(linkedCustomer);
    await record({ event: { customerId: 'cust_1', meter: 'api_call', quantity: 5, occurredAt: clock.now(), idempotencyKey: 'evt_1' }, sub, policy: DEFAULT_POLICY, repo, clock, ids, provider });

    const result = await flushOutbox({ repo, providers: { stripe: provider }, clock });

    expect(result).toEqual({ sent: 1, failed: 0, retried: 0 });
    const [item] = await repo.outbox.list({ kind: 'usage.report' } as never);
    expect(item.status).toBe('sent');
    expect(item.attempts).toBe(1);
    // reportUsage must be called with the PROVIDER-side customerRef, never the internal customerId (see spec caveat)
    expect(provider.reportUsageCalls).toEqual([{ customerRef: 'cus_stripe_1', meter: 'api_call', quantity: 5 }]);
  });

  it('an item whose nextAttemptAt is still in the future is skipped (left pending, no attempt made)', async () => {
    const { ids, clock, repo } = harness();
    const sub = mkSub();
    const provider = new FakeProvider({ meters: true, alwaysFail: true });
    await repo.customers.put(linkedCustomer);
    await record({ event: { customerId: 'cust_1', meter: 'api_call', quantity: 1, occurredAt: clock.now(), idempotencyKey: 'evt_1' }, sub, policy: DEFAULT_POLICY, repo, clock, ids, provider });

    await flushOutbox({ repo, providers: { stripe: provider } , clock }); // 1st attempt fails, backoff = 2min
    const [afterFirst] = await repo.outbox.list({ kind: 'usage.report' } as never);
    expect(afterFirst.attempts).toBe(1);

    const secondResult = await flushOutbox({ repo, providers: { stripe: provider }, clock }); // clock unchanged -- still within backoff
    expect(secondResult).toEqual({ sent: 0, failed: 0, retried: 0 });
    const [afterSecond] = await repo.outbox.list({ kind: 'usage.report' } as never);
    expect(afterSecond.attempts).toBe(1); // unchanged -- item.nextAttemptAt > now, so it was skipped entirely
  });
});

describe('EC:C4 usage.flushOutbox — exponential backoff, capped at 60 minutes', () => {
  it('backoff doubles per attempt (2, 4, 8, 16, 32 minutes) then caps at 60 minutes from attempt 6 onward', async () => {
    const { ids, clock, repo } = harness();
    const sub = mkSub();
    const provider = new FakeProvider({ meters: true, alwaysFail: true });
    await repo.customers.put(linkedCustomer);
    await record({ event: { customerId: 'cust_1', meter: 'api_call', quantity: 1, occurredAt: clock.now(), idempotencyKey: 'evt_1' }, sub, policy: DEFAULT_POLICY, repo, clock, ids, provider });

    const expectedBackoffMinutes = [2, 4, 8, 16, 32, 60, 60]; // measured against flushOutbox.ts's backoffMs(attempts) = min(60, 2^attempts) minutes
    for (let i = 0; i < expectedBackoffMinutes.length; i++) {
      const before = clock.now();
      const res = await flushOutbox({ repo, providers: { stripe: provider }, clock, maxAttempts: 10 });
      expect(res).toEqual({ sent: 0, failed: 0, retried: 1 });
      const [item] = await repo.outbox.list({ kind: 'usage.report' } as never);
      expect(item.attempts).toBe(i + 1);
      expect(item.status).toBe('pending');
      const deltaMin = (item.nextAttemptAt.getTime() - before.getTime()) / 60_000;
      expect(deltaMin).toBe(expectedBackoffMinutes[i]);
      clock.advance(item.nextAttemptAt.getTime() - clock.now().getTime()); // jump exactly to the next eligible instant
    }
    expect(provider.reportUsageCalls).toHaveLength(expectedBackoffMinutes.length);
  });
});

describe('EC:C4 usage.flushOutbox — maxAttempts exhaustion', () => {
  it('a persistently-failing item is marked "failed" (gives up) once attempts reaches maxAttempts, and is not retried further', async () => {
    const { ids, clock, repo } = harness();
    const sub = mkSub();
    const provider = new FakeProvider({ meters: true, alwaysFail: true });
    await repo.customers.put(linkedCustomer);
    await record({ event: { customerId: 'cust_1', meter: 'api_call', quantity: 1, occurredAt: clock.now(), idempotencyKey: 'evt_1' }, sub, policy: DEFAULT_POLICY, repo, clock, ids, provider });

    const maxAttempts = 3;
    // attempt 1: pending/retried; attempt 2: pending/retried; attempt 3: attempts>=maxAttempts -> failed
    for (let i = 1; i <= 2; i++) {
      const res = await flushOutbox({ repo, providers: { stripe: provider }, clock, maxAttempts });
      expect(res).toEqual({ sent: 0, failed: 0, retried: 1 });
      const [item] = await repo.outbox.list({ kind: 'usage.report' } as never);
      expect(item.status).toBe('pending');
      clock.advance(item.nextAttemptAt.getTime() - clock.now().getTime());
    }
    const finalRes = await flushOutbox({ repo, providers: { stripe: provider }, clock, maxAttempts });
    expect(finalRes).toEqual({ sent: 0, failed: 1, retried: 0 });
    const [finalItem] = await repo.outbox.list({ kind: 'usage.report' } as never);
    expect(finalItem.status).toBe('failed');
    expect(finalItem.attempts).toBe(3);

    // a subsequent flush call is a no-op: the item is no longer 'pending', so it's not even looked at.
    clock.advance(24 * 60 * 60 * 1000);
    const afterGiveUp = await flushOutbox({ repo, providers: { stripe: provider }, clock, maxAttempts });
    expect(afterGiveUp).toEqual({ sent: 0, failed: 0, retried: 0 });
    expect(provider.reportUsageCalls).toHaveLength(3); // no 4th call was ever made
  });
});
