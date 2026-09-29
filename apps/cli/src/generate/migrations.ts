import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PaykitConfig } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// docs/ARCHITECTURE.md §5 — one file per module, wizard copies only the selected modules'.
const MODULE_FILES: { file: string; when: (c: PaykitConfig) => boolean }[] = [
  { file: '0001_core.sql', when: () => true },
  { file: '0002_credits.sql', when: (c) => c.goods.includes('credits') },
  { file: '0003_usage.sql', when: (c) => c.models.includes('usage') || c.goods.includes('usage_quota') },
  { file: '0004_webhook.sql', when: () => true },
  { file: '0005_refund.sql', when: () => true },
  { file: '0006_cs.sql', when: () => true },
  { file: '0007_subscription_provider_ref_nullable.sql', when: () => true },
  { file: '0008_iap.sql', when: (c) => c.providers.some((p) => p === 'apple' || p === 'google_play') }, // EC:N1
  // Round-5 audit Info I-1: the later module updates (same gating as schema-postgres MODULE_UPDATES), so a
  // project that applies paykit/migrations/ by hand reaches the schema this build verifies at boot.
  { file: '0009_ledger_idempotency_per_customer.sql', when: (c) => c.goods.includes('credits') }, // EC:B20
  { file: '0010_usage_idempotency_per_customer.sql', when: (c) => c.models.includes('usage') || c.goods.includes('usage_quota') },
  { file: '0011_subscription_status_paused_incomplete.sql', when: () => true }, // EC:A27
  { file: '0012_subscription_currency.sql', when: () => true }, // EC:A28
  { file: '0014_subscription_billing_customer_ref.sql', when: () => true }, // EC:A60
  { file: '0013_ledger_consume_key.sql', when: (c) => c.goods.includes('credits') }, // EC:B21
  { file: '0015_grace_credit_expiry.sql', when: (c) => c.goods.includes('credits') }, // SB-07
  { file: '0016_affiliate_commissions.sql', when: () => true }, // AF-01..04
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
  // 1. workspace source tree — packages/schema-postgres/sql
  const monorepoGuess = path.resolve(__dirname, '../../../../packages/schema-postgres/sql');
  if (await dirHasSqlFiles(monorepoGuess)) return { dir: monorepoGuess, reason: 'monorepo relative path' };

  // 2. bundled template copy (synced at build time via scripts/sync-templates.mjs)
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
