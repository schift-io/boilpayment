import { describe, it, expect, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { QUESTIONS } from '../src/questions.js';
import { generateEnvExample } from '../src/generate/env.js';
import { generateMigrations } from '../src/generate/migrations.js';
import { generatePolicyMd } from '../src/generate/policy-md.js';
import { generateAll } from '../src/generate/index.js';
import { buildConfig, kitchenSinkConfig, samplePlan } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..'); // apps/cli/test -> repo root

const cleanupDirs: string[] = [];
function tmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

// --- env ----------------------------------------------------------------------------------

describe('generateEnvExample', () => {
  it('includes PAYKIT_API_KEY with the real key when cs is enabled and a key was answered', () => {
    const config = buildConfig({ cs_enabled: true });
    const env = generateEnvExample(config, { csApiKey: 'pk_live_abc123' });
    expect(env).toContain('PAYKIT_API_KEY=pk_live_abc123');
  });

  it('falls back to a placeholder when cs is enabled but no key was answered', () => {
    const config = buildConfig({ cs_enabled: true });
    const env = generateEnvExample(config, {});
    expect(env).toContain('PAYKIT_API_KEY=pk_live_...');
  });

  it('omits PAYKIT_API_KEY entirely when cs is disabled', () => {
    const config = buildConfig({ cs_enabled: false });
    const env = generateEnvExample(config, { csApiKey: 'pk_live_abc123' });
    expect(env).not.toContain('PAYKIT_API_KEY');
  });
});

// --- migrations -----------------------------------------------------------------------------

describe('generateMigrations', () => {
  it('a credits+subscription-only config gets core/credits/webhook/refund/cs, not usage', async () => {
    const config = buildConfig({ providers: ['stripe'], models: ['subscription'], goods: ['credits'], cs_enabled: false });
    const dir = tmpDir('paykit-migrations-');
    const result = await generateMigrations(config, dir);
    const files = [...result.written].sort();
    expect(files).toEqual(['0001_core.sql', '0002_credits.sql', '0004_webhook.sql', '0005_refund.sql', '0006_cs.sql', '0007_subscription_provider_ref_nullable.sql',
      '0009_ledger_idempotency_per_customer.sql', '0011_subscription_status_paused_incomplete.sql', '0012_subscription_currency.sql', '0013_ledger_consume_key.sql', '0014_subscription_billing_customer_ref.sql']);
  });

  it('the kitchen-sink config (usage model + cs enabled) gets every non-IAP migration file (round-5 Info I-1: 0009-0013 too)', async () => {
    const config = kitchenSinkConfig();
    const dir = tmpDir('paykit-migrations-');
    const result = await generateMigrations(config, dir);
    const files = [...result.written].sort();
    expect(files).toEqual(['0001_core.sql', '0002_credits.sql', '0003_usage.sql', '0004_webhook.sql', '0005_refund.sql', '0006_cs.sql', '0007_subscription_provider_ref_nullable.sql',
      '0009_ledger_idempotency_per_customer.sql', '0010_usage_idempotency_per_customer.sql', '0011_subscription_status_paused_incomplete.sql', '0012_subscription_currency.sql', '0013_ledger_consume_key.sql', '0014_subscription_billing_customer_ref.sql']);
  });

  it('a usage_quota-only good (no usage model) also pulls in 0003_usage.sql', async () => {
    const config = buildConfig({ providers: ['stripe'], models: ['subscription'], goods: ['credits', 'usage_quota'] });
    const dir = tmpDir('paykit-migrations-');
    const result = await generateMigrations(config, dir);
    const files = [...result.written];
    expect(files).toContain('0003_usage.sql');
  });

  it('resolves the real workspace packages/schema-postgres/sql (not placeholders) in this repo', async () => {
    const config = kitchenSinkConfig();
    const dir = tmpDir('paykit-migrations-');
    const result = await generateMigrations(config, dir);
    expect(result.written).toHaveLength(13);
    for (const file of result.written) expect(await fs.readFile(path.join(dir, 'migrations', file), 'utf8')).toMatch(/create table|alter table|create unique index|drop index/i);
  });
});

// --- POLICY.md --------------------------------------------------------------------------------

describe('generatePolicyMd', () => {
  it('contains the EC id of every answered (when-gated) policy question, for the kitchen-sink config', () => {
    const config = kitchenSinkConfig();
    config.plans = [samplePlan({ trialDays: 14 })];
    const md = generatePolicyMd(config);
    const applicable = QUESTIONS.filter((q) => q.policyPath && (!q.when || q.when(config)));
    expect(applicable.length).toBeGreaterThan(20); // sanity: kitchen sink should trigger most questions

    const missing = applicable.filter((q) => !md.includes(`[EC:${q.ec.join(',')}] \`policy.${q.policyPath}\``));
    expect(missing.map((q) => q.id), `POLICY.md missing sections for: ${missing.map((q) => q.id).join(', ')}`).toEqual([]);
  });

  it('does not contain a section for a policy question gated off (e.g. usage.overage without the usage model)', () => {
    const config = buildConfig({ providers: ['stripe'], models: ['subscription'], goods: ['credits'] });
    const md = generatePolicyMd(config);
    const usageOverageQ = QUESTIONS.find((q) => q.id === 'usage_overage')!;
    expect(md).not.toContain(`\`policy.${usageOverageQ.policyPath}\``);
  });
});

// --- generated ts index typechecks against the real workspace packages ------------------------

const PKG_DIST: Record<string, string> = {
  // The generated paykit/index.ts imports exclusively from the single-install facade
  // (boilpayment-sdk/<subpath> — see ts-entry.ts) rather than the ten individual
  // packages, so this must actually resolve through the self-contained built facade. The facade
  // itself must be built before this test runs — see apps/cli/package.json's `pretest`.
  'boilpayment-sdk': 'packages/sdk/ts/dist',
};

describe('generated paykit/index.ts typechecks (temp-tsconfig against workspace dist)', () => {
  it('the kitchen-sink config generates ts that passes `tsc --noEmit`', async () => {
    const config = kitchenSinkConfig();
    const dir = tmpDir('paykit-typecheck-');
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    await generateAll(config, dir, { csApiKey: 'pk_live_test' });

    const tsconfigPath = path.join(dir, 'tsconfig.json');
    await fs.writeFile(
      tsconfigPath,
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          esModuleInterop: true,
          skipLibCheck: false,
          resolveJsonModule: true,
          noEmit: true,
          baseUrl: ROOT,
          paths: {
            ...Object.fromEntries(Object.entries(PKG_DIST).map(([name, dist]) => [name, [`${dist}/index.d.ts`]])),
            // Facade subpaths (boilpayment-sdk/core, /credits, /stripe, ...) — each compiles
            // to a same-named .d.ts under the facade's dist/ (see packages/sdk/ts/package.json exports).
            'boilpayment-sdk/*': ['packages/sdk/ts/dist/*.d.ts'],
          },
        },
        include: [path.join(dir, '**/*')],
      }),
    );

    const tsc = path.join(ROOT, 'node_modules/.bin/tsc');
    const result = spawnSync(tsc, ['--noEmit', '-p', tsconfigPath], { encoding: 'utf8' });
    expect(result.status, `tsc failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
  }, 60_000);
});

// --- generated paykit/index.py imports cleanly in .venv ----------------------------------------

describe('generated paykit/index.py imports in .venv', () => {
  it('the kitchen-sink config generates py that imports without error', async () => {
    const config = kitchenSinkConfig();
    const dir = tmpDir('paykit-pyimport-');
    await generateAll(config, dir, { csApiKey: 'pk_live_test' });

    const indexPy = path.join(dir, 'paykit', 'index.py');
    const python = path.join(ROOT, '.venv/bin/python');
    const code = `
import importlib.util
spec = importlib.util.spec_from_file_location("paykit_generated_index", ${JSON.stringify(indexPy)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
assert hasattr(mod, "create_payment_kit"), "create_payment_kit not defined"
print("OK")
`;
    const result = spawnSync(python, ['-c', code], { encoding: 'utf8' });
    expect(result.status, `python import failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('OK');
  }, 60_000);
});

describe('INTEGRATION.md — generated per config, and its symbols must exist in the generated code', () => {
  async function project(over: Record<string, unknown>): Promise<string> {
    const config = buildConfig(over);
    config.plans = [samplePlan()];
    const dir = tmpDir('paykit-integration-');
    await generateAll(config, dir, { csApiKey: 'pk_live_test' });
    return dir;
  }

  it('names only operations the generated kit actually exposes', async () => {
    const dir = await project({ providers: ['stripe'], models: ['subscription', 'usage'], languages: ['ts'], cs_enabled: true });
    const doc = await fs.readFile(path.join(dir, 'INTEGRATION.md'), 'utf8');
    const code = await fs.readFile(path.join(dir, 'paykit', 'index.ts'), 'utf8');
    // every `cron.x(` / `x(` the doc promises must be a symbol the generator actually emitted
    const promised = [...new Set([...doc.matchAll(/`(?:cron\.)?([a-zA-Z]+)\(/g)].map((m) => m[1]))];
    // Language builtins the doc legitimately names while explaining the host's own setup (e.g. why
    // `require()` fails against an ESM-only package). They are not claims about the kit's surface.
    const LANGUAGE_BUILTINS = new Set(['require', 'import']);
    const missing = promised.filter((sym) => !LANGUAGE_BUILTINS.has(sym) && !code.includes(sym));
    expect(missing, `INTEGRATION.md names symbols the kit does not expose: ${missing.join(', ')}`).toEqual([]);
    expect(promised.length).toBeGreaterThan(5); // the regex must actually be finding things
  });

  it('drops the sections whose choices were not made', async () => {
    const noCs = await fs.readFile(
      path.join(await project({ providers: ['stripe'], models: ['subscription'], languages: ['ts'], cs_enabled: false }), 'INTEGRATION.md'),
      'utf8',
    );
    expect(noCs).toContain('## 6. 환불과 미지급 처리');
    expect(noCs).not.toContain('schedulerTick'); // stripe schedules on its own side
    expect(noCs).not.toContain('closePeriods'); // no usage model selected

    const toss = await fs.readFile(
      path.join(await project({ providers: ['toss'], models: ['subscription'], languages: ['ts'], cs_enabled: false }), 'INTEGRATION.md'),
      'utf8',
    );
    // the two things a Toss integrator cannot afford to miss
    expect(toss).toContain('schedulerTick');
    expect(toss).toContain('승인(confirm)');
  });

  it('tells the reader to install exactly one package', async () => {
    const dir = await project({ providers: ['toss'], models: ['subscription'], languages: ['ts', 'py'], cs_enabled: false });
    const doc = await fs.readFile(path.join(dir, 'INTEGRATION.md'), 'utf8');
    expect(doc).toContain('npm i boilpayment-sdk');
    expect(doc).toContain('pip install boilpayment');
    expect(doc).not.toMatch(/boilpayment-(core|credits|lifecycle|refund|usage|webhook|cs)\b/);
  });
});
