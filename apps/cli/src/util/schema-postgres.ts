// Shared loader for the kit's Postgres schema module. `migrate` applies migrations with it and
// `check` reads status with it, and they MUST agree: a `check` that inspects the database through
// a different path than `migrate` can report "fine" about a database `migrate` considers stale.
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PaykitConfig } from '../config.js';

/** The module names schema-postgres knows, derived from the same choices that copied the .sql files. */
export function modulesFor(config: PaykitConfig): string[] {
  const mods = ['core', 'webhook', 'refund'];
  if (config.goods.includes('credits')) mods.push('credits');
  if (config.models.includes('usage') || config.goods.includes('usage_quota')) mods.push('usage');
  mods.push('cs');
  return mods;
}

export interface SchemaStatusResult {
  expected: string[];
  applied: string[];
  pending: string[];
  unknown: string[];
  ok: boolean;
}

export type SchemaPostgres = {
  migrate(input: { connectionString: string; modules?: string[] }): Promise<{ applied: string[] }>;
  schemaStatus(input: { connectionString: string; modules?: string[] }): Promise<SchemaStatusResult>;
};

/**
 * Loaded lazily so `boilpayment init` never pays for `pg` and never fails when it is absent.
 *
 * Resolved from the PROJECT directory, not from wherever the CLI itself lives: the SDK is a
 * dependency of the user's app, and `npx paykit` may be running from a global cache that has no
 * relationship to it. Falls back to the CLI's own resolution so the monorepo keeps working.
 */
export async function loadSchemaPostgres(dir: string): Promise<SchemaPostgres | null> {
  const requireFromProject = createRequire(path.join(path.resolve(dir), 'package.json'));
  // These packages are ESM-only, so their `exports` has no `require` condition and CJS-style
  // subpath resolution fails outright. Locate the package by its package.json (which every one of
  // them exports for exactly this reason) and load the built file directly.
  const candidates: Array<[string, string]> = [
    ['boilpayment-sdk/package.json', 'dist/postgres.js'],
    ['boilpayment-schema-postgres/package.json', 'dist/index.js'],
  ];
  for (const [manifest, rel] of candidates) {
    try {
      const file = path.join(path.dirname(requireFromProject.resolve(manifest)), rel);
      return (await import(pathToFileURL(file).href)) as unknown as SchemaPostgres;
    } catch {
      /* not installed in the project — try the next one */
    }
  }
  // Monorepo / global-install fallback: resolve against the CLI's own dependencies.
  for (const id of ['boilpayment-sdk/postgres', 'boilpayment-schema-postgres']) {
    try {
      return (await import(id)) as unknown as SchemaPostgres;
    } catch {
      /* not resolvable from the CLI either */
    }
  }
  return null;
}
