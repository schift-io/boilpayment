// Round-5 audit A5-7 (EC:A48) on Postgres: two workers (separate pools) that see the same stale attempt
// lease take it over once; the holder whose lease was taken over cannot release the new holder's lease.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { FixedClock } from 'boilpayment-core';
import type { Operation } from 'boilpayment-core';
import { createPool, createPostgresRepo, migrate } from 'boilpayment-schema-postgres';
import { ATTEMPT_LEASE_MS, withAttemptLease } from '../../../lifecycle/ts/dist/charge-attempt.js';

let dbName = '';
let pools: any[] = [];
beforeAll(async () => {
  dbName = `paykit_test_r5_${process.pid}_${randomBytes(3).toString('hex')}`;
  execFileSync('createdb', ['-h', '127.0.0.1', dbName]);
  pools = [0, 1, 2].map(() => createPool(`postgres://127.0.0.1/${dbName}`, { max: 4 }));
  await migrate({ pool: pools[0] as any, modules: ['core'] });
});
afterAll(async () => {
  for (const p of pools) await p.end();
  execFileSync('dropdb', ['-h', '127.0.0.1', '--if-exists', dbName]);
});

describe('EC:A48 attempt lease compare-and-set on Postgres', () => {
  it('a stale lease is taken over by exactly one of two workers, 5 rounds', async () => {
    const t0 = Date.parse('2024-02-01T00:00:00Z');
    const later = new FixedClock(new Date(t0 + ATTEMPT_LEASE_MS + 60_000));
    for (let round = 0; round < 5; round++) {
      const key = `r5-lease-${round}`;
      const [ra, rb, rc] = pools.map((p) => createPostgresRepo(p as any));
      // A claimed and wrote a lease that is now stale (A hung past its lease).
      const claimed = (await ra.operations.claim({ id: `charge-lease:${key}`, key: `charge-lease:${key}`, kind: 'lifecycle.charge_attempt',
        payloadHash: 'charge-attempt-lease', status: 'in_progress', result: null, error: null, createdAt: new Date(t0), completedAt: null, attempts: 0 } as Operation))!;
      const aHeld: Operation = { ...claimed, result: { leaseUntil: new Date(t0 + ATTEMPT_LEASE_MS).toISOString(), token: 'A' } };
      expect(await ra.operations.compareAndSet!(claimed, aHeld)).toBe(true);
      let inside = 0;
      let maxInside = 0;
      const body = async () => { inside += 1; maxInside = Math.max(maxInside, inside); await new Promise((r) => setTimeout(r, 30)); inside -= 1; };
      const [b, c] = await Promise.all([withAttemptLease(rb, later, key, body), withAttemptLease(rc, later, key, body)]);
      expect([b.held, c.held].filter(Boolean)).toHaveLength(1);
      expect(maxInside).toBe(1);
      // A finally returns and tries to release with the row it held: refused (the lease moved on).
      const d = withAttemptLease(rb, later, key, () => new Promise((r) => setTimeout(r, 40)));
      await new Promise((r) => setTimeout(r, 10));
      expect(await ra.operations.compareAndSet!(aHeld, { ...aHeld, status: 'failed', result: null, completedAt: new Date() })).toBe(false);
      expect((await withAttemptLease(rc, later, key, body)).held).toBe(false); // D still holds it
      expect((await d).held).toBe(true);
    }
  });
});
