// Store-parity check: run the exact same consume() scenarios against PostgresLedgerStore and
// InMemoryLedger (packages/core) and assert identical results. Per ARCHITECTURE.md this is the
// required cross-store regression: any divergence here is a real bug in one of the two stores.
//
// Two historical divergences (allow_to_floor room calc after a partial bucket draw; expired-but-not-
// batched grant counted in Postgres `available`) were fixed on both sides (core memory.* and
// sql/0002_credits.sql paykit_expired_remaining/paykit_available) and are pinned as scenarios E and F.
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Customer, LedgerStore } from '@schift/payment-kit-core';
import { InMemoryLedger } from '@schift/payment-kit-core';
import { PostgresLedgerStore, PostgresRepo } from '../dist/index.js';
import { createTestDb, dropTestDb, type TestDb } from './db-helper.js';

describe('store parity: PostgresLedgerStore vs InMemoryLedger', () => {
  let db: TestDb;
  let pg: PostgresLedgerStore;
  let repo: PostgresRepo;
  let mem: InMemoryLedger;

  beforeAll(async () => {
    db = await createTestDb('parity');
    pg = new PostgresLedgerStore(db.pool);
    repo = new PostgresRepo(db.pool);
    mem = new InMemoryLedger();
  });

  afterAll(async () => {
    await dropTestDb(db);
  });

  async function newCustomerPair(): Promise<{ pgId: string; memId: string }> {
    const pgId = `cust_pg_${randomUUID()}`;
    const memId = `cust_mem_${randomUUID()}`;
    const customer = (id: string): Customer => ({ id, email: null, providerRefs: [], status: 'active', createdAt: new Date() });
    await repo.customers.put(customer(pgId)); // FK: ledger_entries.customer_id -> customers.id
    return { pgId, memId };
  }

  function simplify(entries: { pool: string; amount: number }[]) {
    return entries.map((e) => ({ pool: e.pool, amount: e.amount }));
  }

  it('[EC:B3] scenario A — FIFO multi-pool consume: both stores drain in the same pool/amount order with equal final balance', async () => {
    const { pgId, memId } = await newCustomerPair();
    const now = new Date();
    const in1h = new Date(now.getTime() + 3_600_000);
    const in2h = new Date(now.getTime() + 7_200_000);

    for (const [store, customerId] of [[pg, pgId], [mem, memId]] as [LedgerStore, string][]) {
      await store.append({ customerId, pool: 'promo', kind: 'grant', amount: 40, unitPriceMinor: 0, currency: 'USD', expiresAt: in2h, source: 'promo', reference: {}, idempotencyKey: `gA1_${customerId}`, actor: 'system', reason: null });
      await store.append({ customerId, pool: 'paid', kind: 'grant', amount: 60, unitPriceMinor: 5, currency: 'USD', expiresAt: in1h, source: 'subscription', reference: {}, idempotencyKey: `gA2_${customerId}`, actor: 'system', reason: null });
    }

    const pgResult = await pg.consume({ customerId: pgId, poolOrder: ['promo', 'paid'], amount: 70, idempotencyKey: `cA_${pgId}`, meta: {}, now, negativeBalance: 'block', negativeFloor: 0 });
    const memResult = await mem.consume({ customerId: memId, poolOrder: ['promo', 'paid'], amount: 70, idempotencyKey: `cA_${memId}`, meta: {}, now, negativeBalance: 'block', negativeFloor: 0 });

    expect(pgResult.ok).toBe(true);
    expect(memResult.ok).toBe(true);
    expect(pgResult.shortfall).toBe(0);
    expect(memResult.shortfall).toBe(0);
    expect(simplify(pgResult.entries)).toEqual(simplify(memResult.entries));
    expect(simplify(pgResult.entries)).toEqual([{ pool: 'promo', amount: -40 }, { pool: 'paid', amount: -30 }]);

    const pgBal = await pg.balance(pgId, undefined, now);
    const memBal = await mem.balance(memId, undefined, now);
    expect(pgBal.available).toBe(memBal.available);
    expect(pgBal.available).toBe(30);
  });

  it('[EC:B4] scenario B — negativeBalance="block" rejects identically in both stores, no writes, balance unchanged', async () => {
    const { pgId, memId } = await newCustomerPair();
    const now = new Date();
    for (const [store, customerId] of [[pg, pgId], [mem, memId]] as [LedgerStore, string][]) {
      await store.append({ customerId, pool: 'paid', kind: 'grant', amount: 20, unitPriceMinor: 1, currency: 'USD', expiresAt: null, source: 'subscription', reference: {}, idempotencyKey: `gB_${customerId}`, actor: 'system', reason: null });
    }
    const pgResult = await pg.consume({ customerId: pgId, poolOrder: ['paid'], amount: 50, idempotencyKey: `cB_${pgId}`, meta: {}, now, negativeBalance: 'block', negativeFloor: 0 });
    const memResult = await mem.consume({ customerId: memId, poolOrder: ['paid'], amount: 50, idempotencyKey: `cB_${memId}`, meta: {}, now, negativeBalance: 'block', negativeFloor: 0 });

    expect(pgResult.ok).toBe(false);
    expect(memResult.ok).toBe(false);
    expect(pgResult.shortfall).toBe(memResult.shortfall);
    expect(pgResult.shortfall).toBe(30);

    const pgBal = await pg.balance(pgId, undefined, now);
    const memBal = await mem.balance(memId, undefined, now);
    expect(pgBal.available).toBe(20);
    expect(memBal.available).toBe(20);
  });

  it('[EC:B4] scenario C — negativeBalance="allow_to_floor" with empty pools (drawnSoFar=0): both stores agree', async () => {
    const { pgId, memId } = await newCustomerPair();
    const now = new Date();
    const pgFirst = await pg.consume({ customerId: pgId, poolOrder: ['paid'], amount: 500, idempotencyKey: `cC1_${pgId}`, meta: {}, now, negativeBalance: 'allow_to_floor', negativeFloor: -500 });
    const memFirst = await mem.consume({ customerId: memId, poolOrder: ['paid'], amount: 500, idempotencyKey: `cC1_${memId}`, meta: {}, now, negativeBalance: 'allow_to_floor', negativeFloor: -500 });
    expect(pgFirst.ok).toBe(true);
    expect(memFirst.ok).toBe(true);
    const pgBal1 = await pg.balance(pgId, undefined, now);
    const memBal1 = await mem.balance(memId, undefined, now);
    expect(pgBal1.available).toBe(memBal1.available);
    expect(pgBal1.available).toBe(-500);

    const pgSecond = await pg.consume({ customerId: pgId, poolOrder: ['paid'], amount: 1, idempotencyKey: `cC2_${pgId}`, meta: {}, now, negativeBalance: 'allow_to_floor', negativeFloor: -500 });
    const memSecond = await mem.consume({ customerId: memId, poolOrder: ['paid'], amount: 1, idempotencyKey: `cC2_${memId}`, meta: {}, now, negativeBalance: 'allow_to_floor', negativeFloor: -500 });
    expect(pgSecond.ok).toBe(false);
    expect(memSecond.ok).toBe(false);
  });

  it('[EC:B4] scenario D — negativeBalance="allow_unbounded" with a real bucket draw + overflow: both stores agree', async () => {
    const { pgId, memId } = await newCustomerPair();
    const now = new Date();
    for (const [store, customerId] of [[pg, pgId], [mem, memId]] as [LedgerStore, string][]) {
      await store.append({ customerId, pool: 'paid', kind: 'grant', amount: 10, unitPriceMinor: 1, currency: 'USD', expiresAt: null, source: 'subscription', reference: {}, idempotencyKey: `gD_${customerId}`, actor: 'system', reason: null });
    }
    const pgResult = await pg.consume({ customerId: pgId, poolOrder: ['paid'], amount: 50, idempotencyKey: `cD_${pgId}`, meta: {}, now, negativeBalance: 'allow_unbounded', negativeFloor: 0 });
    const memResult = await mem.consume({ customerId: memId, poolOrder: ['paid'], amount: 50, idempotencyKey: `cD_${memId}`, meta: {}, now, negativeBalance: 'allow_unbounded', negativeFloor: 0 });

    expect(pgResult.ok).toBe(true);
    expect(memResult.ok).toBe(true);
    expect(simplify(pgResult.entries)).toEqual(simplify(memResult.entries));
    expect(simplify(pgResult.entries)).toEqual([{ pool: 'paid', amount: -10 }, { pool: 'paid', amount: -40 }]);

    const pgBal = await pg.balance(pgId, undefined, now);
    const memBal = await mem.balance(memId, undefined, now);
    expect(pgBal.available).toBe(memBal.available);
    expect(pgBal.available).toBe(-40);
  });
  it('[EC:B4/B5] scenario E — allow_to_floor AFTER a partial bucket draw (grant 10, floor -1, consume 13): both stores reject', async () => {
    const { pgId, memId } = await newCustomerPair();
    const now = new Date();
    for (const [store, customerId] of [[pg, pgId], [mem, memId]] as [LedgerStore, string][]) {
      await store.append({ customerId, pool: 'paid', kind: 'grant', amount: 10, unitPriceMinor: 1, currency: 'USD', expiresAt: null, source: 'subscription', reference: {}, idempotencyKey: `gE_${customerId}`, actor: 'system', reason: null });
    }
    // allowed = max(0, currentTotal(10) - drawnSoFar(10) - floor(-1)) = 1 < remaining(3) -> reject, no writes
    const pgRes = await pg.consume({ customerId: pgId, poolOrder: ['paid'], amount: 13, idempotencyKey: `cE_${pgId}`, meta: {}, now, negativeBalance: 'allow_to_floor', negativeFloor: -1 });
    const memRes = await mem.consume({ customerId: memId, poolOrder: ['paid'], amount: 13, idempotencyKey: `cE_${memId}`, meta: {}, now, negativeBalance: 'allow_to_floor', negativeFloor: -1 });
    expect(pgRes.ok).toBe(false);
    expect(memRes.ok).toBe(false);
    expect(pgRes.shortfall).toBe(memRes.shortfall);
    expect(pgRes.entries).toEqual([]);
    expect(memRes.entries).toEqual([]);
    expect((await pg.balance(pgId, undefined, now)).available).toBe(10);
    expect((await mem.balance(memId, undefined, now)).available).toBe(10);
    // consume 11 fits: 10 from the bucket + 1 overflow down to the floor
    const pgOk = await pg.consume({ customerId: pgId, poolOrder: ['paid'], amount: 11, idempotencyKey: `cE2_${pgId}`, meta: {}, now, negativeBalance: 'allow_to_floor', negativeFloor: -1 });
    const memOk = await mem.consume({ customerId: memId, poolOrder: ['paid'], amount: 11, idempotencyKey: `cE2_${memId}`, meta: {}, now, negativeBalance: 'allow_to_floor', negativeFloor: -1 });
    expect(pgOk.ok).toBe(true);
    expect(memOk.ok).toBe(true);
    expect((await pg.balance(pgId, undefined, now)).available).toBe(-1);
    expect((await mem.balance(memId, undefined, now)).available).toBe(-1);
  });

  it('[EC:B14] scenario F — an expired-but-not-yet-batched grant is excluded from available and cannot be consumed, in both stores', async () => {
    const { pgId, memId } = await newCustomerPair();
    const now = new Date();
    const past = new Date(now.getTime() - 1000);
    for (const [store, customerId] of [[pg, pgId], [mem, memId]] as [LedgerStore, string][]) {
      await store.append({ customerId, pool: 'paid', kind: 'grant', amount: 100, unitPriceMinor: 1, currency: 'USD', expiresAt: past, source: 'subscription', reference: {}, idempotencyKey: `gF_${customerId}`, actor: 'system', reason: null });
      await store.append({ customerId, pool: 'paid', kind: 'grant', amount: 5, unitPriceMinor: 1, currency: 'USD', expiresAt: null, source: 'topup', reference: {}, idempotencyKey: `gF2_${customerId}`, actor: 'system', reason: null });
    }
    expect((await pg.balance(pgId, undefined, now)).available).toBe(5);
    expect((await mem.balance(memId, undefined, now)).available).toBe(5);
    const pgRes = await pg.consume({ customerId: pgId, poolOrder: ['paid'], amount: 10, idempotencyKey: `cF_${pgId}`, meta: {}, now, negativeBalance: 'block', negativeFloor: 0 });
    const memRes = await mem.consume({ customerId: memId, poolOrder: ['paid'], amount: 10, idempotencyKey: `cF_${memId}`, meta: {}, now, negativeBalance: 'block', negativeFloor: 0 });
    expect(pgRes.ok).toBe(false);
    expect(memRes.ok).toBe(false);
    expect(pgRes.shortfall).toBe(5);
    expect(memRes.shortfall).toBe(5);
  });
});
