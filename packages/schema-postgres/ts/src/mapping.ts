// Generic camelCase <-> snake_case + jsonb/Date conversion helpers, and a generic PgTable<T>
// built on top of them. Tables whose shape doesn't fit a flat row 1:1 (plans+plan_prices,
// cs_cases+policy_snapshots) get a hand-written Table instead — see repo.ts.
import type { Pool, PoolClient } from 'pg';
import type { Table } from 'boilpayment-core';
import { runner } from './tx.js';

export function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
}

export function snakeToCamel(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

/** node-pg does NOT auto-JSON.stringify objects/arrays for jsonb params (verified: passing a plain
 * array/object throws `invalid input syntax for type json` because pg's array-literal encoding
 * kicks in first) — every jsonb value must be wrapped explicitly before it reaches a query. */
export function jsonb(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

export interface PgTableOptions<T> {
  /** T -> flat snake_case column map. jsonb columns must already be JSON.stringify'd (use jsonb()). */
  toRow(t: T): Record<string, unknown>;
  /** raw pg row (jsonb already parsed to object, timestamptz already a Date) -> T */
  fromRow(row: Record<string, unknown>): T;
}

/** Generic Table<T> backed by one Postgres table with an `id text primary key` column and a plain
 * upsert-by-id `put`. Uses the active per-customer transaction client when called from inside one
 * (tx.ts), otherwise the pool. */
export class PgTable<T extends { id: string }> implements Table<T> {
  constructor(
    private readonly pool: Pool,
    private readonly tableName: string,
    private readonly opts: PgTableOptions<T>,
  ) {}

  private client(): Pool | PoolClient {
    return runner(this.pool);
  }

  async get(id: string): Promise<T | null> {
    const res = await this.client().query(`select * from ${this.tableName} where id = $1`, [id]);
    return res.rows[0] ? this.opts.fromRow(res.rows[0]) : null;
  }

  async put(row: T): Promise<T> {
    const data = this.opts.toRow(row);
    const cols = Object.keys(data);
    const values = cols.map((c) => data[c]);
    const placeholders = cols.map((_c, i) => `$${i + 1}`);
    const updates = cols.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`);
    const sql =
      `insert into ${this.tableName} (${cols.join(', ')}) values (${placeholders.join(', ')}) ` +
      `on conflict (id) do update set ${updates.join(', ')} returning *`;
    const res = await this.client().query(sql, values);
    return this.opts.fromRow(res.rows[0]);
  }

  async list(filter?: Partial<T>): Promise<T[]> {
    let sql = `select * from ${this.tableName}`;
    const params: unknown[] = [];
    const entries = Object.entries(filter ?? {}).filter(([, v]) => v !== undefined);
    if (entries.length) {
      const clauses = entries.map(([k, v]) => {
        params.push(v);
        return `${camelToSnake(k)} = $${params.length}`;
      });
      sql += ` where ${clauses.join(' and ')}`;
    }
    const res = await this.client().query(sql, params);
    return res.rows.map((r: Record<string, unknown>) => this.opts.fromRow(r));
  }
}
