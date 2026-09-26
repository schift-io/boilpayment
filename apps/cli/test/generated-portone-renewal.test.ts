// EC:A43 (round-4 audit A4-1) — a PortOne subscription in a generated app renews every period through
// the kit's own scheduler: exactly one billing-key charge per period, in both languages, against the
// PortOne mock server (tools/mocks/portone). Before, the generated provider defaulted to PortOne-side
// scheduling that nothing drove, so tick charged nothing and the subscription stayed active forever.
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAll } from '../src/generate/index.js';
import { kitchenSinkConfig } from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PORT = 12500 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const dirs: string[] = [];
let mock: ChildProcess;

beforeAll(async () => {
  mock = spawn(process.execPath, [path.join(ROOT, 'tools/mocks/portone/server.mjs')], { env: { ...process.env, PORTONE_MOCK_PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/__mock/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('portone mock did not start');
});
afterAll(() => {
  mock?.kill();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function issueBillingKey(): Promise<string> {
  const res = await fetch(`${BASE}/billing-keys`, { method: 'POST', headers: { Authorization: 'PortOne test_secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ method: { card: {} } }) });
  return ((await res.json()) as { billingKeyInfo: { billingKey: string } }).billingKeyInfo.billingKey;
}
async function mockPayments(): Promise<Array<{ id: string; status: string }>> {
  const res = await fetch(`${BASE}/payments`, { headers: { Authorization: 'PortOne test_secret' } });
  return ((await res.json()) as { items: Array<{ id: string; status: string }> }).items;
}

async function generate(): Promise<{ dir: string; env: Record<string, string> }> {
  const config = kitchenSinkConfig();
  config.providers = ['portone'];
  config.models = ['subscription'];
  config.goods = ['credits'];
  config.cs.enabled = false;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'paykit-portone-'));
  dirs.push(dir);
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  await generateAll(config, dir);
  await fs.mkdir(path.join(dir, 'node_modules'), { recursive: true });
  await fs.symlink(path.join(ROOT, 'packages/sdk/ts'), path.join(dir, 'node_modules/boilpayment-sdk'), 'dir');
  const env: Record<string, string> = {};
  for (const raw of (await fs.readFile(path.join(dir, '.env.example'), 'utf8')).split('\n')) {
    const line = raw.trim(); const eq = line.indexOf('=');
    if (!line || line.startsWith('#') || eq === -1) continue;
    env[line.slice(0, eq).trim()] = line.slice(eq + 1).split(' #')[0].trim() || 'x';
  }
  Object.assign(env, { PORTONE_API_SECRET: 'test_secret', PORTONE_STORE_ID: 'store-test', PORTONE_WEBHOOK_SECRET: 'whsec_c2VjcmV0', PORTONE_API_BASE: BASE });
  return { dir, env };
}

describe('EC:A43 generated PortOne renewals', () => {
  it('TS kit: two periods, one charge each, credits granted each period', async () => {
    const { dir, env } = await generate();
    const billingKey = await issueBillingKey();
    const before = (await mockPayments()).length;
    await fs.writeFile(path.join(dir, 'harness.ts'), `
import { createPaymentKit } from './paykit/index.js';
import { InMemoryRepo, InMemoryLedger, FixedClock, SequentialIdGen, NoopLogger } from 'boilpayment-sdk/core';
import config from './paykit.config.json' with { type: 'json' };
const clock = new FixedClock(new Date('2026-04-01T01:00:00Z'));
const ids = new SequentialIdGen('t');
const repo = new InMemoryRepo(); const ledger = new InMemoryLedger(ids, clock);
const kit = createPaymentKit(config as any, { clock, ids, repo, ledger, logger: new NoopLogger(), env: ${JSON.stringify(env)} } as any);
const plan = config.plans[0] as any;
await repo.plans.put(plan);
await repo.subscriptions.put({ id: 's1', customerId: 'c1', planId: plan.id, provider: 'portone', providerRef: null, status: 'active', currentPeriod: { start: new Date('2026-03-01T00:00:00Z'), end: new Date('2026-04-01T00:00:00Z') }, anchorDay: 1, cancelAtPeriodEnd: false, graceUntil: null, billingKey: ${JSON.stringify(billingKey)}, scheduledPlanId: null, version: 0, currency: plan.prices[0].currency, createdAt: new Date('2026-03-01T00:00:00Z') } as any);
const out: any[] = [];
for (const at of ['2026-04-01T01:00:00Z', '2026-04-02T01:00:00Z', '2026-05-01T01:00:00Z', '2026-05-02T01:00:00Z']) {
  clock.advance(new Date(at).getTime() - clock.now().getTime());
  const r = await kit.cron.schedulerTick();
  const sub = await repo.subscriptions.get('s1');
  out.push([at.slice(0, 10), r.charged.length, r.errors.length, sub!.status, sub!.currentPeriod.end.toISOString().slice(0, 10), (await ledger.balance('c1', undefined, clock.now())).available]);
}
console.log(JSON.stringify(out));
`);
    const res = spawnSync(path.join(ROOT, 'apps/cli/node_modules/.bin/tsx'), ['harness.ts'], { cwd: dir, encoding: 'utf8' });
    expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
    const rows = JSON.parse(res.stdout.trim().split('\n').pop()!);
    const credits = kitchenSinkConfig().plans[0].creditsPerPeriod;
    expect(rows.map((r: unknown[]) => r.slice(0, 5))).toEqual([
      ['2026-04-01', 1, 0, 'active', '2026-05-01'],
      ['2026-04-02', 0, 0, 'active', '2026-05-01'],
      ['2026-05-01', 1, 0, 'active', '2026-06-01'],
      ['2026-05-02', 0, 0, 'active', '2026-06-01'],
    ]);
    expect(rows[3][5]).toBeGreaterThanOrEqual(credits);
    const created = (await mockPayments()).slice(before);
    expect(created.map((p) => p.status)).toEqual(['PAID', 'PAID']); // exactly one charge per period
  }, 120_000);

  it('Python kit: two periods, one charge each', async () => {
    const { dir, env } = await generate();
    const billingKey = await issueBillingKey();
    const before = (await mockPayments()).length;
    await fs.writeFile(path.join(dir, 'harness.py'), `
import asyncio, importlib.util, json
from datetime import datetime, timezone
from boilpayment_core import Deps, InMemoryRepo, InMemoryLedger, FixedClock, SequentialIdGen, NoopLogger, Period, Plan, PlanPrice, Subscription
spec = importlib.util.spec_from_file_location('generated', ${JSON.stringify(path.join(dir, 'paykit/index.py'))})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
def d(s):
    return datetime.fromisoformat(s).astimezone(timezone.utc)
async def main():
    clock = FixedClock(d('2026-04-01T01:00:00Z'))
    ids = SequentialIdGen('t')
    repo = InMemoryRepo(); ledger = InMemoryLedger(ids, clock)
    config = json.load(open(${JSON.stringify(path.join(dir, 'paykit.config.json'))}))
    kit = mod.create_payment_kit(config, Deps(clock=clock, ids=ids, repo=repo, ledger=ledger, logger=NoopLogger(), notifier=None, providers={}, policy=None), json.loads(${JSON.stringify(JSON.stringify(env))}))
    p = config['plans'][0]
    await repo.plans.put(Plan(id=p['id'], name=p['name'], interval=p['interval'], credits_per_period=p['creditsPerPeriod'], usage_included=p['usageIncluded'], trial_days=p['trialDays'], prices=[PlanPrice(currency=x['currency'], amount_minor=x['amountMinor'], provider_price_refs=x.get('providerPriceRefs') or {}) for x in p['prices']]))
    await repo.subscriptions.put(Subscription(id='s2', customer_id='c1', plan_id=p['id'], provider='portone', provider_ref=None, status='active', current_period=Period(start=d('2026-03-01T00:00:00Z'), end=d('2026-04-01T00:00:00Z')), anchor_day=1, cancel_at_period_end=False, grace_until=None, billing_key=${JSON.stringify(billingKey)}, scheduled_plan_id=None, version=0, currency=p['prices'][0]['currency'], created_at=d('2026-03-01T00:00:00Z')))
    out = []
    for at in ['2026-04-01T01:00:00Z', '2026-04-02T01:00:00Z', '2026-05-01T01:00:00Z', '2026-05-02T01:00:00Z']:
        clock.advance(int((d(at) - clock.now()).total_seconds() * 1000))
        r = await kit['cron']['scheduler_tick']()
        sub = await repo.subscriptions.get('s2')
        out.append([at[:10], len(r['charged']), len(r['errors']), sub.status, sub.current_period.end.date().isoformat()])
    print(json.dumps(out))
asyncio.run(main())
`);
    const res = spawnSync(path.join(ROOT, '.venv/bin/python'), [path.join(dir, 'harness.py')], { encoding: 'utf8' });
    expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
    expect(JSON.parse(res.stdout.trim().split('\n').pop()!)).toEqual([
      ['2026-04-01', 1, 0, 'active', '2026-05-01'],
      ['2026-04-02', 0, 0, 'active', '2026-05-01'],
      ['2026-05-01', 1, 0, 'active', '2026-06-01'],
      ['2026-05-02', 0, 0, 'active', '2026-06-01'],
    ]);
    expect((await mockPayments()).slice(before).map((p) => p.status)).toEqual(['PAID', 'PAID']);
  }, 120_000);

  // EC:A47 (round-5 audit A5-1): an app generated before A43 left every PortOne subscription months
  // behind. After the upgrade, ticks every 10 minutes must charge once (the period containing now),
  // not one missed period per tick. Postgres, TS and Python.
  it('A47 TS on Postgres: four periods behind -> one charge, usable credits, period advanced to now', async () => {
    const { dir, env } = await generate();
    const billingKey = await issueBillingKey();
    const before = (await mockPayments()).length;
    const db = `paykit_test_a47_ts_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
    spawnSync('createdb', ['-h', '127.0.0.1', db]);
    try {
      await fs.writeFile(path.join(dir, 'harness.ts'), `
import { createPaymentKit } from './paykit/index.js';
import { FixedClock, SequentialIdGen, NoopLogger } from 'boilpayment-sdk/core';
import { createPool, PostgresRepo, PostgresLedgerStore, migrate } from 'boilpayment-sdk/postgres';
import config from './paykit.config.json' with { type: 'json' };
const pool = createPool('postgres://127.0.0.1/${db}');
await migrate({ pool, modules: ['core', 'credits', 'webhook', 'refund', 'cs'] } as any);
const clock = new FixedClock(new Date('2026-05-15T09:00:00Z'));
const ids = new SequentialIdGen('t');
const repo = new PostgresRepo(pool); const ledger = new PostgresLedgerStore(pool);
const kit = createPaymentKit(config as any, { clock, ids, repo, ledger, logger: new NoopLogger(), env: ${JSON.stringify(env)} } as any);
const plan = config.plans[0] as any;
await repo.plans.put(plan);
await repo.customers.put({ id: 'c1', email: null, providerRefs: [], status: 'active', createdAt: new Date('2026-01-01T00:00:00Z') } as any);
await repo.subscriptions.put({ id: 's_a47_ts', customerId: 'c1', planId: plan.id, provider: 'portone', providerRef: null, status: 'active', currentPeriod: { start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-02-01T00:00:00Z') }, anchorDay: 1, cancelAtPeriodEnd: false, graceUntil: null, billingKey: ${JSON.stringify(billingKey)}, scheduledPlanId: null, version: 0, currency: plan.prices[0].currency, createdAt: new Date('2026-01-01T00:00:00Z') } as any);
const charged: number[] = [];
for (let i = 0; i < 5; i++) {
  if (i) clock.advance(10 * 60_000);
  charged.push((await kit.cron.schedulerTick()).charged.length);
}
const sub = await repo.subscriptions.get('s_a47_ts');
console.log(JSON.stringify({ charged, periodStart: sub!.currentPeriod.start.toISOString().slice(0, 10), usable: (await ledger.balance('c1', undefined, clock.now())).available }));
await pool.end();
`);
      const res = spawnSync(path.join(ROOT, 'apps/cli/node_modules/.bin/tsx'), ['harness.ts'], { cwd: dir, encoding: 'utf8' });
      expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
      const out = JSON.parse(res.stdout.trim().split('\n').pop()!);
      expect(out.charged).toEqual([1, 0, 0, 0, 0]);
      expect(out.periodStart).toBe('2026-05-01');
      expect(out.usable).toBeGreaterThanOrEqual(kitchenSinkConfig().plans[0].creditsPerPeriod);
      expect((await mockPayments()).slice(before).map((p) => p.status)).toEqual(['PAID']);
    } finally {
      spawnSync('dropdb', ['-h', '127.0.0.1', '--if-exists', db]);
    }
  }, 120_000);

  it('A47 Python on Postgres: four periods behind -> one charge', async () => {
    const { dir, env } = await generate();
    const billingKey = await issueBillingKey();
    const before = (await mockPayments()).length;
    const db = `paykit_test_a47_py_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
    spawnSync('createdb', ['-h', '127.0.0.1', db]);
    try {
      await fs.writeFile(path.join(dir, 'harness.py'), `
import asyncio, importlib.util, json
from datetime import datetime, timezone
from boilpayment_core import Customer, Deps, FixedClock, SequentialIdGen, NoopLogger, Period, Plan, PlanPrice, Subscription
from boilpayment.postgres import PostgresRepo, PostgresLedgerStore, migrate
spec = importlib.util.spec_from_file_location('generated', ${JSON.stringify(path.join(dir, 'paykit/index.py'))})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
DSN = 'postgresql://127.0.0.1/${db}'
def d(s):
    return datetime.fromisoformat(s).astimezone(timezone.utc)
async def main():
    await migrate(conninfo=DSN, modules=['core', 'credits', 'webhook', 'refund', 'cs'])
    clock = FixedClock(d('2026-05-15T09:00:00Z'))
    ids = SequentialIdGen('t')
    repo = PostgresRepo(DSN); ledger = PostgresLedgerStore(DSN)
    config = json.load(open(${JSON.stringify(path.join(dir, 'paykit.config.json'))}))
    kit = mod.create_payment_kit(config, Deps(clock=clock, ids=ids, repo=repo, ledger=ledger, logger=NoopLogger(), notifier=None, providers={}, policy=None), json.loads(${JSON.stringify(JSON.stringify(env))}))
    p = config['plans'][0]
    await repo.plans.put(Plan(id=p['id'], name=p['name'], interval=p['interval'], credits_per_period=p['creditsPerPeriod'], usage_included=p['usageIncluded'], trial_days=p['trialDays'], prices=[PlanPrice(currency=x['currency'], amount_minor=x['amountMinor'], provider_price_refs=x.get('providerPriceRefs') or {}) for x in p['prices']]))
    await repo.customers.put(Customer(id='c1', email=None, provider_refs=[], status='active', created_at=d('2026-01-01T00:00:00Z')))
    await repo.subscriptions.put(Subscription(id='s_a47_py', customer_id='c1', plan_id=p['id'], provider='portone', provider_ref=None, status='active', current_period=Period(start=d('2026-01-01T00:00:00Z'), end=d('2026-02-01T00:00:00Z')), anchor_day=1, cancel_at_period_end=False, grace_until=None, billing_key=${JSON.stringify(billingKey)}, scheduled_plan_id=None, version=0, currency=p['prices'][0]['currency'], created_at=d('2026-01-01T00:00:00Z')))
    charged = []
    for i in range(5):
        if i:
            clock.advance(10 * 60_000)
        charged.append(len((await kit['cron']['scheduler_tick']())['charged']))
    sub = await repo.subscriptions.get('s_a47_py')
    print(json.dumps({'charged': charged, 'periodStart': sub.current_period.start.date().isoformat()}))
asyncio.run(main())
`);
      const res = spawnSync(path.join(ROOT, '.venv/bin/python'), [path.join(dir, 'harness.py')], { encoding: 'utf8' });
      expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
      const out = JSON.parse(res.stdout.trim().split('\n').pop()!);
      expect(out).toEqual({ charged: [1, 0, 0, 0, 0], periodStart: '2026-05-01' });
      expect((await mockPayments()).slice(before).map((p) => p.status)).toEqual(['PAID']);
    } finally {
      spawnSync('dropdb', ['-h', '127.0.0.1', '--if-exists', db]);
    }
  }, 120_000);
});
