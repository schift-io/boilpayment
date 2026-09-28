// EC:A72 (round-9 A9-12) — every model combination the wizard offers generates code that compiles
// (TS strict) and has no undefined names (Python), for every provider. A top-up-only app used to miss
// the PaymentKitError import its spend guard throws.
import { afterAll, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWizard } from '../src/wizard.js';
import { collectPlans } from '../src/plans.js';
import { toPaykitConfig } from '../src/wizard-state.js';
import { generateAll } from '../src/generate/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const combos = ['stripe', 'toss', 'portone', 'polar'].flatMap((provider) => [
  { provider, models: ['topup'], goods: ['credits'] },
  { provider, models: ['topup', 'usage'], goods: ['credits', 'usage_quota'] },
  { provider, models: ['subscription'], goods: ['usage_quota'] },
  { provider, models: ['subscription', 'topup'], goods: ['credits'] },
]);

it.each(combos)('$provider $models $goods compiles (TS strict) and has no undefined names (Py)', async ({ provider, models, goods }) => {
  const wizard = await runWizard({ yes: true, overrides: { providers: [provider] as never, models: models as never, goods: goods as never, languages: ['ts', 'py'] } });
  wizard.plans = await collectPlans(wizard, { yes: true });
  const config = toPaykitConfig(wizard);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paykit-combo-'));
  dirs.push(dir);
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  await generateAll(config, dir);
  await fs.mkdir(path.join(dir, 'node_modules'), { recursive: true });
  await fs.symlink(path.join(root, 'packages/sdk/ts'), path.join(dir, 'node_modules/boilpayment-sdk'), 'dir');
  await fs.writeFile(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, resolveJsonModule: true, esModuleInterop: true, skipLibCheck: true, noEmit: true }, include: ['paykit/index.ts'] }));
  const tsc = spawnSync(path.join(root, 'node_modules/.bin/tsc'), ['-p', path.join(dir, 'tsconfig.json')], { cwd: dir, encoding: 'utf8' });
  expect(tsc.status, tsc.stdout + tsc.stderr).toBe(0);
  const ruff = spawnSync(path.join(root, '.venv/bin/ruff'), ['check', '--no-cache', '--isolated', '--select', 'F821,F822,F823', path.join(dir, 'paykit/index.py')], { encoding: 'utf8' });
  expect(ruff.status, ruff.stdout + ruff.stderr).toBe(0);
}, 120_000);
