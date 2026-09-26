// [EC:C10] usage reservations on Postgres — racing reserves for the last budget, one per connection.
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { DEFAULT_POLICY, FixedClock } from 'boilpayment-core';
import { PostgresLedgerStore, PostgresRepo } from '../dist/index.js';
import { commit, release, reserve, sweepReservations } from '../../../usage/ts/src/reservation.js';
import { createTestDb, dropTestDb, type TestDb } from './db-helper.js';

describe('[EC:C10] usage reservations on Postgres', () => {
  let db: TestDb;
  afterAll(async () => {
    if (db) await dropTestDb(db);
  });

  it('10 parallel reserves of 60 against 100 credits, each on its own connection: exactly one wins', async () => {
    db = await createTestDb('reserve');
    const repo = new PostgresRepo(db.pool);
    const customerId = `cust_${randomUUID()}`;
    const clock = new FixedClock(new Date('2026-05-15T00:00:00Z'));
    await repo.customers.put({ id: customerId, email: null, providerRefs: [], status: 'active', createdAt: clock.now() });
    const seed = new PostgresLedgerStore(db.pool);
    await seed.append({
      customerId, pool: 'paid', kind: 'grant', amount: 100, unitPriceMinor: null, currency: null, expiresAt: null,
      source: 'manual', reference: {}, idempotencyKey: `seed_${customerId}`, actor: 'test', reason: 'seed',
    });

    const results = await Promise.all(
      Array.from({ length: 10 }, async (_, i) => {
        const pool = new Pool({ host: '127.0.0.1', database: db.dbName });
        try {
          return await reserve({ customerId, jobId: `job_${i}`, amount: 60, policy: DEFAULT_POLICY, ledger: new PostgresLedgerStore(pool), clock });
        } finally {
          await pool.end();
        }
      }),
    );
    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    console.log(`[EC:C10 pg race] reserves=10 amount=60 budget=100 won=${winners.length} refused=${losers.length} ` +
      `available_after=${(await seed.balance(customerId, undefined, clock.now())).available}`);
    expect(winners).toHaveLength(1);
    for (const l of losers) expect(l).toEqual({ ok: false, reason: 'insufficient', need: 60, available: 40 });

    const won = winners[0] as Extract<(typeof results)[number], { ok: true }>;
    const deps = { customerId, policy: DEFAULT_POLICY, ledger: seed, clock };
    await commit({ ...deps, jobId: won.reservation.jobId, amount: 25 });
    expect((await seed.balance(customerId, undefined, clock.now())).available).toBe(75);

    await reserve({ ...deps, jobId: 'job_late', amount: 50 });
    clock.advance((DEFAULT_POLICY.usage.reservationTtlMinutes + 1) * 60_000);
    expect(await sweepReservations({ repo, ledger: seed, clock })).toEqual({ expired: 1 });
    expect((await seed.balance(customerId, undefined, clock.now())).available).toBe(75);
    await expect(release({ ...deps, jobId: 'job_late' })).resolves.toMatchObject({ duplicated: true });
  }, 30_000);
});
