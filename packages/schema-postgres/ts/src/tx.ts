// Per-customer transaction plumbing. EC:B5 — one advisory-lock transaction per customer, reused by
// nested calls (e.g. lifecycle.upgrade calling credits.grant_for_period calling ledger.append) via
// AsyncLocalStorage instead of opening a second pool connection and deadlocking.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient } from 'pg';

export interface TxContext {
  client: PoolClient;
  customerId: string;
}

const txStorage = new AsyncLocalStorage<TxContext>();

/** The client to run a query on: the active per-customer transaction's client if we're inside one
 * for this exact customerId, otherwise the pool itself (which checks out/releases per statement). */
export function runner(pool: Pool, customerId?: string): Pool | PoolClient {
  const ctx = txStorage.getStore();
  if (ctx && (customerId === undefined || ctx.customerId === customerId)) return ctx.client;
  return pool;
}

/** EC:B5 — SELECT ... FOR UPDATE / atomic consume all run inside this. Reentrant for the same
 * customerId: a nested call reuses the outer transaction's client and does not re-take the lock
 * (pg_advisory_xact_lock is per-session-and-key idempotent within one transaction anyway). */
export async function withCustomerTransaction<T>(
  pool: Pool,
  customerId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const existing = txStorage.getStore();
  if (existing && existing.customerId === customerId) {
    return fn();
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [customerId]);
    const result = await txStorage.run({ client, customerId }, fn);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // connection already broken; pool will discard it
    }
    throw err;
  } finally {
    client.release();
  }
}
