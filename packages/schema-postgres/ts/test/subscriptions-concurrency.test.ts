// [EC:K1] optimistic lock on `subscriptions` — an upgrade racing a renewal webhook (or any two
// independent writers) must not silently lose one of the two writes. `PostgresRepo.subscriptions.put`
// enforces the same contract as `VersionedMemTable` (packages/core/ts/src/memory.ts).
import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterAll } from 'vitest';
import { Pool } from 'pg';
import type { Customer, Subscription } from 'boilpayment-core';
import { PaymentKitError } from 'boilpayment-core';
import { PostgresRepo } from '../dist/index.js';
import { createTestDb, dropTestDb, type TestDb } from './db-helper.js';

function mkSub(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 'sub_1',
    customerId: 'cust_1',
    planId: 'plan_a',
    provider: 'stripe',
    providerRef: 'stripe_sub_1',
    status: 'active',
    currentPeriod: { start: new Date('2024-01-01T00:00:00.000Z'), end: new Date('2024-02-01T00:00:00.000Z') },
    anchorDay: 1,
    cancelAtPeriodEnd: false,
    graceUntil: null,
    billingKey: null,
    scheduledPlanId: null,
    version: 0,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('[EC:K1] subscriptions optimistic lock', () => {
  let db: TestDb;

  afterAll(async () => {
    if (db) await dropTestDb(db);
  });

  it('two INDEPENDENT reads of the same subscription racing each other: exactly one write succeeds, the other throws subscription_version_conflict', async () => {
    db = await createTestDb('subconcur');
    const repo = new PostgresRepo(db.pool);
    const customerId = `cust_${randomUUID()}`;
    const subId = `sub_${randomUUID()}`;
    await repo.customers.put({ id: customerId, email: null, providerRefs: [], status: 'active', createdAt: new Date() } satisfies Customer);
    await repo.plans.put({ id: 'plan_a', name: 'A', interval: 'month', creditsPerPeriod: 100, usageIncluded: 0, trialDays: 0, prices: [] });
    await repo.subscriptions.put(mkSub({ id: subId, customerId, providerRef: `pref_${subId}` }));

    // Two independent handles: each reads its own copy of the row (simulating an upgrade handler
    // and a renewal webhook both loading the subscription before either writes back).
    const handleA = await repo.subscriptions.get(subId);
    const handleB = await repo.subscriptions.get(subId);
    expect(handleA).not.toBeNull();
    expect(handleB).not.toBeNull();
    expect(handleA!.version).toBe(handleB!.version);

    const writeA = repo.subscriptions.put({ ...handleA!, status: 'past_due' });
    const writeB = repo.subscriptions.put({ ...handleB!, status: 'canceled' });

    const results = await Promise.allSettled([writeA, writeB]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const rejection = (rejected[0] as PromiseRejectedResult).reason;
    expect(rejection).toBeInstanceOf(PaymentKitError);
    expect(rejection.code).toBe('subscription_version_conflict');
    expect(rejection.details.expected).toBe(handleA!.version + 1);
    expect(rejection.details.got).toBe(handleA!.version);

    // The row now reflects exactly one of the two racing writes, at version = original + 1.
    const final = await repo.subscriptions.get(subId);
    expect(final!.version).toBe(handleA!.version + 1);
    expect(['past_due', 'canceled']).toContain(final!.status);
  });

  it('same-object read-once-write-twice: a function that reads once and calls put twice on the SAME object handle still succeeds both times', async () => {
    const repo = new PostgresRepo(db.pool);
    const customerId = `cust_${randomUUID()}`;
    const subId = `sub_${randomUUID()}`;
    await repo.customers.put({ id: customerId, email: null, providerRefs: [], status: 'active', createdAt: new Date() } satisfies Customer);
    const sub = mkSub({ id: subId, customerId, providerRef: `pref_${subId}` });

    await repo.subscriptions.put(sub); // insert — version stored as given (0), sub.version stays 0
    expect(sub.version).toBe(0);

    sub.status = 'past_due';
    const first = await repo.subscriptions.put(sub); // update: 0 -> 1, bumps sub.version in place
    expect(first.version).toBe(1);
    expect(sub.version).toBe(1);

    sub.status = 'canceled';
    const second = await repo.subscriptions.put(sub); // same object handle, second consecutive write: 1 -> 2
    expect(second.version).toBe(2);
    expect(second.status).toBe('canceled');
    expect(sub.version).toBe(2);
  });
});
