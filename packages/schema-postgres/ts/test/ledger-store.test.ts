// [EC:B12 B14 B3 B4 B15 H3 H4] PostgresLedgerStore + consistencyCheck regression coverage.
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Customer } from 'boilpayment-core';
import { PostgresLedgerStore, PostgresRepo, consistencyCheck } from '../dist/index.js';
import { createTestDb, dropTestDb, type TestDb } from './db-helper.js';

describe('PostgresLedgerStore', () => {
  let db: TestDb;
  let ledger: PostgresLedgerStore;
  let repo: PostgresRepo;

  beforeAll(async () => {
    db = await createTestDb('ledger');
    ledger = new PostgresLedgerStore(db.pool);
    repo = new PostgresRepo(db.pool);
  });

  afterAll(async () => {
    await dropTestDb(db);
  });

  async function makeCustomer(): Promise<string> {
    const id = `cust_${randomUUID()}`;
    const customer: Customer = { id, email: null, providerRefs: [], status: 'active', createdAt: new Date() };
    await repo.customers.put(customer);
    return id;
  }

  it('[EC:B12] append() with a repeated idempotency_key returns the existing row, duplicated=true, no second row', async () => {
    const customerId = await makeCustomer();
    const key = `grant:${randomUUID()}`;
    const first = await ledger.append({
      customerId, pool: 'paid', kind: 'grant', amount: 100, unitPriceMinor: 10, currency: 'USD',
      expiresAt: null, source: 'subscription', reference: {}, idempotencyKey: key, actor: 'system', reason: null,
    });
    const second = await ledger.append({
      customerId, pool: 'paid', kind: 'grant', amount: 999, unitPriceMinor: 999, currency: 'USD',
      expiresAt: null, source: 'subscription', reference: {}, idempotencyKey: key, actor: 'system', reason: null,
    });
    expect(first.duplicated).toBe(false);
    expect(second.duplicated).toBe(true);
    expect(second.entry.id).toBe(first.entry.id);
    expect(second.entry.amount).toBe(100); // not the 999 from the "second" call — proves no new row written
    const rows = await db.pool.query('select count(*)::int as n from ledger_entries where idempotency_key = $1', [key]);
    expect(rows.rows[0].n).toBe(1);
  });

  it('[EC:B12] consume() with a repeated idempotency_key returns the existing rows, duplicated=true, no new rows', async () => {
    const customerId = await makeCustomer();
    await ledger.append({
      customerId, pool: 'paid', kind: 'grant', amount: 100, unitPriceMinor: 1, currency: 'USD',
      expiresAt: null, source: 'subscription', reference: {}, idempotencyKey: `grant:${randomUUID()}`, actor: 'system', reason: null,
    });
    const key = `consume:${randomUUID()}`;
    const now = new Date();
    const first = await ledger.consume({
      customerId, poolOrder: ['paid'], amount: 30, idempotencyKey: key, meta: {}, now,
      negativeBalance: 'block', negativeFloor: 0,
    });
    const second = await ledger.consume({
      customerId, poolOrder: ['paid'], amount: 30, idempotencyKey: key, meta: {}, now,
      negativeBalance: 'block', negativeFloor: 0,
    });
    expect(first.duplicated).toBe(false);
    expect(second.duplicated).toBe(true);
    expect(second.entries.map((e) => e.id)).toEqual(first.entries.map((e) => e.id));
    const rows = await db.pool.query(
      `select count(*)::int as n from ledger_entries where consume_key = $1`, // EC:B21 B23 — every row of a consume carries its key here
      [key],
    );
    expect(rows.rows[0].n).toBe(first.entries.length);
  });

  it('[EC:B3 B14] consume() drains grant buckets FIFO by expiry, skipping already-expired grants', async () => {
    const customerId = await makeCustomer();
    const now = new Date();
    const past = new Date(now.getTime() - 60_000); // already expired
    const soon = new Date(now.getTime() + 60_000);
    const later = new Date(now.getTime() + 3_600_000);
    // expired grant must be invisible to consume (EC:B14) even though it's "first" by expiry order.
    await ledger.append({
      customerId, pool: 'paid', kind: 'grant', amount: 40, unitPriceMinor: 1, currency: 'USD',
      expiresAt: past, source: 'subscription', reference: {}, idempotencyKey: `g_expired_${randomUUID()}`, actor: 'system', reason: null,
    });
    const gSoon = await ledger.append({
      customerId, pool: 'paid', kind: 'grant', amount: 20, unitPriceMinor: 1, currency: 'USD',
      expiresAt: soon, source: 'subscription', reference: {}, idempotencyKey: `g_soon_${randomUUID()}`, actor: 'system', reason: null,
    });
    const gLater = await ledger.append({
      customerId, pool: 'paid', kind: 'grant', amount: 20, unitPriceMinor: 1, currency: 'USD',
      expiresAt: later, source: 'subscription', reference: {}, idempotencyKey: `g_later_${randomUUID()}`, actor: 'system', reason: null,
    });
    const result = await ledger.consume({
      customerId, poolOrder: ['paid'], amount: 25, idempotencyKey: `consume_${randomUUID()}`, meta: {}, now,
      negativeBalance: 'block', negativeFloor: 0,
    });
    expect(result.ok).toBe(true);
    expect(result.shortfall).toBe(0);
    // must draw 20 from the soon-expiring grant first, then 5 from the later grant — never touches the expired one.
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].reference.grantId).toBe(gSoon.entry.id);
    expect(result.entries[0].amount).toBe(-20);
    expect(result.entries[1].reference.grantId).toBe(gLater.entry.id);
    expect(result.entries[1].amount).toBe(-5);
  });

  it('[EC:B4] negative_balance="block" rejects atomically: ok=false, no rows written, balance unchanged', async () => {
    const customerId = await makeCustomer();
    await ledger.append({
      customerId, pool: 'paid', kind: 'grant', amount: 10, unitPriceMinor: 1, currency: 'USD',
      expiresAt: null, source: 'subscription', reference: {}, idempotencyKey: `g_${randomUUID()}`, actor: 'system', reason: null,
    });
    const before = await ledger.balance(customerId, undefined, new Date());
    const result = await ledger.consume({
      customerId, poolOrder: ['paid'], amount: 999, idempotencyKey: `consume_${randomUUID()}`, meta: {}, now: new Date(),
      negativeBalance: 'block', negativeFloor: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.entries).toHaveLength(0);
    expect(result.shortfall).toBe(989);
    const after = await ledger.balance(customerId, undefined, new Date());
    expect(after.available).toBe(before.available);
  });

  it('[EC:B4] negative_balance="allow_to_floor" with an empty pool draws overflow down to (and not past) the floor', async () => {
    // Empty pools -> drawnSoFar=0, so PostgresLedgerStore and InMemoryLedger agree here (see
    // consume-parity.test.ts for the discovered divergence when buckets are non-empty).
    const customerId = await makeCustomer();
    const now = new Date();
    const ok = await ledger.consume({
      customerId, poolOrder: ['paid'], amount: 500, idempotencyKey: `consume_${randomUUID()}`, meta: {}, now,
      negativeBalance: 'allow_to_floor', negativeFloor: -500,
    });
    expect(ok.ok).toBe(true);
    expect(ok.entries).toHaveLength(1);
    expect(ok.entries[0].amount).toBe(-500);
    const bal = await ledger.balance(customerId, undefined, new Date());
    expect(bal.available).toBe(-500);

    const rejected = await ledger.consume({
      customerId, poolOrder: ['paid'], amount: 1, idempotencyKey: `consume_${randomUUID()}`, meta: {}, now,
      negativeBalance: 'allow_to_floor', negativeFloor: -500,
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.entries).toHaveLength(0);
    const balAfter = await ledger.balance(customerId, undefined, new Date());
    expect(balAfter.available).toBe(-500); // rejected consume must not move the balance further
  });

  it('[EC:H3] direct UPDATE on ledger_entries is rejected by the append-only trigger', async () => {
    const customerId = await makeCustomer();
    const { entry } = await ledger.append({
      customerId, pool: 'paid', kind: 'grant', amount: 10, unitPriceMinor: 1, currency: 'USD',
      expiresAt: null, source: 'subscription', reference: {}, idempotencyKey: `g_${randomUUID()}`, actor: 'system', reason: null,
    });
    await expect(
      db.pool.query('update ledger_entries set amount = 999999 where id = $1', [entry.id]),
    ).rejects.toThrow(/append-only/);
  });

  it('[EC:H3] direct DELETE on ledger_entries is rejected by the append-only trigger', async () => {
    const customerId = await makeCustomer();
    const { entry } = await ledger.append({
      customerId, pool: 'paid', kind: 'grant', amount: 10, unitPriceMinor: 1, currency: 'USD',
      expiresAt: null, source: 'subscription', reference: {}, idempotencyKey: `g_${randomUUID()}`, actor: 'system', reason: null,
    });
    await expect(
      db.pool.query('delete from ledger_entries where id = $1', [entry.id]),
    ).rejects.toThrow(/append-only/);
  });

  it('[EC:B15] credit_balances snapshot regression: a fully-drained expiring lot resets expiring to empty, not stale', async () => {
    const customerId = await makeCustomer();
    const soon = new Date(Date.now() + 60_000);
    await ledger.append({
      customerId, pool: 'paid', kind: 'grant', amount: 10, unitPriceMinor: 1, currency: 'USD',
      expiresAt: soon, source: 'subscription', reference: {}, idempotencyKey: `g_${randomUUID()}`, actor: 'system', reason: null,
    });
    const midBalance = await ledger.balance(customerId, 'paid', new Date());
    expect(midBalance.expiring).toHaveLength(1);
    expect(midBalance.expiring[0].amount).toBe(10);

    // fully drain the grant
    await ledger.consume({
      customerId, poolOrder: ['paid'], amount: 10, idempotencyKey: `consume_${randomUUID()}`, meta: {}, now: new Date(),
      negativeBalance: 'block', negativeFloor: 0,
    });
    const finalBalance = await ledger.balance(customerId, 'paid', new Date());
    expect(finalBalance.available).toBe(0);
    expect(finalBalance.expiring).toHaveLength(0); // regression: must not keep the stale pre-drain bucket
  });

  it('[EC:H4] consistencyCheck() reports 0 mismatches after a sequence of grant/consume/expire-eligible activity', async () => {
    const customerId = await makeCustomer();
    const past = new Date(Date.now() - 60_000);
    await ledger.append({
      customerId, pool: 'paid', kind: 'grant', amount: 50, unitPriceMinor: 1, currency: 'USD',
      expiresAt: null, source: 'subscription', reference: {}, idempotencyKey: `g1_${randomUUID()}`, actor: 'system', reason: null,
    });
    await ledger.append({
      customerId, pool: 'promo', kind: 'grant', amount: 20, unitPriceMinor: 0, currency: 'USD',
      expiresAt: past, source: 'promo', reference: {}, idempotencyKey: `g2_${randomUUID()}`, actor: 'system', reason: null,
    });
    await ledger.consume({
      customerId, poolOrder: ['paid'], amount: 15, idempotencyKey: `consume_${randomUUID()}`, meta: {}, now: new Date(),
      negativeBalance: 'block', negativeFloor: 0,
    });
    const mismatches = await consistencyCheck(db.pool);
    const mine = mismatches.filter((m) => m.customerId === customerId);
    expect(mine).toEqual([]);
  });
});
