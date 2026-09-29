// Migration runner + SQL-file loader. See spec/schema-postgres.pseudo.md "Migrations".
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

// `npm pack`/`files` cannot include a path outside the package root (verified: a `files: ["../sql"]`
// entry is silently dropped from the tarball), so the build step copies the monorepo source of
// truth (packages/schema-postgres/sql/*.sql) into dist/sql — see ts/package.json "build" script.
// That makes dist/sql/*.sql resolve identically in the monorepo (after `pnpm build`) and once
// published (dist/ is the only thing `files` ships).
const SQL_DIR = fileURLToPath(new URL('./sql', import.meta.url));

export const MODULE_FILES: Record<string, string> = {
  core: '0001_core.sql',
  credits: '0002_credits.sql',
  usage: '0003_usage.sql',
  webhook: '0004_webhook.sql',
  refund: '0005_refund.sql',
  cs: '0006_cs.sql',
  iap: '0008_iap.sql', // EC:N1 — only for projects with an in-app purchase store
};

export interface MigrationFile {
  name: string;
  sql: string;
}

/** Loads the .sql text for the requested modules (default: all), always including 0001_core.sql
 * since every other module's tables FK into customers/subscriptions/payments. Sorted by filename
 * so base modules and subsequent core updates always apply in order. Used both by migrate() and by apps/cli to copy files into a
 * generated project's paykit/migrations/ without needing a live DB connection. */
/** Follow-up migrations of a module, applied with it (EC:B20: per-customer idempotency keys). */
export const MODULE_UPDATES: Record<string, readonly string[]> = {
  credits: ['0009_ledger_idempotency_per_customer.sql', '0013_ledger_consume_key.sql', '0015_grace_credit_expiry.sql'], // EC:B20 B21 SB-07
  usage: ['0010_usage_idempotency_per_customer.sql'],
  core: [
    '0011_subscription_status_paused_incomplete.sql',
    '0012_subscription_currency.sql',
    '0014_subscription_billing_customer_ref.sql',
    '0016_affiliate_commissions.sql',
  ], // EC:A27 A28 A60, AF-01..04
};

/** Modules applied only when asked for by name (EC:N1): a default `migrate()` keeps its schema. */
export const OPT_IN_MODULES: readonly string[] = ['iap'];

export function loadMigrations(modules?: string[]): MigrationFile[] {
  const wanted = modules && modules.length ? new Set(modules) : new Set(Object.keys(MODULE_FILES).filter((m) => !OPT_IN_MODULES.includes(m)));
  wanted.add('core');
  const files = readdirSync(SQL_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const wantedFiles = new Set(
    Object.entries(MODULE_FILES)
      .filter(([mod]) => wanted.has(mod))
      .map(([, file]) => file),
  );
  wantedFiles.add('0007_subscription_provider_ref_nullable.sql');
  for (const [mod, updates] of Object.entries(MODULE_UPDATES)) if (wanted.has(mod)) for (const f of updates) wantedFiles.add(f);
  return files
    .filter((f) => wantedFiles.has(f))
    .map((name) => ({ name, sql: readFileSync(`${SQL_DIR}/${name}`, 'utf8') }));
}

export interface MigrateInput {
  connectionString?: string;
  pool?: Pool;
  modules?: string[];
}

/** Applies the selected modules' migrations, tracked in paykit_migrations so re-running is a no-op.
 * Wrapped in an advisory lock so two concurrent `migrate()` calls (e.g. two app instances booting)
 * don't race on `create table if not exists`. */
export async function migrate(input: MigrateInput): Promise<{ applied: string[] }> {
  const pool = input.pool ?? new Pool({ connectionString: input.connectionString });
  const ownsPool = !input.pool;
  try {
    const client = await pool.connect();
    const applied: string[] = [];
    try {
      await client.query('BEGIN');
      await client.query("select pg_advisory_xact_lock(hashtext('paykit_migrations'))");
      await client.query(
        `create table if not exists paykit_migrations (name text primary key, applied_at timestamptz not null default now())`,
      );
      const existing = await client.query('select name from paykit_migrations');
      const done = new Set(existing.rows.map((r: { name: string }) => r.name));
      for (const file of loadMigrations(input.modules)) {
        if (done.has(file.name)) continue;
        await client.query(file.sql);
        await client.query('insert into paykit_migrations (name) values ($1)', [file.name]);
        applied.push(file.name);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    return { applied };
  } finally {
    if (ownsPool) await pool.end();
  }
}

export interface SchemaStatus {
  /** Migrations this build of the SDK ships for the requested modules, in apply order. */
  expected: string[];
  /** Already recorded in paykit_migrations. */
  applied: string[];
  /** Shipped but not applied — the DB is behind the code. */
  pending: string[];
  /** Applied but not shipped — the DB is AHEAD of the code (a downgrade, or a foreign kit). */
  unknown: string[];
  ok: boolean;
}

/**
 * What this build of the SDK expects vs what the database actually has.
 *
 * The failure this exists to prevent: upgrade the package, forget to migrate, and the first query
 * that touches a new column dies in production with `column "..." does not exist`. Call it once at
 * boot and refuse to start instead — a startup failure with a fix in the message beats a 3am
 * incident. Reading `paykit_migrations` is also how we detect a DB that is AHEAD of the code, which
 * a plain "run the pending ones" check would miss entirely.
 */
export async function schemaStatus(input: MigrateInput): Promise<SchemaStatus> {
  const pool = input.pool ?? new Pool({ connectionString: input.connectionString });
  const ownsPool = !input.pool;
  try {
    const expected = loadMigrations(input.modules).map((m) => m.name);
    const res = await pool.query(
      `select name from paykit_migrations order by name`,
    ).catch((err: { code?: string }) => {
      // 42P01 = undefined_table: nothing has ever been migrated here.
      if (err.code === '42P01') return { rows: [] as { name: string }[] };
      throw err;
    });
    const applied = res.rows.map((r: { name: string }) => r.name);
    const appliedSet = new Set(applied);
    const expectedSet = new Set(expected);
    const pending = expected.filter((n) => !appliedSet.has(n));
    const unknown = applied.filter((n) => !expectedSet.has(n));
    return { expected, applied, pending, unknown, ok: pending.length === 0 && unknown.length === 0 };
  } finally {
    if (ownsPool) await pool.end();
  }
}

/**
 * Throws unless the database matches this build. Call it at boot, before serving traffic.
 * The message names the exact command that fixes it — a schema error the operator cannot act on
 * is just noise.
 */
export async function verifySchema(input: MigrateInput): Promise<SchemaStatus> {
  const status = await schemaStatus(input);
  if (status.pending.length > 0) {
    throw new Error(
      `paykit: database is behind this build — ${status.pending.length} migration(s) not applied ` +
        `(${status.pending.join(', ')}). Run \`npx boilpayment migrate\` before starting.`,
    );
  }
  if (status.unknown.length > 0) {
    throw new Error(
      `paykit: database is AHEAD of this build — it has migration(s) this version does not ship ` +
        `(${status.unknown.join(', ')}). You likely downgraded the package; install a version at ` +
        `least as new as the one that migrated this database.`,
    );
  }
  return status;
}
