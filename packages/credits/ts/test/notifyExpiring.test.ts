// spec: packages/credits/spec/credits.pseudo.md [EC:B16]
import { describe, expect, it } from 'vitest';
import { FixedClock, InMemoryLedger, InMemoryRepo, NoopNotifier, SequentialIdGen, resolvePolicy } from 'boilpayment-core';
import { notifyExpiring } from '../src/notifyExpiring.js';

async function grant(ledger: InMemoryLedger, customerId: string, amount: number, expiresAt: Date | null, key: string) {
  await ledger.append({
    customerId, pool: 'paid', kind: 'grant', amount, unitPriceMinor: null, currency: null, expiresAt,
    source: 'subscription', reference: {}, idempotencyKey: key, actor: 'system', reason: null,
  });
}

describe('EC:B16 credits.notifyExpiring — window boundaries', () => {
  it('expiryNoticeDays=null (default): never reports anything', async () => {
    const clock = new FixedClock(new Date('2024-01-01T00:00:00.000Z'));
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const repo = new InMemoryRepo();
    await grant(ledger, 'cust_1', 100, new Date('2024-01-02T00:00:00.000Z'), 'g1');
    const policy = resolvePolicy();

    const res = await notifyExpiring({ customerId: 'cust_1', ledger, repo, notifier: new NoopNotifier(), policy, clock });
    expect(res.pending).toEqual([]);
  });

  it('a bucket expiring exactly at now + expiryNoticeDays is included (inclusive upper bound)', async () => {
    const clock = new FixedClock(new Date('2024-01-01T00:00:00.000Z'));
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const repo = new InMemoryRepo();
    await grant(ledger, 'cust_1', 100, new Date('2024-01-08T00:00:00.000Z'), 'g1'); // exactly +7d
    const policy = resolvePolicy({ credits: { expiryNoticeDays: 7 } });

    const res = await notifyExpiring({ customerId: 'cust_1', ledger, repo, notifier: new NoopNotifier(), policy, clock });
    expect(res.pending).toEqual([{ customerId: 'cust_1', expiresAt: new Date('2024-01-08T00:00:00.000Z'), amount: 100 }]);
  });

  it('a bucket expiring 1ms after the window is excluded', async () => {
    const clock = new FixedClock(new Date('2024-01-01T00:00:00.000Z'));
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const repo = new InMemoryRepo();
    await grant(ledger, 'cust_1', 100, new Date('2024-01-08T00:00:00.001Z'), 'g1'); // +7d + 1ms
    const policy = resolvePolicy({ credits: { expiryNoticeDays: 7 } });

    const res = await notifyExpiring({ customerId: 'cust_1', ledger, repo, notifier: new NoopNotifier(), policy, clock });
    expect(res.pending).toEqual([]);
  });

  it('a bucket expiring beyond the window (e.g. 30 days out with a 7-day notice) is excluded', async () => {
    const clock = new FixedClock(new Date('2024-01-01T00:00:00.000Z'));
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const repo = new InMemoryRepo();
    await grant(ledger, 'cust_1', 100, new Date('2024-01-31T00:00:00.000Z'), 'g1');
    const policy = resolvePolicy({ credits: { expiryNoticeDays: 7 } });

    const res = await notifyExpiring({ customerId: 'cust_1', ledger, repo, notifier: new NoopNotifier(), policy, clock });
    expect(res.pending).toEqual([]);
  });

  it('a fully-consumed bucket (amount 0 remaining) is not reported even inside the window', async () => {
    const clock = new FixedClock(new Date('2024-01-01T00:00:00.000Z'));
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const repo = new InMemoryRepo();
    const expiresAt = new Date('2024-01-05T00:00:00.000Z');
    await grant(ledger, 'cust_1', 100, expiresAt, 'g1');
    await ledger.consume({
      customerId: 'cust_1', poolOrder: ['paid'], amount: 100, idempotencyKey: 'spend',
      meta: {}, now: clock.now(), negativeBalance: 'block', negativeFloor: 0,
    });
    const policy = resolvePolicy({ credits: { expiryNoticeDays: 7 } });

    const res = await notifyExpiring({ customerId: 'cust_1', ledger, repo, notifier: new NoopNotifier(), policy, clock });
    expect(res.pending).toEqual([]);
  });

  it('a non-null-expiry (never-expiring, rollover=full) bucket is never reported', async () => {
    const clock = new FixedClock(new Date('2024-01-01T00:00:00.000Z'));
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const repo = new InMemoryRepo();
    await grant(ledger, 'cust_1', 100, null, 'g1');
    const policy = resolvePolicy({ credits: { expiryNoticeDays: 7 } });

    const res = await notifyExpiring({ customerId: 'cust_1', ledger, repo, notifier: new NoopNotifier(), policy, clock });
    expect(res.pending).toEqual([]);
  });
});

describe('EC:B16 credits.notifyExpiring — idempotent per (customer, expiresAt, day), no daily-cron spam', () => {
  it('a second call the same day returns nothing new for a bucket already reported today', async () => {
    const clock = new FixedClock(new Date('2024-01-01T00:00:00.000Z'));
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const repo = new InMemoryRepo();
    await grant(ledger, 'cust_1', 100, new Date('2024-01-05T00:00:00.000Z'), 'g1');
    const policy = resolvePolicy({ credits: { expiryNoticeDays: 7 } });

    const first = await notifyExpiring({ customerId: 'cust_1', ledger, repo, notifier: new NoopNotifier(), policy, clock });
    expect(first.pending).toHaveLength(1);

    const second = await notifyExpiring({ customerId: 'cust_1', ledger, repo, notifier: new NoopNotifier(), policy, clock });
    expect(second.pending).toEqual([]);
  });

  it('the next calendar day reports the same still-unexpired bucket again (daily reminder, not spam)', async () => {
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const repo = new InMemoryRepo();
    const day1 = new FixedClock(new Date('2024-01-01T00:00:00.000Z'));
    await grant(ledger, 'cust_1', 100, new Date('2024-01-05T00:00:00.000Z'), 'g1');
    const policy = resolvePolicy({ credits: { expiryNoticeDays: 7 } });

    await notifyExpiring({ customerId: 'cust_1', ledger, repo, notifier: new NoopNotifier(), policy, clock: day1 });

    const day2 = new FixedClock(new Date('2024-01-02T00:00:00.000Z'));
    const res = await notifyExpiring({ customerId: 'cust_1', ledger, repo, notifier: new NoopNotifier(), policy, clock: day2 });
    expect(res.pending).toEqual([{ customerId: 'cust_1', expiresAt: new Date('2024-01-05T00:00:00.000Z'), amount: 100 }]);
  });
});

describe('EC:B16 credits.notifyExpiring — customerId filter vs. scanning every customer', () => {
  it('with customerId, only that customer is checked even if others also have expiring credits', async () => {
    const clock = new FixedClock(new Date('2024-01-01T00:00:00.000Z'));
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const repo = new InMemoryRepo();
    await grant(ledger, 'cust_1', 100, new Date('2024-01-05T00:00:00.000Z'), 'g1');
    await grant(ledger, 'cust_2', 50, new Date('2024-01-05T00:00:00.000Z'), 'g2');
    const policy = resolvePolicy({ credits: { expiryNoticeDays: 7 } });

    const res = await notifyExpiring({ customerId: 'cust_2', ledger, repo, notifier: new NoopNotifier(), policy, clock });
    expect(res.pending).toEqual([{ customerId: 'cust_2', expiresAt: new Date('2024-01-05T00:00:00.000Z'), amount: 50 }]);
  });

  it('without customerId, every customer in repo.customers is scanned', async () => {
    const clock = new FixedClock(new Date('2024-01-01T00:00:00.000Z'));
    const ledger = new InMemoryLedger(new SequentialIdGen('led_'));
    const repo = new InMemoryRepo();
    await repo.customers.put({ id: 'cust_1', email: null, providerRefs: [], status: 'active', createdAt: clock.now() });
    await repo.customers.put({ id: 'cust_2', email: null, providerRefs: [], status: 'active', createdAt: clock.now() });
    await grant(ledger, 'cust_1', 100, new Date('2024-01-05T00:00:00.000Z'), 'g1');
    await grant(ledger, 'cust_2', 50, new Date('2024-01-05T00:00:00.000Z'), 'g2');
    const policy = resolvePolicy({ credits: { expiryNoticeDays: 7 } });

    const res = await notifyExpiring({ ledger, repo, notifier: new NoopNotifier(), policy, clock });
    expect(res.pending.map((p) => p.customerId).sort()).toEqual(['cust_1', 'cust_2']);
  });
});
