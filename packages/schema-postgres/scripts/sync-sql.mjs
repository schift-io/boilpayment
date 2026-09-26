#!/usr/bin/env node
// Copies packages/schema-postgres/sql/*.sql into the Python package directory.
//
// Why a committed copy and not a build-time include: hatchling's `force-include "../sql"` only
// resolves when building straight from the source tree. `uv build` builds an sdist first and then
// the wheel FROM that sdist, where `../sql` does not exist — so the standard build fails. The same
// reason apps/cli keeps templates/sql/. Source of truth stays packages/schema-postgres/sql; this
// copy is generated, committed, and drift-checked by the py test suite.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(dir, '../sql');
const dest = path.resolve(dir, '../py/src/boilpayment_schema_postgres/sql');

await fs.mkdir(dest, { recursive: true });
const names = (await fs.readdir(src)).filter((f) => f.endsWith('.sql'));
for (const name of names) await fs.copyFile(path.join(src, name), path.join(dest, name));
for (const stale of await fs.readdir(dest)) {
  if (stale.endsWith('.sql') && !names.includes(stale)) await fs.rm(path.join(dest, stale));
}
console.log(`synced ${names.length} sql files -> ${path.relative(process.cwd(), dest)}`);
