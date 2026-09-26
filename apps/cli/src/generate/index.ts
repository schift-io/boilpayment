// Orchestrates all generators. Writes into `outDir`:
//   paykit.config.json, POLICY.md, INTEGRATION.md, .env.example   (project root)
//   paykit/index.ts, paykit/index.py, paykit/webhook.ts, paykit/webhook.py, paykit/migrations/*.sql
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolvePolicy } from 'boilpayment-core';
import type { PaykitConfig } from '../config.js';
import { toPaykitConfig } from '../wizard-state.js';
import { writeConfig } from '../config.js';
import { generateIndexTs } from './ts-entry.js';
import { generateIndexPy } from './py-entry.js';
import { generateWebhookTs, generateWebhookPy } from './webhook.js';
import { generateMigrations, type MigrationsResult } from './migrations.js';
import { generateEnvExample } from './env.js';
import { generatePolicyMd } from './policy-md.js';
import { generateIntegrationMd } from './integration-md.js';

export interface GenerateResult {
  configFile: string;
  policyMdFile: string;
  envExampleFile: string;
  paykitDir: string;
  writtenFiles: string[];
  migrations: MigrationsResult;
}

export interface GenerateOptions {
  /** CS SDK API 키 (secret) — 위저드에서 답했으면 .env.example 에 실값으로 넣는다. paykit.config.json 에는 절대 저장 안 함. */
  csApiKey?: string;
}

export async function generateAll(config: PaykitConfig, outDir: string, opts: GenerateOptions = {}): Promise<GenerateResult> {
  config = { ...toPaykitConfig(config), policy: resolvePolicy(config.policy) };
  if (config.cs.widget) throw new UnsupportedGenerationError('CS widget generation is not implemented. Set cs.widget=false and integrate your customer support interface separately.');
  if (config.policy.cancel.credits === 'keep_forever') throw new UnsupportedGenerationError('cancel.credits=keep_forever is not supported. Select keep_until_period_end or revoke_immediately.');
  await fs.mkdir(outDir, { recursive: true });
  const paykitDir = path.join(outDir, 'paykit');
  await fs.mkdir(paykitDir, { recursive: true });

  const migrations = await generateMigrations(config, paykitDir);
  const writtenFiles: string[] = [];
  const writeFile = async (file: string, content: string) => {
    await fs.writeFile(file, content, 'utf8');
    writtenFiles.push(file);
  };

  const configFile = await writeConfig(outDir, config);
  writtenFiles.push(configFile);

  const policyMdFile = path.join(outDir, 'POLICY.md');
  await writeFile(policyMdFile, generatePolicyMd(config));

  const integrationMdFile = path.join(outDir, 'INTEGRATION.md');
  await writeFile(integrationMdFile, generateIntegrationMd(config));

  const envExampleFile = path.join(outDir, '.env.example');
  await writeFile(envExampleFile, generateEnvExample(config, { csApiKey: opts.csApiKey }));

  if (config.languages.includes('ts')) {
    await writeFile(path.join(paykitDir, 'index.ts'), generateIndexTs(config));
    await writeFile(path.join(paykitDir, 'webhook.ts'), generateWebhookTs(config));
  }
  if (config.languages.includes('py')) {
    await writeFile(path.join(paykitDir, 'index.py'), generateIndexPy(config));
    await writeFile(path.join(paykitDir, 'webhook.py'), generateWebhookPy(config));
    await writeFile(path.join(paykitDir, '__init__.py'), '');
  }

  return { configFile, policyMdFile, envExampleFile, paykitDir, writtenFiles, migrations };
}

class UnsupportedGenerationError extends Error {
  override readonly name = 'UnsupportedGenerationError';
}
