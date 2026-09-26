// Executes the generated kit instead of only compiling it.
//
// Why this file exists: generate.test.ts typechecks the generated ts and imports the generated py,
// and BOTH passed while the Python generator emitted a kit that raised TypeError the moment anyone
// called it (flat kwargs for the Toss/PortOne constructors, then missing lifecycle input imports).
// A typecheck cannot see a wrong keyword name and an import cannot see an unexecuted function body.
// Every cron entry here had likewise never been invoked by any test in the repo.
//
// Both languages run the same scenario with in-memory deps and no network: a customer, a past_due
// subscription whose grace window has already closed, and an active one whose provider is not among
// the configured ones (so closePeriods runs with provider=null). The assertion is not merely "no
// exception" — dunning must actually move the past_due subscription, which proves the loop body ran.
import { describe, it, expect, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAll } from '../src/generate/index.js';
import { kitchenSinkConfig } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');

const cleanupDirs: string[] = [];
function tmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

/** The cron entries every generated kitchen-sink kit must expose, in both languages. */
const CRON_TS = ['expireDue', 'dunningSweep', 'closePeriods', 'flushOutbox', 'schedulerTick'] as const;
const CRON_PY = ['expire_due', 'dunning_sweep', 'close_periods', 'flush_outbox', 'scheduler_tick'] as const;
// `reconcile` is deliberately not called: it fans out to provider.listPayments, i.e. the network.
// It is covered by the provider live checks (`boilpayment live`), not here.

/**
 * The env both harnesses pass is built from the generated `.env.example`, not hand-written here.
 * That makes this test assert something extra and load-bearing: `.env.example` must list EVERY
 * variable the generated code requires. A secret the code reads but the example file forgets shows
 * up as a construction failure, which is exactly what the user would hit on their first run.
 */
function envFromExample(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    // Strip the trailing ` # comment` the generator writes after some values.
    const value = line.slice(eq + 1).split(' #')[0].trim();
    if (/^[A-Z0-9_]+$/.test(key)) out[key] = value;
  }
  return out;
}

describe('generated kit actually runs (not just typechecks)', () => {
  it('every ts cron entry is callable and dunning moves a past_due subscription', async () => {
    const dir = tmpDir('paykit-run-ts-');
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    await generateAll(kitchenSinkConfig(), dir, { csApiKey: 'pk_live_test' });
    const env = envFromExample(await fs.readFile(path.join(dir, '.env.example'), 'utf8'));

    const harness = `
import { createPaymentKit } from './paykit/index.js';
import { InMemoryRepo, InMemoryLedger, FixedClock, SequentialIdGen, NoopLogger } from 'boilpayment-sdk/core';
import config from './paykit.config.json' with { type: 'json' };

const clock = new FixedClock(new Date('2026-03-01T00:00:00Z'));
const ids = new SequentialIdGen('t');
const repo = new InMemoryRepo();
const now = clock.now();
const day = 86400000;
const sub = (id, status, graceUntil) => ({
  id, customerId: 'cus_1', planId: 'default', provider: 'polar', providerRef: null, status,
  currentPeriod: { start: new Date(+now - 30 * day), end: now }, anchorDay: 1,
  cancelAtPeriodEnd: false, graceUntil, billingKey: null, scheduledPlanId: null, version: 0, createdAt: now });

await repo.customers.put({ id: 'cus_1', email: 'a@b.c', providerRefs: {}, status: 'active', createdAt: now });
await repo.subscriptions.put(sub('sub_pastdue', 'past_due', new Date(+now - day)));
await repo.subscriptions.put(sub('sub_active', 'active', null));

const kit = createPaymentKit(config, {
  clock, ids, repo, ledger: new InMemoryLedger(ids, clock), logger: new NoopLogger(), env: ${JSON.stringify(env)},
});
if (typeof kit.support?.requestRefund !== 'function') throw new Error('support.requestRefund missing');
for (const name of ${JSON.stringify(CRON_TS)}) {
  if (typeof kit.cron[name] !== 'function') throw new Error('missing cron entry: ' + name);
  await kit.cron[name]();
}
const after = await repo.subscriptions.get('sub_pastdue');
console.log(JSON.stringify({ cron: Object.keys(kit.cron).sort(), pastDueStatus: after.status, graceUntil: after.graceUntil }));
`;
    await fs.writeFile(path.join(dir, 'harness.ts'), harness);
    // The generated code imports the facade by name, so the temp project needs it resolvable.
    await fs.mkdir(path.join(dir, 'node_modules'), { recursive: true });
    await fs.symlink(path.join(ROOT, 'packages/sdk/ts'), path.join(dir, 'node_modules/boilpayment-sdk'), 'dir');

    const tsx = path.join(ROOT, 'apps/cli/node_modules/.bin/tsx');
    const res = spawnSync(tsx, ['harness.ts'], { cwd: dir, encoding: 'utf8' });
    expect(res.status, `ts harness failed:\n${res.stdout}\n${res.stderr}`).toBe(0);
    const out = JSON.parse(res.stdout.trim().split('\n').pop()!);
    expect(out.cron).toEqual([...CRON_TS, 'reconcile'].sort());
    // Proves the sweep entered the body rather than iterating an empty list.
    expect(out.pastDueStatus).not.toBe('past_due');
    expect(out.graceUntil).toBeNull();
  }, 120_000);

  it('every py cron entry is callable and dunning moves a past_due subscription', async () => {
    const dir = tmpDir('paykit-run-py-');
    await generateAll(kitchenSinkConfig(), dir, { csApiKey: 'pk_live_test' });
    const env = envFromExample(await fs.readFile(path.join(dir, '.env.example'), 'utf8'));

    const harness = `
import asyncio, importlib.util, json
from datetime import datetime, timedelta, timezone
from boilpayment_core import (Deps, InMemoryLedger, InMemoryRepo, FixedClock, SequentialIdGen,
                                     NoopLogger, Customer, Subscription, Period)

spec = importlib.util.spec_from_file_location("gen_index", ${JSON.stringify(path.join('PLACEHOLDER'))})
`;
    // Built as a file (not -c) so tracebacks carry real line numbers.
    const indexPy = path.join(dir, 'paykit', 'index.py');
    const configJson = path.join(dir, 'paykit.config.json');
    const pyHarness = harness.replace(JSON.stringify(path.join('PLACEHOLDER')), JSON.stringify(indexPy)) + `
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
config = json.load(open(${JSON.stringify(configJson)}))

async def main():
    clock = FixedClock(datetime(2026, 3, 1, tzinfo=timezone.utc))
    ids = SequentialIdGen("t")
    repo = InMemoryRepo()
    now = clock.now()
    def sub(sid, status, grace):
        return Subscription(id=sid, customer_id="cus_1", plan_id="default", provider="polar",
            provider_ref=None, status=status,
            current_period=Period(start=now - timedelta(days=30), end=now), anchor_day=1,
            cancel_at_period_end=False, grace_until=grace, billing_key=None,
            scheduled_plan_id=None, created_at=now)
    await repo.customers.put(Customer(id="cus_1", email="a@b.c", provider_refs={}, status="active", created_at=now))
    await repo.subscriptions.put(sub("sub_pastdue", "past_due", now - timedelta(days=1)))
    await repo.subscriptions.put(sub("sub_active", "active", None))

    deps = Deps(clock=clock, ids=ids, ledger=InMemoryLedger(ids, clock), repo=repo,
                notifier=None, providers={}, policy=None, logger=NoopLogger())
    env = ${JSON.stringify(JSON.stringify(env))}
    env = json.loads(env)
    kit = mod.create_payment_kit(config, deps, env)
    assert callable(kit["support"]["request_refund"])
    for name in ${JSON.stringify(CRON_PY)}:
        if name not in kit["cron"]:
            raise AssertionError("missing cron entry: " + name)
        await kit["cron"][name]()
    after = await repo.subscriptions.get("sub_pastdue")
    print(json.dumps({"cron": sorted(kit["cron"].keys()),
                      "pastDueStatus": after.status,
                      "graceUntil": after.grace_until.isoformat() if after.grace_until else None}))

asyncio.run(main())
`;
    const harnessPath = path.join(dir, 'harness.py');
    await fs.writeFile(harnessPath, pyHarness);
    const python = path.join(ROOT, '.venv/bin/python');
    const res = spawnSync(python, [harnessPath], { encoding: 'utf8' });
    expect(res.status, `py harness failed:\n${res.stdout}\n${res.stderr}`).toBe(0);
    const out = JSON.parse(res.stdout.trim().split('\n').pop()!);
    expect(out.cron).toEqual([...CRON_PY, 'reconcile'].sort());
    expect(out.pastDueStatus).not.toBe('past_due');
    expect(out.graceUntil).toBeNull();
  }, 120_000);
});

describe('generated topup-only kit with optional logging', () => {
  for (const logging of ['none', 'console'] as const) {
    it(`runs TS and Python scheduler/schema checks with ${logging} logging`, async () => {
      // Given a Toss topup-only seller without subscription lifecycle modules.
      const config = kitchenSinkConfig();
      config.providers = ['toss'];
      config.models = ['topup'];
      config.goods = ['credits'];
      config.cs.enabled = false;
      config.infra.logging = logging;
      const dir = tmpDir('paykit-topup-runtime-');
      await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
      await generateAll(config, dir);
      const env = envFromExample(await fs.readFile(path.join(dir, '.env.example'), 'utf8'));
      // An invalid connection string exercises the schema call without a database or network.
      env.DATABASE_URL = 'postgres://[invalid';
      await fs.mkdir(path.join(dir, 'node_modules'), { recursive: true });
      await fs.symlink(path.join(ROOT, 'packages/sdk/ts'), path.join(dir, 'node_modules/boilpayment-sdk'), 'dir');
      const tsHarness = `
import assert from 'node:assert/strict';
import { createPaymentKit } from './paykit/index.js';
import { InMemoryRepo, InMemoryLedger, FixedClock, SequentialIdGen, NoopLogger } from 'boilpayment-sdk/core';
import config from './paykit.config.json' with { type: 'json' };
const clock = new FixedClock(new Date('2026-03-01T00:00:00Z'));
const ids = new SequentialIdGen('test');
const kit = createPaymentKit(config, { clock, ids, repo: new InMemoryRepo(), ledger: new InMemoryLedger(ids, clock), logger: new NoopLogger(), env: ${JSON.stringify(env)} });
assert.deepEqual(await kit.cron.schedulerTick(), { charged: [], failed: [] });
await assert.rejects(kit.verifySchema, (error) => error instanceof TypeError && error.code === 'ERR_INVALID_URL');
console.log('OK');
`;
      await fs.writeFile(path.join(dir, 'harness.ts'), tsHarness);
      const pyHarness = `
import asyncio, importlib.util, json
from datetime import datetime, timezone
from boilpayment_core import Deps, InMemoryRepo, InMemoryLedger, FixedClock, SequentialIdGen, NoopLogger
spec = importlib.util.spec_from_file_location('generated', ${JSON.stringify(path.join(dir, 'paykit/index.py'))})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
async def main():
    clock = FixedClock(datetime(2026, 3, 1, tzinfo=timezone.utc))
    ids = SequentialIdGen('test')
    deps = Deps(clock=clock, ids=ids, repo=InMemoryRepo(), ledger=InMemoryLedger(ids, clock), logger=NoopLogger(), notifier=None, providers={}, policy=None)
    config = json.load(open(${JSON.stringify(path.join(dir, 'paykit.config.json'))}))
    env = json.loads(${JSON.stringify(JSON.stringify(env))})
    kit = mod.create_payment_kit(config, deps, env)
    assert await kit['cron']['scheduler_tick']() == {'charged': [], 'failed': []}
    import psycopg
    try:
        await kit['verify_schema']()
    except psycopg.ProgrammingError:
        pass
    else:
        raise AssertionError('invalid connection string accepted')
    print('OK')
asyncio.run(main())
`;
      await fs.writeFile(path.join(dir, 'harness.py'), pyHarness);
      // When the actual generated runtimes call both public entry points.
      const tsResult = spawnSync(path.join(ROOT, 'apps/cli/node_modules/.bin/tsx'), ['harness.ts'], { cwd: dir, encoding: 'utf8' });
      const pyResult = spawnSync(path.join(ROOT, '.venv/bin/python'), [path.join(dir, 'harness.py')], { encoding: 'utf8' });
      // Then scheduler is a no-op and schema verification reaches the real adapter.
      expect(tsResult.status, `${tsResult.stdout}\n${tsResult.stderr}`).toBe(0);
      expect(pyResult.status, `${pyResult.stdout}\n${pyResult.stderr}`).toBe(0);
    });
  }
});
