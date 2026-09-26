// EC:C2 (late-report period attribution) EC:C3 (UTC) EC:C4 (outbox enqueue) EC:C7 (meta stored)
// spec: packages/usage/spec/usage.pseudo.md
import { describe, expect, it } from 'vitest';
import { FixedClock, InMemoryRepo, Plan, SequentialIdGen } from '@schift/payment-kit-core';
import { record } from '../src/record.js';
import { FakeProvider, basePolicy, mkSub } from './fixtures.js';

const plan: Plan = {
  id: 'plan_pro', name: 'Pro', interval: 'month', creditsPerPeriod: 0, usageIncluded: 5, trialDays: 0, prices: [],
};

describe('EC:C2 usage.record — period attribution', () => {
  it('EC:C2 on-time event (occurredAt within currentPeriod) attributes to currentPeriod.start regardless of receivedAt', async () => {
    const ids = new SequentialIdGen('id_');
    const clock = new FixedClock(new Date('2026-05-15T00:00:00Z'));
    const repo = new InMemoryRepo();
    const sub = mkSub();

    const r = await record({
      event: { customerId: sub.customerId, meter: 'api_call', quantity: 3, occurredAt: new Date('2026-05-15T00:00:00Z'), idempotencyKey: 'evt_ontime' },
      sub, policy: basePolicy, repo, clock, ids,
    });

    expect(r.duplicated).toBe(false);
    expect(r.event.periodStart.getTime()).toBe(sub.currentPeriod.start.getTime());
  });

  it('EC:C2 late report WITHIN lateReportWindowHours, no plan given -> length-approximation previous period', async () => {
    const ids = new SequentialIdGen('id_');
    // receivedAt (clock.now()) is 24h after currentPeriod.start -- within the default 48h window
    const clock = new FixedClock(new Date('2026-05-02T00:00:00Z'));
    const repo = new InMemoryRepo();
    const sub = mkSub();

    const r = await record({
      event: { customerId: sub.customerId, meter: 'api_call', quantity: 2, occurredAt: new Date('2026-04-15T00:00:00Z'), idempotencyKey: 'evt_late_approx' },
      sub, policy: basePolicy, repo, clock, ids, // no `plan` -> approximation path
    });

    // approximation = currentPeriod.start - (currentPeriod.end - currentPeriod.start); May has 31 days -> Mar 31
    const periodLengthMs = sub.currentPeriod.end.getTime() - sub.currentPeriod.start.getTime();
    const expected = new Date(sub.currentPeriod.start.getTime() - periodLengthMs);
    expect(r.event.periodStart.toISOString()).toBe(expected.toISOString());
    expect(r.event.periodStart.toISOString()).toBe('2026-03-31T00:00:00.000Z'); // measured via periodContaining probe run this session
  });

  it('EC:C2 late report WITHIN window, WITH plan -> exact periodContaining(sub.createdAt, plan.interval, occurredAt, ...) differs from the approximation', async () => {
    const ids = new SequentialIdGen('id_');
    const clock = new FixedClock(new Date('2026-05-02T00:00:00Z')); // same 24h-late receivedAt as above
    const repo = new InMemoryRepo();
    const sub = mkSub(); // sub.createdAt = 2026-01-01, anchorDay = 1

    const r = await record({
      event: { customerId: sub.customerId, meter: 'api_call', quantity: 2, occurredAt: new Date('2026-04-15T00:00:00Z'), idempotencyKey: 'evt_late_exact' },
      sub, policy: basePolicy, repo, clock, ids, plan,
    });

    // periodContaining(Jan1, 'month', Apr15, ...) walks Jan1-Feb1, Feb1-Mar1, Mar1-Apr1, Apr1-May1 -> .start = Apr1
    // measured directly against core's periodContaining this session (independent of record.ts's own call).
    expect(r.event.periodStart.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    // and it must differ from the no-plan approximation for the identical occurredAt/receivedAt
    expect(r.event.periodStart.toISOString()).not.toBe('2026-03-31T00:00:00.000Z');
  });

  it('EC:C2 late report exactly AT the lateReportWindowHours boundary (48h) is still "within window" (<=, inclusive)', async () => {
    const ids = new SequentialIdGen('id_');
    const boundary = new Date(mkSub().currentPeriod.start.getTime() + 48 * 60 * 60 * 1000);
    const clock = new FixedClock(boundary);
    const repo = new InMemoryRepo();
    const sub = mkSub();

    const r = await record({
      event: { customerId: sub.customerId, meter: 'api_call', quantity: 1, occurredAt: new Date('2026-04-20T00:00:00Z'), idempotencyKey: 'evt_boundary_in' },
      sub, policy: basePolicy, repo, clock, ids,
    });

    expect(r.event.periodStart.toISOString()).toBe('2026-03-31T00:00:00.000Z'); // previous-period approximation applied
  });

  it('EC:C2 late report just PAST the lateReportWindowHours boundary (48h + 1ms) attributes to the CURRENT period', async () => {
    const ids = new SequentialIdGen('id_');
    const pastBoundary = new Date(mkSub().currentPeriod.start.getTime() + 48 * 60 * 60 * 1000 + 1);
    const clock = new FixedClock(pastBoundary);
    const repo = new InMemoryRepo();
    const sub = mkSub();

    const r = await record({
      event: { customerId: sub.customerId, meter: 'api_call', quantity: 1, occurredAt: new Date('2026-04-20T00:00:00Z'), idempotencyKey: 'evt_boundary_out' },
      sub, policy: basePolicy, repo, clock, ids,
    });

    expect(r.event.periodStart.getTime()).toBe(sub.currentPeriod.start.getTime());
  });

  it('EC:C2 late report OUTSIDE the window attributes to current period even when a plan is given', async () => {
    const ids = new SequentialIdGen('id_');
    const clock = new FixedClock(new Date('2026-05-10T00:00:00Z')); // 9 days = 216h > 48h late
    const repo = new InMemoryRepo();
    const sub = mkSub();

    const r = await record({
      event: { customerId: sub.customerId, meter: 'api_call', quantity: 4, occurredAt: new Date('2026-04-15T00:00:00Z'), idempotencyKey: 'evt_late_outside' },
      sub, policy: basePolicy, repo, clock, ids, plan,
    });

    expect(r.event.periodStart.getTime()).toBe(sub.currentPeriod.start.getTime());
  });

  it('EC:C2 dedupe by idempotencyKey returns the existing event and duplicated=true (no second row written)', async () => {
    const ids = new SequentialIdGen('id_');
    const clock = new FixedClock(new Date('2026-05-15T00:00:00Z'));
    const repo = new InMemoryRepo();
    const sub = mkSub();

    const first = await record({
      event: { customerId: sub.customerId, meter: 'api_call', quantity: 4, occurredAt: new Date('2026-05-15T00:00:00Z'), idempotencyKey: 'evt_dup' },
      sub, policy: basePolicy, repo, clock, ids,
    });
    const second = await record({
      event: { customerId: sub.customerId, meter: 'api_call', quantity: 999, occurredAt: new Date('2026-05-16T00:00:00Z'), idempotencyKey: 'evt_dup' },
      sub, policy: basePolicy, repo, clock, ids,
    });

    expect(second.duplicated).toBe(true);
    expect(second.event.id).toBe(first.event.id);
    expect(second.event.quantity).toBe(4); // the original row, not the second call's payload
    const all = await repo.usageEvents.list({ idempotencyKey: 'evt_dup' } as never);
    expect(all).toHaveLength(1);
  });
});

describe('EC:C3 usage.record — timestamps are UTC', () => {
  it('EC:C3 receivedAt comes from the injected Clock (UTC), not wall-clock time', async () => {
    const ids = new SequentialIdGen('id_');
    const fixed = new Date('2026-05-20T12:34:56Z');
    const clock = new FixedClock(fixed);
    const repo = new InMemoryRepo();
    const sub = mkSub();

    const r = await record({
      event: { customerId: sub.customerId, meter: 'api_call', quantity: 1, occurredAt: new Date('2026-05-20T00:00:00Z'), idempotencyKey: 'evt_utc' },
      sub, policy: basePolicy, repo, clock, ids,
    });

    expect(r.event.receivedAt.toISOString()).toBe('2026-05-20T12:34:56.000Z');
  });
});

describe('EC:C7 usage.record — meta stored verbatim', () => {
  it('EC:C7 event.meta round-trips exactly as passed (requestId/ip/etc.)', async () => {
    const ids = new SequentialIdGen('id_');
    const clock = new FixedClock(new Date('2026-05-15T00:00:00Z'));
    const repo = new InMemoryRepo();
    const sub = mkSub();
    const meta = { requestId: 'req_123', ip: '1.2.3.4', userAgent: 'test-agent' };

    const r = await record({
      event: { customerId: sub.customerId, meter: 'api_call', quantity: 1, occurredAt: new Date('2026-05-15T00:00:00Z'), idempotencyKey: 'evt_meta', meta },
      sub, policy: basePolicy, repo, clock, ids,
    });

    expect(r.event.meta).toEqual(meta);
  });

  it('EC:C7 event.meta defaults to null when omitted', async () => {
    const ids = new SequentialIdGen('id_');
    const clock = new FixedClock(new Date('2026-05-15T00:00:00Z'));
    const repo = new InMemoryRepo();
    const sub = mkSub();

    const r = await record({
      event: { customerId: sub.customerId, meter: 'api_call', quantity: 1, occurredAt: new Date('2026-05-15T00:00:00Z'), idempotencyKey: 'evt_no_meta' },
      sub, policy: basePolicy, repo, clock, ids,
    });

    expect(r.event.meta).toBeNull();
  });
});

describe('EC:C4 usage.record — outbox enqueue for provider usage reporting', () => {
  it('EC:C4 enqueues a pending usage.report outbox item when provider.capabilities().meters is true', async () => {
    const ids = new SequentialIdGen('id_');
    const clock = new FixedClock(new Date('2026-05-15T00:00:00Z'));
    const repo = new InMemoryRepo();
    const sub = mkSub();
    const provider = new FakeProvider({ meters: true });

    await record({
      event: { customerId: sub.customerId, meter: 'api_call', quantity: 7, occurredAt: new Date('2026-05-15T00:00:00Z'), idempotencyKey: 'evt_meters' },
      sub, policy: basePolicy, repo, clock, ids, provider,
    });

    const outbox = await repo.outbox.list({ kind: 'usage.report' } as never);
    expect(outbox).toHaveLength(1);
    expect(outbox[0].status).toBe('pending');
    expect(outbox[0].attempts).toBe(0);
    expect(outbox[0].payload).toMatchObject({ customerId: 'cust_1', meter: 'api_call', quantity: 7, provider: 'stripe' });
    expect(provider.reportUsageCalls).toHaveLength(0); // record() only enqueues, never calls the provider itself
  });

  it('EC:C4 does NOT enqueue an outbox item when provider.capabilities().meters is false', async () => {
    const ids = new SequentialIdGen('id_');
    const clock = new FixedClock(new Date('2026-05-15T00:00:00Z'));
    const repo = new InMemoryRepo();
    const sub = mkSub();
    const provider = new FakeProvider({ meters: false });

    await record({
      event: { customerId: sub.customerId, meter: 'api_call', quantity: 1, occurredAt: new Date('2026-05-15T00:00:00Z'), idempotencyKey: 'evt_no_meters' },
      sub, policy: basePolicy, repo, clock, ids, provider,
    });

    const outbox = await repo.outbox.list({ kind: 'usage.report' } as never);
    expect(outbox).toHaveLength(0);
  });

  it('EC:C4 does NOT enqueue an outbox item when no provider is passed', async () => {
    const ids = new SequentialIdGen('id_');
    const clock = new FixedClock(new Date('2026-05-15T00:00:00Z'));
    const repo = new InMemoryRepo();
    const sub = mkSub();

    await record({
      event: { customerId: sub.customerId, meter: 'api_call', quantity: 1, occurredAt: new Date('2026-05-15T00:00:00Z'), idempotencyKey: 'evt_no_provider' },
      sub, policy: basePolicy, repo, clock, ids,
    });

    const outbox = await repo.outbox.list({ kind: 'usage.report' } as never);
    expect(outbox).toHaveLength(0);
  });
});
