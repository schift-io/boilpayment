// Regression tests for runIdempotent / hashPayload.
// spec: packages/core/spec/core.pseudo.md [EC:J1 J2 J3 J4 J5]
import { describe, expect, it } from 'vitest';
import { FixedClock } from '../src/clock.js';
import { InMemoryRepo } from '../src/memory.js';
import { hashPayload, runIdempotent, stableStringify } from '../src/idempotent.js';

function env() {
  const repo = new InMemoryRepo();
  const clock = new FixedClock(new Date('2026-01-01T00:00:00Z'));
  return { repo, clock };
}

describe('hashPayload / stableStringify', () => {
  it('is insensitive to key order', () => {
    expect(hashPayload({ a: 1, b: 2 })).toBe(hashPayload({ b: 2, a: 1 }));
  });
  it('is sensitive to value changes', () => {
    expect(hashPayload({ a: 1 })).not.toBe(hashPayload({ a: 2 }));
  });
  it('converts Dates to ISO strings', () => {
    expect(stableStringify(new Date('2026-01-01T00:00:00.000Z'))).toBe('"2026-01-01T00:00:00.000Z"');
  });
});

describe('runIdempotent', () => {
  it('[EC:J1] a same-key/same-payload retry replays the first result without re-running fn', async () => {
    const { repo, clock } = env();
    let calls = 0;
    const run = () =>
      runIdempotent({
        repo,
        clock,
        key: 'op:1',
        kind: 'test.op',
        payload: { a: 1 },
        fn: async () => {
          calls += 1;
          return { n: calls };
        },
      });

    const first = await run();
    const second = await run();

    expect(first.result).toEqual({ n: 1 });
    expect(first.replayed).toBe(false);
    expect(second.result).toEqual({ n: 1 }); // replayed, not a fresh execution
    expect(second.replayed).toBe(true);
    expect(calls).toBe(1);
  });

  it('[EC:J2] a same-key/different-payload retry throws idempotency_key_reused', async () => {
    const { repo, clock } = env();
    await runIdempotent({ repo, clock, key: 'op:2', kind: 'test.op', payload: { a: 1 }, fn: async () => 'x' });

    await expect(
      runIdempotent({ repo, clock, key: 'op:2', kind: 'test.op', payload: { a: 2 }, fn: async () => 'y' }),
    ).rejects.toMatchObject({ code: 'idempotency_key_reused' });
  });

  it('[EC:J3] a second call while the first is still in_progress throws idempotency_in_progress', async () => {
    const { repo, clock } = env();
    let releaseFirst!: () => void;
    const gate = new Promise<void>((res) => { releaseFirst = res; });

    const pending = runIdempotent({
      repo,
      clock,
      key: 'op:3',
      kind: 'test.op',
      payload: {},
      fn: async () => {
        await gate;
        return 'done';
      },
    });

    // let the first call get past repo.operations.put(in_progress) before racing the second
    await Promise.resolve();
    await Promise.resolve();

    await expect(
      runIdempotent({ repo, clock, key: 'op:3', kind: 'test.op', payload: {}, fn: async () => 'other' }),
    ).rejects.toMatchObject({ code: 'idempotency_in_progress' });

    releaseFirst();
    const result = await pending;
    expect(result.result).toBe('done');
  });

  it('failed status allows re-run (and can then succeed and be replayed)', async () => {
    const { repo, clock } = env();
    let attempt = 0;
    const run = () =>
      runIdempotent({
        repo,
        clock,
        key: 'op:4',
        kind: 'test.op',
        payload: { a: 1 },
        fn: async () => {
          attempt += 1;
          if (attempt === 1) throw new Error('boom');
          return { attempt };
        },
      });

    await expect(run()).rejects.toThrow('boom');
    const second = await run(); // failed -> re-run allowed
    expect(second.result).toEqual({ attempt: 2 });
    expect(second.replayed).toBe(false);

    const third = await run(); // now done -> replayed
    expect(third.result).toEqual({ attempt: 2 });
    expect(third.replayed).toBe(true);
    expect(attempt).toBe(2);
  });

  it('serialize/deserialize round-trips a custom result shape (Date fields survive)', async () => {
    const { repo, clock } = env();
    const when = new Date('2026-02-02T00:00:00Z');
    const run = () =>
      runIdempotent<{ when: Date }>({
        repo,
        clock,
        key: 'op:5',
        kind: 'test.op',
        payload: {},
        serialize: (r) => ({ when: r.when.toISOString() }),
        deserialize: (v: any) => ({ when: new Date(v.when) }),
        fn: async () => ({ when }),
      });

    await run();
    const second = await run();
    expect(second.result.when).toBeInstanceOf(Date);
    expect(second.result.when.toISOString()).toBe(when.toISOString());
  });

  // EC:I9 finding (2026-09-09, cs.timeline) — a replay used to leave the stored Operation row
  // untouched, so an operation retried 5 times (all replays) and one executed exactly once looked
  // identical in storage.
  it('attempts starts at 1 on first execution and increments by 1 on every replay', async () => {
    const { repo, clock } = env();
    const run = () =>
      runIdempotent({ repo, clock, key: 'op:attempts', kind: 'test.op', payload: { a: 1 }, fn: async () => ({ ok: true }) });

    const first = await run();
    expect(first.replayed).toBe(false);
    expect((await repo.operations.get('op:attempts'))!.attempts).toBe(1);

    await run();
    await run();
    const third = await run();
    expect(third.replayed).toBe(true);
    expect((await repo.operations.get('op:attempts'))!.attempts).toBe(4); // 1 execution + 3 replays
  });

  it('attempts also increments across a failed -> retried -> succeeded sequence', async () => {
    const { repo, clock } = env();
    let attempt = 0;
    const run = () =>
      runIdempotent({
        repo,
        clock,
        key: 'op:attempts-retry',
        kind: 'test.op',
        payload: { a: 1 },
        fn: async () => {
          attempt += 1;
          if (attempt === 1) throw new Error('boom');
          return { attempt };
        },
      });

    await expect(run()).rejects.toThrow('boom');
    expect((await repo.operations.get('op:attempts-retry'))!.attempts).toBe(1);

    await run(); // failed -> re-run, a genuine second attempt
    expect((await repo.operations.get('op:attempts-retry'))!.attempts).toBe(2);

    await run(); // now done -> replay, a third attempt
    expect((await repo.operations.get('op:attempts-retry'))!.attempts).toBe(3);
  });
});

describe('atomic operation acquisition', () => {
  it.each([false, true])('runs exactly once for simultaneous callers (failed retry=%s)', async (retry) => {
    const { repo, clock } = env();
    const key = `race:${retry}`;
    if (retry) await repo.operations.put({ id: key, key, kind: 'test', payloadHash: hashPayload({}), status: 'failed', result: null, error: 'retry', createdAt: clock.now(), completedAt: clock.now(), attempts: 1 });
    let calls = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const run = () => runIdempotent({ repo, clock, key, kind: 'test', payload: {}, fn: async () => { calls += 1; await gate; return 'done'; } });
    const pending = Promise.allSettled([run(), run()]);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    release();
    const results = await pending;
    expect(calls).toBe(1);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: 'idempotency_in_progress' } });
    expect((await repo.operations.get(key))?.attempts).toBe(retry ? 2 : 1);
  });
});
