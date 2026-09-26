import { mkdtemp, writeFile, mkdir, symlink, copyFile, rm } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { generateAll } from '../../apps/cli/src/generate/index.js';
import { kitchenSinkConfig } from '../../apps/cli/test/helpers.js';
import { startMock, webhookSecret } from './step1-mock.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const folder = await mkdtemp(join(tmpdir(), 'paykit-step1-'));
const mock = await startMock();
const databaseName = process.argv.includes('--postgres') ? `paykit_step1_${randomUUID().replaceAll('-', '')}` : null;
const databaseUser = process.env.STEP1_POSTGRES_USER ?? userInfo().username;
const databaseUrl = databaseName ? `postgresql://${encodeURIComponent(databaseUser)}@127.0.0.1:5432/${databaseName}` : '';
let ownsDatabase = false;

async function run(command: string, args: string[]): Promise<void> {
  const child = spawn(command, args, { cwd: folder, stdio: 'inherit', env: { ...process.env, STEP1_MOCK_URL: mock.baseUrl, STEP1_WEBHOOK_SECRET: webhookSecret, STEP1_DATABASE_URL: databaseUrl } });
  await new Promise<void>((accept, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? accept() : reject(new Error(`Step 1 harness failed: ${command} (${code})`)));
  });
}

try {
  if (databaseName) {
    execFileSync('createdb', ['-h', '127.0.0.1', '-p', '5432', '-U', databaseUser, databaseName], { stdio: 'inherit' });
    ownsDatabase = true;
  }
  const config = kitchenSinkConfig();
  config.providers = ['portone'];
  config.cs.widget = false;
  config.infra.logging = 'none';
  config.infra.notify = { email: 'none', slack: false };
  config.policy.refund = { ...config.policy.refund, method: 'unused_credits', noQuestionsDays: 0, maxPerCustomerPerYear: 20 };
  config.policy.credits = { ...config.policy.credits, topupExpiryDays: null };
  config.policy.usage = { ...config.policy.usage, overage: 'bill_overage', includedQuantity: 5, overageUnitPriceMinor: 10 };
  config.policy.cs = { regrant: { mode: 'auto' }, autoApprove: { maxAmountMinor: 500, maxCredits: 1000 }, fraud: { refundVelocity: 20, windowDays: 30 } };
  config.plans = [
    { id: 'default', name: '100 credits', interval: null, creditsPerPeriod: 100, usageIncluded: 0, trialDays: 0, prices: [{ currency: 'KRW', amountMinor: 1000 }] },
    { id: 'metered', name: 'Step 1 usage', interval: 'month', creditsPerPeriod: 100, usageIncluded: 5, trialDays: 0, prices: [{ currency: 'KRW', amountMinor: 1000 }] },
  ];
  await generateAll(config, folder);
  await writeFile(join(folder, 'package.json'), JSON.stringify({ type: 'module' }));
  await mkdir(join(folder, 'node_modules'), { recursive: true });
  await symlink(join(root, 'packages/sdk/ts'), join(folder, 'node_modules/boilpayment-sdk'));
  await copyFile(join(here, 'step1-runtime.mjs'), join(folder, 'runtime.mjs'));
  if (!process.argv.includes('--python-only')) await run(join(root, 'apps/cli/node_modules/.bin/tsx'), ['runtime.mjs']);
  if (process.argv.includes('--python') || process.argv.includes('--python-only')) {
    await copyFile(join(here, 'step1_runtime.py'), join(folder, 'runtime.py'));
    await run(join(root, '.venv/bin/python'), ['runtime.py']);
  }
} finally {
  await mock.close();
  await rm(folder, { recursive: true, force: true });
  if (databaseName && ownsDatabase) execFileSync('dropdb', ['-h', '127.0.0.1', '-p', '5432', '-U', databaseUser, databaseName], { stdio: 'inherit' });
}
