// EC:H4 — daily consistency check: ledger sum vs credit_balances snapshot, per (customer, pool).
import type { Pool } from 'pg';
import type { Pool as CreditPool } from '@schift/payment-kit-core';

export interface BalanceMismatch {
  customerId: string;
  pool: CreditPool;
  ledgerSum: number;
  snapshotAvailable: number;
  diff: number;
}

export async function consistencyCheck(pool: Pool): Promise<BalanceMismatch[]> {
  const res = await pool.query(`
    select le.customer_id, le.pool,
           sum(le.amount) - paykit_expired_remaining(le.customer_id, le.pool, now()) as ledger_sum,
           coalesce(cb.available, 0) as snapshot_available
    from ledger_entries le
    left join credit_balances cb on cb.customer_id = le.customer_id and cb.pool = le.pool
    group by le.customer_id, le.pool, cb.available
    having sum(le.amount) - paykit_expired_remaining(le.customer_id, le.pool, now()) <> coalesce(cb.available, 0)
  `);
  return res.rows.map((r: Record<string, unknown>) => ({
    customerId: r.customer_id as string,
    pool: r.pool as CreditPool,
    ledgerSum: Number(r.ledger_sum),
    snapshotAvailable: Number(r.snapshot_available),
    diff: Number(r.ledger_sum) - Number(r.snapshot_available),
  }));
}
