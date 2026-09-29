// OT-09 through the composition the CLI generates: cron.reconcile (recoverMissingGrants first, then the
// registration-hold scan) must leave a held, unregistered payment alone inside the window and open exactly
// one needs_human case after it, with no grant, in both languages.
import { afterAll, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAll } from '../src/generate/index.js';
import { kitchenSinkConfig } from './helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dirs: string[] = [];
afterAll(async () => { await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

it('generated cron.reconcile holds a payment inside the window and opens one case after it', async () => {
  // Given a generated credits + top-up kit
  const config = kitchenSinkConfig();
  config.providers = ['stripe'];
  config.models = ['topup'];
  config.goods = ['credits'];
  config.cs.enabled = false;
  config.infra.notify.email = 'none';
  config.infra.notify.slack = false;
  const price = config.plans[0]?.prices[0];
  if (!price) throw new Error('no plan price');
  price.providerPriceRefs = { stripe: 'price_x' };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paykit-reg-hold-'));
  dirs.push(dir);
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  await generateAll(config, dir);
  await fs.mkdir(path.join(dir, 'node_modules'), { recursive: true });
  await fs.symlink(path.join(root, 'packages/sdk/ts'), path.join(dir, 'node_modules/boilpayment-sdk'), 'dir');
  await fs.writeFile(path.join(dir, 'run.ts'), `
import assert from 'node:assert/strict';
import { createPaymentKit } from './paykit/index.js';
import { InMemoryRepo, InMemoryLedger, FixedClock, SequentialIdGen, NoopLogger } from 'boilpayment-sdk/core';
import config from './paykit.config.json' with { type: 'json' };
const received = new Date('2026-09-28T00:00:00Z');
const repo = new InMemoryRepo();
const clock = new FixedClock(received);
const ids = new SequentialIdGen('hold');
const ledger = new InMemoryLedger(ids, clock);
const kit = createPaymentKit(config, { repo, clock, ids, ledger, providers: {}, logger: new NoopLogger(), env: { DATABASE_URL: '' } });
await kit.initialize({ verifySchema: false });
await repo.customers.put({ id: 'cus', email: null, providerRefs: [], status: 'active', createdAt: received });
const id = 'payment:stripe:pi_1';
await repo.payments.put({ id, customerId: 'cus', provider: 'stripe', providerRef: 'pi_1', subscriptionId: null,
  amount: { amountMinor: 1000, currency: 'USD' }, status: 'succeeded', kind: 'topup', period: null, occurredAt: received, failure: null });
const held = { paymentId: id, checkoutId: 'cs_1', customerId: 'cus', receivedAt: received.toISOString() };
await repo.operations.put({ id: 'checkout-payment-held:' + id, key: 'checkout-payment-held:' + id, kind: 'checkout.paymentHeld',
  payloadHash: 'h', status: 'done', result: held, error: null, createdAt: received, completedAt: received, attempts: 1 });
const since = new Date('2026-01-01');
clock.advance(23 * 3600_000);
await kit.cron.reconcile(since);
assert.equal((await repo.csCases.list()).length, 0);
clock.advance(2 * 3600_000);
await kit.cron.reconcile(since);
await kit.cron.reconcile(since);
const cases = await repo.csCases.list();
assert.equal(cases.length, 1);
assert.equal(cases[0].status, 'needs_human');
assert.equal((await ledger.entries('cus', { kind: 'grant' })).length, 0);
console.log('PASS');
`);
  await fs.writeFile(path.join(dir, 'run.py'), `
import asyncio, json
from datetime import datetime, timedelta, timezone
from paykit.index import create_payment_kit
from boilpayment.core import Customer, Deps, FixedClock, InMemoryLedger, InMemoryRepo, Money, NoopLogger, Operation, Payment, SequentialIdGen
async def main():
    received = datetime(2026, 9, 28, tzinfo=timezone.utc)
    repo = InMemoryRepo()
    clock = FixedClock(received)
    ids = SequentialIdGen('hold')
    ledger = InMemoryLedger(ids, clock)
    deps = Deps(repo=repo, clock=clock, ids=ids, ledger=ledger, providers={}, policy=None, notifier=None, logger=NoopLogger())
    with open('paykit.config.json') as source:
        config = json.load(source)
    kit = create_payment_kit(config, deps, {'DATABASE_URL': ''}, providers_override={})
    await kit['initialize'](verify_schema_first=False)
    await repo.customers.put(Customer(id='cus', email=None, provider_refs=[], status='active', created_at=received))
    pid = 'payment:stripe:pi_1'
    await repo.payments.put(Payment(id=pid, customer_id='cus', provider='stripe', provider_ref='pi_1', subscription_id=None,
        amount=Money(amount_minor=1000, currency='USD'), status='succeeded', kind='topup', period=None, occurred_at=received, failure=None))
    held = {'paymentId': pid, 'checkoutId': 'cs_1', 'customerId': 'cus', 'receivedAt': received.isoformat()}
    await repo.operations.put(Operation(id='checkout-payment-held:' + pid, key='checkout-payment-held:' + pid, kind='checkout.paymentHeld',
        payload_hash='h', status='done', result=held, error=None, created_at=received, completed_at=received, attempts=1))
    since = datetime(2026, 1, 1, tzinfo=timezone.utc)
    clock.advance(23 * 3600_000)
    await kit['cron']['reconcile'](since)
    assert len(await repo.cs_cases.list()) == 0
    clock.advance(2 * 3600_000)
    await kit['cron']['reconcile'](since)
    await kit['cron']['reconcile'](since)
    cases = await repo.cs_cases.list()
    assert len(cases) == 1, cases
    assert cases[0].status == 'needs_human'
    assert len(await ledger.entries('cus', kind='grant')) == 0
    print('PASS')
asyncio.run(main())
`);

  // When both generated runtimes reconcile at 23h, then at 25h twice
  const ts = spawnSync(process.execPath, ['--import', path.join(root, 'apps/cli/node_modules/tsx/dist/loader.mjs'), 'run.ts'], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_PATH: path.join(root, 'node_modules') },
  });
  const py = spawnSync(path.join(root, '.venv/bin/python'), ['run.py'], { cwd: dir, encoding: 'utf8' });

  // Then
  expect(ts.status, ts.stdout + ts.stderr).toBe(0);
  expect(py.status, py.stdout + py.stderr).toBe(0);
}, 60_000);
