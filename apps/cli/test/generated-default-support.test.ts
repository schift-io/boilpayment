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
const linked = new URL(kit.buildPaymentLinkUrl({ provider: 'stripe', linkUrl: 'https://buy.stripe.com/test?utm_source=docs', customerId: 'cus_1', affiliateId: 'aff_1' }));
assert.equal(linked.searchParams.get('utm_source'), 'docs');
assert.match(linked.searchParams.get('client_reference_id') ?? '', /^[A-Za-z0-9_-]{1,200}$/);
await repo.affiliateCommissions.append({ id: 'a1', kind: 'accrual', affiliateId: 'aff_1', paymentId: 'p1', refundId: null, relatedAccrualId: null, amount: { amountMinor: 250, currency: 'USD' }, idempotencyKey: 'a1', createdAt: clock.now() });
await repo.affiliateCommissions.append({ id: 'r1', kind: 'reversal', affiliateId: 'aff_1', paymentId: 'p1', refundId: 'r1', relatedAccrualId: 'a1', amount: { amountMinor: 40, currency: 'USD' }, idempotencyKey: 'r1', createdAt: clock.now() });
assert.equal((await kit.affiliate.list({ affiliateId: 'aff_1' })).length, 2);
assert.equal(await kit.affiliate.sum({ affiliateId: 'aff_1', currency: 'USD' }), 210);
assert.deepEqual(await kit.affiliate.sum({ affiliateId: 'aff_1' }), { USD: 210 });
console.log('PASS');
`);
  await fs.writeFile(path.join(dir, 'run.py'), `
import asyncio, json
from datetime import datetime, timezone
from paykit.index import create_payment_kit
from boilpayment.core import AffiliateCommission, Deps, InMemoryRepo, InMemoryLedger, FixedClock, SequentialIdGen, NoopLogger, money
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
    linked = kit['build_payment_link_url'](provider='stripe', link_url='https://buy.stripe.com/test?utm_source=docs', customer_id='cus_1', affiliate_id='aff_1')
    assert 'utm_source=docs' in linked and 'client_reference_id=' in linked
    await repo.affiliate_commissions.append(AffiliateCommission(id='a1', kind='accrual', affiliate_id='aff_1', payment_id='p1', refund_id=None, related_accrual_id=None, amount=money(250, 'USD'), idempotency_key='a1', created_at=clock.now()))
    await repo.affiliate_commissions.append(AffiliateCommission(id='r1', kind='reversal', affiliate_id='aff_1', payment_id='p1', refund_id='r1', related_accrual_id='a1', amount=money(40, 'USD'), idempotency_key='r1', created_at=clock.now()))
    assert len(await kit['affiliate']['list'](affiliate_id='aff_1')) == 2
    assert await kit['affiliate']['sum'](affiliate_id='aff_1', currency='USD') == 210
    assert await kit['affiliate']['sum'](affiliate_id='aff_1') == {'USD': 210}
    print('PASS')
asyncio.run(main())
`);
  // When the generated runtimes initialize and reject an unverified refund request.
  const compiled = spawnSync(path.join(root, 'node_modules/.bin/tsc'), ['-p', path.join(dir, 'tsconfig.json')], { cwd: dir, encoding: 'utf8' });
  expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
  const ts = spawnSync(process.execPath, ['--import', path.join(root, 'apps/cli/node_modules/tsx/dist/loader.mjs'), 'run.ts'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: path.join(root, 'node_modules') },
  });
  const py = spawnSync(path.join(root, '.venv/bin/python'), ['run.py'], { cwd: dir, encoding: 'utf8' });
  // Then both preserve a reviewable case even with reporting disabled.
  expect(ts.status, ts.stdout + ts.stderr).toBe(0);
  expect(py.status, py.stdout + py.stderr).toBe(0);
});
