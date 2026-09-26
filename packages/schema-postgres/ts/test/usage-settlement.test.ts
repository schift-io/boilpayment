import { expect, it } from 'vitest';
import { PostgresLedgerStore, PostgresRepo } from '../dist/index.js';
import { createTestDb, dropTestDb } from './db-helper.js';
import { given } from '../../../usage/ts/test/settlementFixtures.js';
import { settlePeriod } from '../../../usage/ts/src/settlePeriod.js';

it('commits a usage intent before a lost provider response and retains its key with late usage', async () => {
  const db = await createTestDb('usage_intent');
  try {
    const fixture = await given();
    const repo = new PostgresRepo(db.pool);
    const ledger = new PostgresLedgerStore(db.pool);
    for (const customer of await fixture.repo.customers.list()) await repo.customers.put(customer);
    for (const plan of await fixture.repo.plans.list()) await repo.plans.put(plan);
    await repo.subscriptions.put({ ...fixture.sub, version: 0 });
    for (const event of await fixture.repo.usageEvents.list()) await repo.usageEvents.put(event);
    const input = { ...fixture, repo, ledger };
    input.provider.loseResponse = true;
    await expect(settlePeriod(input)).rejects.toThrow('connection lost');
    // These SELECTs execute after the failing service has unwound its transaction context.
    expect(await repo.operations.list()).toMatchObject([{ status: 'in_progress' }]);
    expect(await repo.outbox.list({ kind: 'usage.charge' })).toMatchObject([{ status: 'pending' }]);
    await repo.usageEvents.put({ id: 'late', customerId: input.sub.customerId, meter: 'call', quantity: 2, occurredAt: input.period.start, receivedAt: input.clock.now(), periodStart: input.period.start, idempotencyKey: 'late', meta: null });
    expect((await settlePeriod(input)).status).toBe('pending');
    input.clock.advance(300_000);
    expect((await settlePeriod(input)).status).toBe('charged');
    expect(input.provider.calls[1]).toEqual(input.provider.calls[0]);
    expect((await settlePeriod(input)).chargedAmount).toEqual({ amountMinor: 500, currency: 'KRW' });
    expect(input.provider.charges.size).toBe(2);
    expect((await repo.payments.list({ kind: 'overage' })).map((payment) => payment.amount.amountMinor).sort()).toEqual([500, 750]);
  } finally {
    await dropTestDb(db);
  }
});
