// `boilpayment migrate` — apply the SDK's own migrations to the configured database.
//
// Why a command and not "run these .sql files with psql": applying them by hand does not record
// anything in `paykit_migrations`, so the next release cannot tell what is already there. It also
// gives the operator no way to answer the only question that matters at deploy time — is this
// database at the version this build expects?
import path from 'node:path';
import pc from 'picocolors';
import { readConfig } from '../config.js';
import { loadEnvFile } from '../util/env-file.js';
import { loadSchemaPostgres, modulesFor } from '../util/schema-postgres.js';

// Re-exported for callers that imported it from here before it was shared with `check`.
export { modulesFor };

export interface MigrateOptions {
  dryRun?: boolean;
  databaseUrl?: string;
}

export async function runMigrate(dir: string, opts: MigrateOptions = {}): Promise<void> {
  const config = await readConfig(dir);
  if (!config) {
    console.error(pc.red('paykit.config.json 을 찾을 수 없습니다. 먼저 `boilpayment init` 을 실행하세요.'));
    process.exitCode = 1;
    return;
  }
  if (config.infra.database !== 'postgres') {
    console.log(`database=${config.infra.database} — 적용할 마이그레이션이 없습니다.`);
    return;
  }

  const { merged: env } = await loadEnvFile(path.join(dir, '.env'));
  const connectionString = opts.databaseUrl ?? process.env.DATABASE_URL ?? env.DATABASE_URL;
  if (!connectionString) {
    console.error(pc.red('DATABASE_URL 이 없습니다. .env 에 넣거나 --database-url 로 넘기세요.'));
    process.exitCode = 1;
    return;
  }

  const sp = await loadSchemaPostgres(dir);
  if (!sp) {
    console.error(pc.red('마이그레이션 모듈(boilpayment-sdk/postgres)을 불러오지 못했습니다. CLI 를 다시 설치하세요.'));
    process.exitCode = 1;
    return;
  }

  const modules = modulesFor(config);
  const before = await sp.schemaStatus({ connectionString, modules });

  if (before.unknown.length > 0) {
    // Applying on top of a newer schema is how you get a half-migrated database.
    console.error(pc.red('이 데이터베이스는 현재 설치된 버전보다 앞서 있습니다.'));
    console.error(`  DB 에만 있는 마이그레이션: ${before.unknown.join(', ')}`);
    console.error('  패키지를 다운그레이드한 것으로 보입니다. 최소한 이 DB 를 마이그레이션한 버전 이상으로 올리세요.');
    process.exitCode = 1;
    return;
  }
  if (before.pending.length === 0) {
    console.log(pc.green(`이미 최신입니다 (적용됨 ${before.applied.length}건).`));
    return;
  }

  console.log(`적용 대기 ${before.pending.length}건:`);
  for (const name of before.pending) console.log(`  ${name}`);
  if (opts.dryRun) {
    console.log(pc.dim('\n--dry-run — 아무것도 적용하지 않았습니다.'));
    return;
  }

  const { applied } = await sp.migrate({ connectionString, modules });
  console.log(pc.green(`\n적용 완료 ${applied.length}건.`));
  const after = await sp.schemaStatus({ connectionString, modules });
  if (!after.ok) {
    console.error(pc.red(`적용 후에도 미적용이 남아 있습니다: ${after.pending.join(', ')}`));
    process.exitCode = 1;
  }
}
