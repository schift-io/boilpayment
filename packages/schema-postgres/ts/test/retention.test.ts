// [EC:J4 L4] pruneRetention() — real Postgres proof: old operations (done/failed) and old
// audit_log rows are deleted; in_progress operations and fresh rows of both survive; dryRun
// deletes nothing; batching deletes more rows than a single batchSize.
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DEFAULT_POLICY, FixedClock, type Customer, type Operation } from 'boilpayment-core';
import { PostgresRepo, PostgresLogger, pruneRetention } from '../dist/index.js';
import { createTestDb, dropTestDb, type TestDb } from './db-helper.js';

describe('pruneRetention', () => {
  let db: TestDb;
  let repo: PostgresRepo;
  let logger: PostgresLogger;
  const clock = new FixedClock(new Date('2026-06-01T00:00:00.000Z'));
  const policy = { ...DEFAULT_POLICY, retention: { operationDays: 7, auditLogDays: 90 } };

  beforeAll(async () => {
    db = await createTestDb('retention');
    repo = new PostgresRepo(db.pool);
    logger = new PostgresLogger(db.pool);
    const customer: Customer = { id: 'cust_retention', email: null, providerRefs: [], status: 'active', createdAt: clock.now() };
    await repo.customers.put(customer);
  });

  afterAll(async () => {
    await dropTestDb(db);
  });

  function mkOp(overrides: Partial<Operation>): Operation {
    const key = overrides.key ?? `op_${randomUUID()}`;
    return {
      id: key,
      key,
      kind: 'lifecycle.upgrade',
      payloadHash: 'hash',
      result: null,
      error: null,
      completedAt: null,
      attempts: 1,
      status: 'done',
      createdAt: clock.now(),
      ...overrides,
    };
  }

  it('[EC:J4] deletes done/failed operations older than operationDays, keeps fresh and in_progress rows', async () => {
    const old = new Date(clock.now().getTime() - 8 * 86_400_000); // 8 days old, past the 7-day window
    const fresh = new Date(clock.now().getTime() - 1 * 86_400_000); // 1 day old, within window

    const oldDone = await repo.operations.put(mkOp({ status: 'done', createdAt: old }));
    const oldFailed = await repo.operations.put(mkOp({ status: 'failed', createdAt: old }));
    const oldInProgress = await repo.operations.put(mkOp({ status: 'in_progress', createdAt: old })); // must survive regardless of age
    const freshDone = await repo.operations.put(mkOp({ status: 'done', createdAt: fresh }));

    const result = await pruneRetention({ pool: db.pool, policy, clock });

    expect(result.operationsDeleted).toBe(2); // oldDone + oldFailed only

    expect(await repo.operations.get(oldDone.id)).toBeNull();
    expect(await repo.operations.get(oldFailed.id)).toBeNull();
    expect(await repo.operations.get(oldInProgress.id)).not.toBeNull(); // EC:J4 — never pruned regardless of status
    expect(await repo.operations.get(freshDone.id)).not.toBeNull(); // within retention window
  });

  it('retains checkout and purchase entitlement evidence beyond operation TTL', async () => {
    const old = new Date('2020-01-01T00:00:00Z');
    for (const kind of ['checkout.entitlement', 'purchase.entitlement', 'refund.provider']) {
      await repo.operations.put(mkOp({ kind, createdAt: old }));
    }
    expect((await pruneRetention({ pool: db.pool, policy, clock, dryRun: true })).operationsDeleted).toBe(0);
    expect((await pruneRetention({ pool: db.pool, policy, clock })).operationsDeleted).toBe(0);
    for (const kind of ['checkout.entitlement', 'purchase.entitlement', 'refund.provider']) {
      expect(await repo.operations.list({ kind })).toHaveLength(1);
    }
  });

  it('[EC:L4] deletes audit_log rows older than auditLogDays, keeps fresh rows', async () => {
    const old = new Date(clock.now().getTime() - 91 * 86_400_000); // 91 days old, past the 90-day window
    const fresh = new Date(clock.now().getTime() - 1 * 86_400_000);

    await logger.log({ level: 'info', event: 'test.old_1', at: old, customerId: 'cust_retention' });
    await logger.log({ level: 'info', event: 'test.old_2', at: old, customerId: 'cust_retention' });
    await logger.log({ level: 'info', event: 'test.fresh', at: fresh, customerId: 'cust_retention' });

    const before = await db.pool.query(`select count(*)::int as n from audit_log where event like 'test.%'`);
    expect(before.rows[0].n).toBe(3);

    const result = await pruneRetention({ pool: db.pool, policy, clock });
    expect(result.auditLogDeleted).toBeGreaterThanOrEqual(2); // at least our 2 old rows (other tests may add more)

    const after = await db.pool.query(`select event from audit_log where event like 'test.%' order by event`);
    expect(after.rows.map((r) => r.event)).toEqual(['test.fresh']);
  });

  it('dryRun=true returns the would-be counts without deleting anything', async () => {
    const old = new Date(clock.now().getTime() - 8 * 86_400_000);
    const op = await repo.operations.put(mkOp({ status: 'done', createdAt: old }));
    await logger.log({ level: 'info', event: 'test.dry_run_old', at: new Date(clock.now().getTime() - 91 * 86_400_000), customerId: 'cust_retention' });

    const result = await pruneRetention({ pool: db.pool, policy, clock, dryRun: true });
    expect(result.operationsDeleted).toBeGreaterThanOrEqual(1);
    expect(result.auditLogDeleted).toBeGreaterThanOrEqual(1);

    // nothing was actually deleted
    expect(await repo.operations.get(op.id)).not.toBeNull();
    const stillThere = await db.pool.query(`select count(*)::int as n from audit_log where event = 'test.dry_run_old'`);
    expect(stillThere.rows[0].n).toBe(1);

    // clean up so it doesn't leak into the next test's counts
    const real = await pruneRetention({ pool: db.pool, policy, clock });
    expect(real.operationsDeleted).toBeGreaterThanOrEqual(1);
  });

  it('batches deletes so a backlog larger than batchSize is still fully removed', async () => {
    const old = new Date(clock.now().getTime() - 8 * 86_400_000);
    const ops = await Promise.all(
      Array.from({ length: 5 }, () => repo.operations.put(mkOp({ status: 'done', createdAt: old }))),
    );

    const result = await pruneRetention({ pool: db.pool, policy, clock, batchSize: 2 });
    expect(result.operationsDeleted).toBeGreaterThanOrEqual(5); // 5 rows, batchSize=2 => 3 statements, all deleted

    for (const op of ops) {
      expect(await repo.operations.get(op.id)).toBeNull();
    }
  });
});
