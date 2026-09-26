import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { PaykitConfig } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// docs/ARCHITECTURE.md §5 — one file per module, wizard copies only the selected modules'.
const MODULE_FILES: { file: string; when: (c: PaykitConfig) => boolean }[] = [
  { file: '0001_core.sql', when: () => true },
  { file: '0002_credits.sql', when: (c) => c.goods.includes('credits') },
  { file: '0003_usage.sql', when: (c) => c.models.includes('usage') || c.goods.includes('usage_quota') },
  { file: '0004_webhook.sql', when: () => true },
  { file: '0005_refund.sql', when: () => true },
  { file: '0006_cs.sql', when: () => true },
  { file: '0007_subscription_provider_ref_nullable.sql', when: () => true },
];

async function dirHasSqlFiles(dir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir);
    return entries.some((e) => e.endsWith('.sql'));
  } catch {
    return false;
  }
}

async function resolveSqlSourceDir(): Promise<{ dir: string | null; reason: string }> {
  // 1. workspace package (built or source tree) — packages/schema-postgres/sql
  try {
    const pkgJsonPath = require.resolve('@schift/payment-kit-schema-postgres/package.json');
    const candidate = path.join(path.dirname(pkgJsonPath), '../sql');
    if (await dirHasSqlFiles(candidate)) return { dir: candidate, reason: 'workspace package' };
  } catch {
    // not resolvable yet — package.json may not export itself for `require.resolve` in ESM;
    // fall through to a direct relative guess from this file's location in the monorepo.
  }
  const monorepoGuess = path.resolve(__dirname, '../../../../packages/schema-postgres/sql');
  if (await dirHasSqlFiles(monorepoGuess)) return { dir: monorepoGuess, reason: 'monorepo relative path' };

  // 2. bundled template copy (synced at publish time via scripts/sync-templates.mjs)
  const bundled = path.resolve(__dirname, '../../templates/sql');
  if (await dirHasSqlFiles(bundled)) return { dir: bundled, reason: 'bundled templates' };

  return { dir: null, reason: 'not found' };
}

export interface MigrationsResult {
  written: string[];
  source: string;
}

export async function generateMigrations(config: PaykitConfig, outDir: string): Promise<MigrationsResult> {
  const wanted = MODULE_FILES.filter((m) => m.when(config)).map((m) => m.file);
  const { dir: sourceDir } = await resolveSqlSourceDir();
  if (!sourceDir) throw new MigrationSourceError('SQL migration source is missing. Reinstall the CLI with its bundled templates.');

  // Read every required migration before creating output, so missing sources cannot produce a partial schema.
  const sources = await Promise.all(wanted.map(async (file) => ({
    file,
    content: await fs.readFile(path.join(sourceDir, file)),
  })));
  const migrationsDir = path.join(outDir, 'migrations');
  await fs.mkdir(migrationsDir, { recursive: true });
  for (const { file, content } of sources) await fs.writeFile(path.join(migrationsDir, file), content);
  return { written: wanted, source: sourceDir };
}

class MigrationSourceError extends Error {
  override readonly name = 'MigrationSourceError';
}
