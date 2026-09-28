// `boilpayment init` — the wizard. Non-interactive path (--yes) must work with no TTY.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import * as p from '@clack/prompts';
import { runWizard, type WizardOptions } from '../wizard.js';
import { collectPlans } from '../plans.js';
import { checkoutConfigurationErrors } from './check.js';
import { toPaykitConfig } from '../wizard-state.js';
import { generateAll } from '../generate/index.js';
import type { ProviderName } from 'boilpayment-sdk/core';
import type { PaykitConfig } from '../config.js';
import { csv, type ParsedArgv } from '../util/argv.js';
import { detectModuleSystem, ESM_REQUIRED_MESSAGE, ESM_MISSING_PACKAGE_JSON_MESSAGE } from '../util/module-system.js';

async function readExistingRaw(configFlag: string | boolean | undefined, outDir: string): Promise<Record<string, unknown> | null> {
  if (!configFlag) return null;
  const file = typeof configFlag === 'string' ? configFlag : path.join(outDir, 'paykit.config.json');
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function runInit(argv: ParsedArgv): Promise<void> {
  const yes = Boolean(argv.flags.yes);
  const outDir = path.resolve(String(argv.flags.out ?? process.cwd()));

  const overrides: NonNullable<WizardOptions['overrides']> = {};
  const providers = csv(argv.flags.providers);
  if (providers) overrides.providers = providers as ProviderName[];
  const models = csv(argv.flags.models);
  if (models) overrides.models = models as PaykitConfig['models'];
  const languages = csv(argv.flags.languages);
  if (languages) overrides.languages = languages as PaykitConfig['languages'];
  const goods = csv(argv.flags.goods);
  if (goods) overrides.goods = goods as PaykitConfig['goods'];
  // --cs preselects the CS add-on as enabled (still asks cs_api_key and processing rules unless --yes).
  if (argv.flags.cs) overrides.cs = { enabled: true };

  const existingRaw = await readExistingRaw(argv.flags.config, outDir);

  const wizardConfig = await runWizard({ yes, existingRaw, overrides });
  wizardConfig.plans = await collectPlans(wizardConfig, { yes, existingRaw, overrides });

  const csApiKey = wizardConfig.csApiKey; // secret — read before toPaykitConfig strips transient fields
  const config = toPaykitConfig(wizardConfig);
  const result = await generateAll(config, outDir, { csApiKey });

  if (!yes) {
    p.note(result.writtenFiles.map((f) => path.relative(outDir, f)).join('\n'), '생성된 파일');
  } else {
    console.log(pc.green(`Generated ${result.writtenFiles.length} files in ${outDir}`));
    for (const f of result.writtenFiles) console.log(`  - ${path.relative(outDir, f)}`);
  }

  for (const error of checkoutConfigurationErrors(config)) console.log(pc.yellow(`판매 설정 초안: ${error}`));
  const moduleSystem = await detectModuleSystem(outDir);
  if (moduleSystem !== 'esm') {
    console.log('');
    console.log(pc.yellow(moduleSystem === 'cjs' ? ESM_REQUIRED_MESSAGE : ESM_MISSING_PACKAGE_JSON_MESSAGE));
  }

  console.log('');
  console.log(pc.bold('다음 단계 (Next steps):'));
  let step = 1;
  const installLines: string[] = [];
  if (config.languages.includes('ts')) installLines.push('npm install boilpayment-sdk');
  if (config.languages.includes('py')) installLines.push('pip install boilpayment');
  console.log(`  ${step++}. ${installLines.join('  &&  ')}  # 필요한 패키지 전부를 담은 단일 설치`);
  console.log(`  ${step++}. cp ${path.relative(outDir, result.envExampleFile)} .env  (그리고 실제 키 채우기)`);
  if (config.infra.database === 'postgres') {
    // Not "run the .sql files with psql": applying them by hand records nothing in
    // paykit_migrations, so the next release cannot tell what is already there.
    console.log(`  ${step++}. npx boilpayment migrate   # 마이그레이션 적용 (--dry-run 으로 먼저 확인 가능)`);
  }
  console.log(`  ${step++}. npx boilpayment check   # config 검증 + 스키마가 이 빌드와 맞는지 조회 (읽기 전용)`);
  if (config.situation?.existingCustomers) {
    // EC:M1 — the generated backfill brings in customers who were paying before the kit.
    const run = config.languages.includes('ts') ? 'npx tsx paykit/backfill.ts customers.csv' : 'python -m paykit.backfill customers.csv';
    console.log(`  ${step++}. ${run}   # 기존 고객 들이기 (열: paykit/backfill.example.csv, INTEGRATION.md 7절)`);
  }
}
