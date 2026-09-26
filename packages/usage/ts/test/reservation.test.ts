// EC:C10 usage reservations — spec: packages/usage/spec/usage.pseudo.md
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, FixedClock, InMemoryLedger, InMemoryRepo, SequentialIdGen } from 'boilpayment-core';
import type { LedgerStore } from 'boilpayment-core';
import { commit, listReservations, release, reserve, sweepReservations } from '../src/reservation.js';

const policy = DEFAULT_POLICY;
const C = 'cust_1';

async function harness(credits = 100) {
  const ids = new SequentialIdGen('id_');
  const clock = new FixedClock(new Date('2026-05-15T00:00:00Z'));
  const ledger = new InMemoryLedger(ids, clock);
  const repo = new InMemoryRepo();
  await repo.customers.put({ id: C, email: null, providerRefs: [], status: 'active', createdAt: clock.now() });
  await ledger.append({
    customerId: C, pool: 'paid', kind: 'grant', amount: credits, unitPriceMinor: null, currency: null, expiresAt: null,
    source: 'manual', reference: {}, idempotencyKey: 'seed', actor: 'test', reason: 'seed',
  });
  const deps = { customerId: C, policy, ledger: ledger as LedgerStore, clock };
  return { clock, ledger, repo, deps };
}
const available = (ledger: InMemoryLedger, clock: FixedClock) => ledger.balance(C, undefined, clock.now()).then((b) => b.available);

describe('EC:C10 usage.reserve / commit / release', () => {
  it('reserve holds budget; a second job sees only what is left and gets a structured shortfall', async () => {
    const { clock, ledger, deps } = await harness(100);
    const a = await reserve({ ...deps, jobId: 'job_a', amount: 70 });
    expect(a).toMatchObject({ ok: true, duplicated: false, reservation: { status: 'held', amount: 70 } });
    expect(await available(ledger, clock)).toBe(30);
    const b = await reserve({ ...deps, jobId: 'job_b', amount: 40 });
    expect(b).toEqual({ ok: false, reason: 'insufficient', need: 40, available: 30 });
    expect(await available(ledger, clock)).toBe(30);
  });

  it('reserve is idempotent per job', async () => {
    const { clock, ledger, deps } = await harness(100);
    await reserve({ ...deps, jobId: 'job_a', amount: 70 });
    const again = await reserve({ ...deps, jobId: 'job_a', amount: 70 });
    expect(again).toMatchObject({ ok: true, duplicated: true });
    expect(await available(ledger, clock)).toBe(30);
  });

  it('commit charges the actual amount and returns the rest; a repeat commit changes nothing', async () => {
    const { clock, ledger, deps } = await harness(100);
    await reserve({ ...deps, jobId: 'job_a', amount: 70 });
    const done = await commit({ ...deps, jobId: 'job_a', amount: 45 });
    expect(done).toMatchObject({ duplicated: false, reservation: { status: 'committed', committedAmount: 45 } });
    expect(await available(ledger, clock)).toBe(55);
    const again = await commit({ ...deps, jobId: 'job_a', amount: 45 });
    expect(again.duplicated).toBe(true);
    expect(await available(ledger, clock)).toBe(55);
    const consumed = (await ledger.entries(C, { kind: 'consume' })).reduce((s, e) => s - e.amount, 0);
    expect(consumed).toBe(45);
  });

  it('commit above the reservation is refused and the hold stays', async () => {
    const { clock, ledger, deps } = await harness(100);
    await reserve({ ...deps, jobId: 'job_a', amount: 20 });
    await expect(commit({ ...deps, jobId: 'job_a', amount: 21 })).rejects.toMatchObject({ code: 'reservation_exceeded' });
    expect(await available(ledger, clock)).toBe(80);
  });

  it('release (job failed) charges nothing; commit after release is refused', async () => {
    const { clock, ledger, deps } = await harness(100);
    await reserve({ ...deps, jobId: 'job_a', amount: 70 });
    expect((await release({ ...deps, jobId: 'job_a' })).reservation.status).toBe('released');
    expect(await available(ledger, clock)).toBe(100);
    await expect(commit({ ...deps, jobId: 'job_a', amount: 10 })).rejects.toMatchObject({ code: 'reservation_closed' });
    expect((await release({ ...deps, jobId: 'job_a' })).duplicated).toBe(true);
  });

  it('commit of 0 is a release that records a zero charge', async () => {
    const { clock, ledger, deps } = await harness(100);
    await reserve({ ...deps, jobId: 'job_a', amount: 30 });
    const r = await commit({ ...deps, jobId: 'job_a', amount: 0 });
    expect(r.reservation).toMatchObject({ status: 'committed', committedAmount: 0 });
    expect(await available(ledger, clock)).toBe(100);
  });

  it('a reservation past its TTL is released by the sweep and can no longer be committed', async () => {
    const { clock, ledger, repo, deps } = await harness(100);
    await reserve({ ...deps, jobId: 'job_a', amount: 70 });
    clock.advance((policy.usage.reservationTtlMinutes + 1) * 60_000);
    expect(await sweepReservations({ repo, ledger, clock })).toEqual({ expired: 1 });
    expect(await available(ledger, clock)).toBe(100);
    await expect(commit({ ...deps, jobId: 'job_a', amount: 10 })).rejects.toMatchObject({ code: 'reservation_closed' });
    expect((await listReservations({ customerId: C, ledger }))[0].status).toBe('expired');
    expect(await sweepReservations({ repo, ledger, clock })).toEqual({ expired: 0 });
  });

  it('an expired, unswept hold is refused at commit and stops blocking new reservations', async () => {
    const { clock, ledger, deps } = await harness(100);
    await reserve({ ...deps, jobId: 'job_a', amount: 90 });
    clock.advance((policy.usage.reservationTtlMinutes + 1) * 60_000);
    await expect(commit({ ...deps, jobId: 'job_a', amount: 10 })).rejects.toMatchObject({ code: 'reservation_expired' });
    const b = await reserve({ ...deps, jobId: 'job_b', amount: 90 });
    expect(b.ok).toBe(true);
    expect(await available(ledger, clock)).toBe(10);
  });

  it('concurrent reserves for the last budget: exactly one wins', async () => {
    const { clock, ledger, deps } = await harness(100);
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => reserve({ ...deps, jobId: `job_${i}`, amount: 60 })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await available(ledger, clock)).toBe(40);
  });

  it('holds reduce what usage.check-style balance reads see, and rejects bad input', async () => {
    const { deps } = await harness(100);
    await expect(reserve({ ...deps, jobId: 'job_a', amount: 0 })).rejects.toMatchObject({ code: 'reservation_invalid' });
    await expect(reserve({ ...deps, jobId: '', amount: 1 })).rejects.toMatchObject({ code: 'reservation_invalid' });
    await expect(commit({ ...deps, jobId: 'nope', amount: 1 })).rejects.toMatchObject({ code: 'reservation_not_found' });
  });
});
