import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, hashPayload, runIdempotent, type Operation } from '@schift/payment-kit-core';
import { PostgresRepo } from '../dist/index.js';
import { createTestDb, dropTestDb, type TestDb } from './db-helper.js';

describe('atomic persisted operation claims', () => {
  let db: TestDb;
  const clock = new FixedClock(new Date('2026-01-01T00:00:00Z'));
  beforeAll(async () => { db = await createTestDb('operation_claim'); });
  afterAll(async () => { await dropTestDb(db); });

  it.each([false, true])('allows one concurrent claim (failed retry=%s)', async (retry) => {
    const first = new PostgresRepo(db.pool);
    const second = new PostgresRepo(db.pool);
    const key = `claim:${retry}`;
    const row: Operation = { id: key, key, kind: 'test', payloadHash: hashPayload({}), status: 'in_progress', result: null, error: null, createdAt: clock.now(), completedAt: null, attempts: 1 };
    if (retry) await first.operations.put({ ...row, status: 'failed' });
    const claims = await Promise.all([first.operations.claim(row), second.operations.claim(row)]);
    const winner = claims.find((claim) => claim !== null);
    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    expect(winner?.attempts).toBe(retry ? 2 : 1);
    expect(await first.operations.claim({ ...row, payloadHash: 'different' })).toBeNull();
  });

  it.each([false, true])('executes one fn across repository instances (failed retry=%s)', async (retry) => {
    const first = new PostgresRepo(db.pool);
    const second = new PostgresRepo(db.pool);
    const key = `execution:${retry}`;
    if (retry) await first.operations.put({ id: key, key, kind: 'test', payloadHash: hashPayload({}), status: 'failed', result: null, error: null, createdAt: clock.now(), completedAt: null, attempts: 1 });
    let calls = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const run = (repo: PostgresRepo) => runIdempotent({ repo, clock, key, kind: 'test', payload: {}, fn: async () => { calls += 1; await gate; return 'done'; } });
    const contenders = [run(first), run(second)];
    const settled = Promise.allSettled(contenders);
    try {
      await expect(Promise.race(contenders)).rejects.toMatchObject({ code: 'idempotency_in_progress' });
    } finally { release(); }
    expect((await settled).filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(calls).toBe(1);
    expect((await run(first)).replayed).toBe(true);
    expect(calls).toBe(1);
  });
});
