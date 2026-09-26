import { Pool } from 'pg';

export type { Pool };

/**
 * A `pg` connection pool from a connection string.
 *
 * This exists so a generated project never has to depend on `pg` (and `@types/pg`) directly just to
 * hand a pool to `PostgresRepo`/`PostgresLogger` — one install, not three. It mirrors the Python
 * side, where every store already takes a DSN string. Pass your own `Pool` instead whenever the app
 * already owns one; nothing here is special.
 */
export function createPool(connectionString: string, options: ConstructorParameters<typeof Pool>[0] = {}): Pool {
  return new Pool({ connectionString, ...options });
}
