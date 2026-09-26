// `paykit check` — validate config + read-only DB/migration inspection. Never writes.
import path from 'node:path';
import pc from 'picocolors';
import { readConfig } from '../config.js';
import type { PaykitConfig } from '../config.js';
import { loadEnvFile } from '../util/env-file.js';
import { loadSchemaPostgres, modulesFor } from '../util/schema-postgres.js';
import { detectModuleSystem, ESM_REQUIRED_MESSAGE, ESM_MISSING_PACKAGE_JSON_MESSAGE } from '../util/module-system.js';

export interface CheckWarning {
  code: string;
  message: string;
}

export function computeWarnings(config: PaykitConfig, env: NodeJS.ProcessEnv = process.env): CheckWarning[] {
  const warnings: CheckWarning[] = [];
  const { policy } = config;

  if (config.cs.enabled && !env.PAYKIT_API_KEY?.trim()) {
    warnings.push({
      code: 'CS_API_KEY',
      message: 'CS 사용량 보고가 켜져 있는데 PAYKIT_API_KEY 가 설정되지 않았습니다. HttpLicenseReporter 없이는 케이스 사용량이 서버에 보고되지 않습니다 (docs/CS_SERVER.md).',
    });
  }

  if (policy.credits.rollover === 'banked' && policy.credits.bankCap === null) {
    warnings.push({ code: 'B1', message: 'credits.rollover=banked 인데 credits.bankCap 이 없습니다.' });
  }
  if (policy.usage.overage === 'bill_overage' && policy.usage.overageUnitPriceMinor === null) {
    warnings.push({ code: 'C1', message: 'usage.overage=bill_overage 인데 usage.overageUnitPriceMinor 가 없습니다.' });
  }
  if (config.providers.includes('toss')) {
    warnings.push({
      code: 'D13',
      message: 'Toss 가상계좌 환불은 refundReceiveAccount 입력이 필요합니다. 앱에서 환불 계좌 수집 화면을 연결하세요.',
    });
  }
  if ((config.providers.includes('toss') || config.providers.includes('portone')) && policy.cashReceipt.mode === 'off') {
    warnings.push({
      code: 'K2',
      message:
        '한국 provider(Toss/Portone) 가 선택되어 있는데 policy.cashReceipt.mode 가 off 입니다. ' +
        '현금영수증은 한국 B2C 결제의 법정 의무입니다 — 직접 관리 중이 아니라면 manual/auto 를 고려하세요.',
    });
  }
  if (config.providers.includes('polar') && policy.upgrade.mode === 'immediate_prorate_reset_anchor') {
    warnings.push({
      code: 'A1',
      message:
        'Polar 는 billing anchor 리셋을 지원하지 않습니다. upgrade.mode=immediate_prorate_reset_anchor 를 선택했지만 ' +
        'Polar 구독에서는 immediate_prorate_keep_anchor 처럼 동작합니다(기준일 유지).',
    });
  }
  const selfSchedulingProviders = config.providers.filter(
    (pr) => pr === 'toss' || (pr === 'portone' && config.infra.scheduler === 'self'),
  );
  if (config.models.includes('subscription') && selfSchedulingProviders.length > 0) {
    warnings.push({
      code: 'F(Toss/Portone self)',
      message: `${selfSchedulingProviders.join(', ')} 는 self 스케줄링입니다(Toss 는 항상 self, Portone 은 infra.scheduler 를 따름). ` +
        'cron.schedulerTick() (ts) / cron["scheduler_tick"] (py) 을 주기적으로 호출하는 크론 작업을 직접 구성해야 합니다.',
    });
  }
  if (config.models.includes('subscription') && policy.dunning.graceDays > 0 && !config.infra.notify.slack && config.infra.notify.email === 'none') {
    warnings.push({
      code: 'A13/A16',
      message: '갱신 실패 유예/최종실패 알림을 받을 채널(email/slack)이 없습니다. 고객·운영자 모두 못 받게 됩니다.',
    });
  }
  if (config.plans.length === 0) {
    warnings.push({ code: 'plans', message: 'plans[] 가 비어 있습니다. 최소 1개 플랜이 필요합니다.' });
  }
  if (config.infra.logging === 'none') {
    warnings.push({
      code: 'L1',
      message:
        'infra.logging=none 입니다. provider 왕복·오류가 어디에도 기록되지 않아, 결제 실패가 나면 ' +
        '무슨 일이 있었는지 재구성할 증거가 없습니다(docs/EDGE_CASES.md §L) — CS 조사가 이 로그에 ' +
        '의존합니다. postgres 또는 최소 console 을 고려하세요.',
    });
  }

  return warnings;
}

/** Missing native product mappings make generated checkout a draft, not a runnable sale. */
export function checkoutConfigurationErrors(config: PaykitConfig): string[] {
  const errors: string[] = [];
  if (config.plans.length === 0) errors.push('판매할 플랜을 plans에 등록하세요.');
  for (const plan of config.plans) {
    if (plan.prices.length === 0) errors.push(`${plan.name}: 판매 가격이 없습니다.`);
    if (config.providers.includes('toss') && !plan.prices.some((price) => price.currency === 'KRW')) errors.push(`${plan.name}: Toss 가격은 KRW로 설정하세요.`);
    for (const price of plan.prices) {
      for (const provider of config.providers) {
        if (provider !== 'stripe' && provider !== 'polar') continue;
        if (!price.providerPriceRefs?.[provider]?.trim()) errors.push(`${plan.name} ${price.currency}: ${provider}의 실제 ${provider === 'stripe' ? 'Price ID' : 'Product ID'}를 providerPriceRefs에 입력하세요.`);
      }
    }
  }
  return errors;
}

export interface DatabaseReport {
  lines: string[];
  /** false only when something is actually wrong — a skipped check is not a failure. */
  ok: boolean;
}

/**
 * Read-only database inspection.
 *
 * This goes through the same loader and the same `schemaStatus` call as `paykit migrate`, on
 * purpose. An earlier version opened its own `pg` client and listed the rows of
 * `paykit_migrations`, which meant it could only ever report what HAD been applied — never what
 * was still missing. A database three migrations behind produced a clean, green `paykit check`
 * and exit code 0, while `paykit migrate --dry-run` on the very same project said "3 pending".
 * The command whose whole job is "am I ready to run" must answer that question, not a weaker one.
 */
export async function checkDatabase(dir: string, config: PaykitConfig): Promise<DatabaseReport> {
  const lines: string[] = [];
  if (config.infra.database !== 'postgres') {
    lines.push(`database=${config.infra.database} — 조회할 마이그레이션이 없습니다 (skip).`);
    return { lines, ok: true };
  }

  // Same resolution order as `paykit migrate`: shell env wins, then the project's .env. Reading
  // only process.env made `check` say "DATABASE_URL 미설정" for projects where `migrate` connected.
  const { merged: env } = await loadEnvFile(path.join(dir, '.env'));
  const url = process.env.DATABASE_URL ?? env.DATABASE_URL;
  if (!url) {
    lines.push('DATABASE_URL 미설정 (환경변수에도 .env 에도 없음) — DB 조회 건너뜀 (skip).');
    return { lines, ok: true };
  }

  const sp = await loadSchemaPostgres(dir);
  if (!sp) {
    lines.push(
      pc.yellow('@schift/payment-kit-sdk 가 설치되어 있지 않아 DB 조회를 건너뜁니다. `npm install @schift/payment-kit-sdk` 후 다시 실행하세요.'),
    );
    return { lines, ok: true };
  }

  const modules = modulesFor(config);
  let status: Awaited<ReturnType<typeof sp.schemaStatus>>;
  try {
    status = await sp.schemaStatus({ connectionString: url, modules });
  } catch (err) {
    lines.push(pc.red(`DB 연결 실패: ${(err as Error).message}`));
    return { lines, ok: false };
  }

  lines.push(pc.green('DB 연결 OK.'));
  lines.push(`마이그레이션: 적용 ${status.applied.length} / 기대 ${status.expected.length}`);

  if (status.unknown.length > 0) {
    // The database was migrated by a newer build than the one installed here.
    lines.push(pc.red(`이 DB 는 현재 설치된 버전보다 앞서 있습니다 — DB 에만 있는 마이그레이션 ${status.unknown.length}건:`));
    for (const name of status.unknown) lines.push(`  ${name}`);
    lines.push('  패키지를 다운그레이드한 것으로 보입니다. 마이그레이션이 아니라 패키지 버전을 올리세요.');
  }
  if (status.pending.length > 0) {
    lines.push(pc.red(`미적용 ${status.pending.length}건:`));
    for (const name of status.pending) lines.push(`  ${name}`);
    lines.push(pc.bold('  → `npx paykit migrate` 로 적용하세요.'));
    lines.push('    적용 전에는 verifySchema() 가 부팅을 거부합니다 (INTEGRATION.md "버전을 올릴 때").');
  }
  if (status.ok) lines.push(pc.green('스키마가 이 빌드와 일치합니다.'));

  return { lines, ok: status.ok };
}

export async function runCheck(dir: string): Promise<void> {
  const config = await readConfig(dir);
  if (!config) {
    console.error(pc.red(`paykit.config.json 을 찾을 수 없습니다: ${dir}`));
    process.exitCode = 1;
    return;
  }

  console.log(pc.bold('paykit check'));
  console.log(pc.green('policy: 유효함 (resolvePolicy 통과).'));

  const checkoutErrors = checkoutConfigurationErrors(config);
  for (const error of checkoutErrors) console.error(pc.red(`checkout 초안: ${error}`));
  const warnings = computeWarnings(config);
  const moduleSystem = await detectModuleSystem(dir);
  if (moduleSystem !== 'esm') {
    warnings.push({
      code: 'ESM',
      message: moduleSystem === 'cjs' ? ESM_REQUIRED_MESSAGE : ESM_MISSING_PACKAGE_JSON_MESSAGE,
    });
  }
  if (warnings.length === 0) {
    console.log(pc.green('경고 없음.'));
  } else {
    console.log(pc.yellow(`경고 ${warnings.length}건:`));
    for (const w of warnings) console.log(`  [${w.code}] ${w.message}`);
  }

  console.log('');
  console.log(pc.bold('database'));
  const db = await checkDatabase(dir, config);
  for (const line of db.lines) console.log(`  ${line}`);
  // Warnings are advisory; a database that does not match this build is not. Exiting non-zero is
  // what makes `paykit check` usable as a deploy gate.
  if (!db.ok || checkoutErrors.length > 0) process.exitCode = 1;
}
