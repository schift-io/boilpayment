#!/usr/bin/env node
// Copies packages/schema-postgres/sql/*.sql into apps/cli/templates/sql/ so the published
// npm package (which doesn't ship the rest of the monorepo) can still fall back to a real
// copy of the migrations. Run at build/publish time (see apps/cli/package.json).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(__dirname, '../../../packages/schema-postgres/sql');
const dest = path.resolve(__dirname, '../templates/sql');

async function main() {
  await fs.mkdir(dest, { recursive: true });
  let entries;
  try {
    entries = await fs.readdir(src);
  } catch {
    console.warn(`[sync-templates] source not found yet: ${src} (packages/schema-postgres 미완성 — skipping)`);
    return;
  }
  const sqlFiles = entries.filter((e) => e.endsWith('.sql'));
  if (sqlFiles.length === 0) {
    console.warn(`[sync-templates] no .sql files in ${src} yet — skipping`);
    return;
  }
  for (const file of sqlFiles) {
    await fs.copyFile(path.join(src, file), path.join(dest, file));
  }
  console.log(`[sync-templates] copied ${sqlFiles.length} file(s) from ${src} -> ${dest}`);
}

main().catch((err) => {
  console.error('[sync-templates] failed:', err);
  process.exit(1);
});
