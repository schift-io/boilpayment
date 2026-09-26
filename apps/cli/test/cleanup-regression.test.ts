import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_POLICY } from 'boilpayment-core';
import { emptyConfig } from '../src/config.js';
import { computeWarnings, runCheck } from '../src/commands/check.js';
import { generateIntegrationMd } from '../src/generate/integration-md.js';
import { main } from '../src/cli.js';
import { generateMigrations } from '../src/generate/migrations.js';
import { generatePolicyMd } from '../src/generate/policy-md.js';
import { generateAll } from '../src/generate/index.js';
import { toPaykitConfig } from '../src/wizard-state.js';
import { buildConfig, samplePlan } from './helpers.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = 0;
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paykit-cleanup-'));
  dirs.push(dir);
  return dir;
}

describe('wizard contract cleanup', () => {
  it('isolates configured policy from defaults and subsequent sessions', () => {
    // Given independent wizard sessions.
    const first = emptyConfig();
    const expected = DEFAULT_POLICY.refund.feeBearer;
    // When a seller changes one policy.
    first.policy.refund.feeBearer = 'customer';
    // Then future sessions retain the SDK default.
    expect(emptyConfig().policy.refund.feeBearer).toBe(expected);
    expect(DEFAULT_POLICY.refund.feeBearer).toBe(expected);
  });

  it('summarizes persisted refund and trial rules after transient answers are stripped', () => {
    // Given saved rules whose question-gating flags are absent from JSON.
    const config = buildConfig({ refund_advanced: true, refund_fee_bearer: 'customer', refund_max_per_customer_per_year: 2, trial_enabled: true });
    config.plans = [samplePlan({ trialDays: 14 })];
    // When generating the seller's rule summary.
    const md = generatePolicyMd(toPaykitConfig(config));
    // Then effective rules remain reviewable.
    expect(md).toContain('`policy.refund.feeBearer`');
    expect(md).toContain('`policy.refund.maxPerCustomerPerYear`');
    expect(md).toContain('`policy.trial.creditsOnConvert`');
  });

  it('rejects removed terms command instead of reporting stub success', async () => {
    // Given an invocation of the unimplemented command.
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // When routing the command.
    await main(['terms', '--country', 'KR', '--out', await tempDir()]);
    // Then it fails as unsupported.
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('알 수 없는 명령'));
  });

  it('fails when migration source cannot be read without creating placeholder SQL', async () => {
    // Given an unreadable required SQL source.
    const dir = await tempDir();
    vi.spyOn(fs, 'copyFile').mockRejectedValue(new Error('SQL unavailable'));
    const originalRead = fs.readFile;
    vi.spyOn(fs, 'readFile').mockImplementation((...args) => {
      if (String(args[0]).endsWith('.sql')) return Promise.reject(new Error('SQL unavailable'));
      return originalRead(...args);
    });
    // When generation attempts to use it.
    await expect(generateMigrations(buildConfig(), dir)).rejects.toThrow();
    // Then it does not create misleading output.
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('fails the public readiness check for a native-provider checkout draft', async () => {
    // Given generated rules without the merchant's actual Stripe Price ID.
    const config = buildConfig({ providers: ['stripe'] });
    config.plans = [samplePlan()];
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, 'paykit.config.json'), JSON.stringify(config));
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    vi.stubEnv('DATABASE_URL', '');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // When the seller checks readiness without a database connection.
    await runCheck(dir);
    // Then incomplete checkout configuration cannot appear ready.
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Price ID'));
  });

  it('does not require subscription scheduling for topup-only sellers', () => {
    // Given a Toss seller offering only credit topups.
    const config = buildConfig({ providers: ['toss'], models: ['topup'] });
    // When checking setup instructions.
    const warnings = computeWarnings(config, {});
    const integration = generateIntegrationMd(config);
    // Then no subscription scheduler is prescribed.
    expect(warnings.map((warning) => warning.code)).not.toContain('F(Toss/Portone self)');
    expect(integration).not.toContain('schedulerTick');
  });

  it('strips wizard secrets from programmatic generation just like the CLI command', async () => {
    // Given a caller passing the WizardConfig directly to the public generator.
    const config = buildConfig({ cs_enabled: true });
    config.csApiKey = 'pk_private_do_not_persist';
    const dir = await tempDir();
    // When the public generator writes configuration.
    const result = await generateAll(config, dir);
    // Then transient credentials never enter the versioned configuration file.
    expect(await fs.readFile(result.configFile, 'utf8')).not.toContain('pk_private_do_not_persist');
  });

  it('validates configured policy before writing generated files', async () => {
    // Given an invalid policy read from configuration JSON.
    const config = buildConfig();
    Object.assign(config.policy.refund, { method: 'unknown' });
    const dir = await tempDir();
    // When generating the project.
    await expect(generateAll(config, dir)).rejects.toThrow();
    // Then invalid rules never reach generated code or documentation.
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('includes dispute rules without optional usage reporting', () => {
    // Given a seller who has not enabled optional usage reporting.
    const config = buildConfig({ cs_enabled: false });
    // When producing the execution-rule summary.
    const md = generatePolicyMd(config);
    // Then the always-connected dispute rules remain reviewable.
    expect(md).toContain('`policy.dispute.onOpen`');
    expect(md).toContain('`policy.dispute.onLost`');
  });

  it('rejects unsupported widget configuration before writing files', async () => {
    // Given a legacy configuration requesting an unimplemented widget.
    const config = buildConfig({ cs_enabled: true });
    config.cs.widget = true;
    const dir = await tempDir();
    // When generating the project.
    await expect(generateAll(config, dir)).rejects.toThrow(/widget/i);
    // Then the existing output remains untouched.
    expect(await fs.readdir(dir)).toEqual([]);
  });
});
