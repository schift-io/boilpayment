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

it('default --yes enables durable support and explicit plan initialization in both languages', async () => {
  // Given the real default wizard, without paid reporting or manually patched policy.
  const wizard = await runWizard({ yes: true, overrides: { languages: ['ts', 'py'] } });
  wizard.plans = await collectPlans(wizard, { yes: true });
  const config = toPaykitConfig(wizard);
  expect(config.cs.enabled).toBe(false);
  const configuredPlan = config.plans[0];
  const configuredPrice = configuredPlan?.prices[0];
  if (!configuredPrice) throw new Error('default wizard did not produce a plan price');
  configuredPrice.providerPriceRefs = { stripe: 'config-stripe' };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paykit-default-support-'));
  dirs.push(dir);
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  await generateAll(config, dir);
  await fs.mkdir(path.join(dir, 'node_modules'), { recursive: true });
  await fs.symlink(path.join(root, 'packages/sdk/ts'), path.join(dir, 'node_modules/boilpayment-sdk'), 'dir');
  await fs.writeFile(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, resolveJsonModule: true, esModuleInterop: true, skipLibCheck: true, noEmit: true }, include: ['paykit/index.ts'] }));
  await fs.writeFile(path.join(dir, 'run.ts'), `
import assert from 'node:assert/strict';
import { createPaymentKit } from './paykit/index.js';
import { InMemoryRepo, InMemoryLedger, FixedClock, SequentialIdGen, NoopLogger } from 'boilpayment-sdk/core';
import config from './paykit.config.json' with { type: 'json' };
const repo = new InMemoryRepo();
const clock = new FixedClock(new Date('2026-03-01T00:00:00Z'));
const ids = new SequentialIdGen('default');
const kit = createPaymentKit(config, { repo, clock, ids, ledger: new InMemoryLedger(ids, clock), providers: {}, logger: new NoopLogger(), env: { DATABASE_URL: '' } });
await kit.initialize({ verifySchema: false });
assert.equal((await repo.plans.list()).length, config.plans.length);
const configuredPlan = config.plans[0];
const storedPlan = configuredPlan ? await repo.plans.get(configuredPlan.id) : null;
assert.ok(storedPlan);
const firstPrice = storedPlan.prices[0];
assert.ok(firstPrice);
await repo.plans.put({
  ...storedPlan,
  prices: [{ ...firstPrice, providerPriceRefs: { stripe: 'db-stripe', polar: 'db-polar' } }, ...storedPlan.prices.slice(1)],
});
await kit.initialize({ verifySchema: false });
const mergedPlan = await repo.plans.get(storedPlan.id);
assert.deepEqual(mergedPlan?.prices[0]?.providerPriceRefs, { stripe: 'config-stripe', polar: 'db-polar' });
const result = await kit.support.requestRefund({ customerId: 'unknown', paymentId: 'unknown', requestId: 'reject-missing' });
assert.equal(result.status, 'rejected');
assert.equal((await repo.csCases.get(result.id)).status, 'rejected');
assert.deepEqual(await kit.cron.reconcile(new Date('2026-01-01')), []);
console.log('PASS');
`);
  await fs.writeFile(path.join(dir, 'run.py'), `
import asyncio, json
from datetime import datetime, timezone
from paykit.index import create_payment_kit
from boilpayment.core import Deps, InMemoryRepo, InMemoryLedger, FixedClock, SequentialIdGen, NoopLogger
async def main():
    repo = InMemoryRepo()
    clock = FixedClock(datetime(2026, 3, 1, tzinfo=timezone.utc))
    ids = SequentialIdGen('default')
    deps = Deps(repo=repo, clock=clock, ids=ids, ledger=InMemoryLedger(ids, clock), providers={}, policy=None, notifier=None, logger=NoopLogger())
    with open('paykit.config.json') as source:
        config = json.load(source)
    kit = create_payment_kit(config, deps, {'DATABASE_URL': ''}, providers_override={})
    await kit['initialize'](verify_schema_first=False)
    assert len(await repo.plans.list()) == len(config['plans'])
    stored_plan = await repo.plans.get(config['plans'][0]['id'])
    assert stored_plan is not None
    stored_plan.prices[0].provider_price_refs = {'stripe': 'db-stripe', 'polar': 'db-polar'}
    await repo.plans.put(stored_plan)
    await kit['initialize'](verify_schema_first=False)
    merged_plan = await repo.plans.get(stored_plan.id)
    assert merged_plan.prices[0].provider_price_refs == {'stripe': 'config-stripe', 'polar': 'db-polar'}
    result = await kit['support']['request_refund'](customer_id='unknown', payment_id='unknown', request_id='reject-missing')
    assert result.status == 'rejected'
    assert (await repo.cs_cases.get(result.id)).status == 'rejected'
    assert await kit['cron']['reconcile'](datetime(2026, 1, 1, tzinfo=timezone.utc)) == []
    print('PASS')
asyncio.run(main())
`);
  // When the generated runtimes initialize and reject an unverified refund request.
  const compiled = spawnSync(path.join(root, 'node_modules/.bin/tsc'), ['-p', path.join(dir, 'tsconfig.json')], { cwd: dir, encoding: 'utf8' });
  expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
  const ts = spawnSync(path.join(root, 'apps/cli/node_modules/.bin/tsx'), ['run.ts'], { cwd: dir, encoding: 'utf8' });
  const py = spawnSync(path.join(root, '.venv/bin/python'), ['run.py'], { cwd: dir, encoding: 'utf8' });
  // Then both preserve a reviewable case even with reporting disabled.
  expect(ts.status, ts.stdout + ts.stderr).toBe(0);
  expect(py.status, py.stdout + py.stderr).toBe(0);
});
