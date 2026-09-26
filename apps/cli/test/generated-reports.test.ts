// EC:I10 — generated kit.reports.settlement runs in both languages, only when `reports` is on.
import { describe, it, expect, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAll } from '../src/generate/index.js';
import { kitchenSinkConfig } from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function env(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim(); const eq = line.indexOf('=');
    if (!line || line.startsWith('#') || eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (/^[A-Z0-9_]+$/.test(key)) out[key] = line.slice(eq + 1).split(' #')[0].trim();
  }
  return out;
}
async function generate(reports: boolean) {
  const config = kitchenSinkConfig(); config.reports = reports;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'paykit-reports-')); dirs.push(dir);
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  await generateAll(config, dir, { csApiKey: 'pk_live_test' });
  await fs.mkdir(path.join(dir, 'node_modules'), { recursive: true });
  await fs.symlink(path.join(ROOT, 'packages/sdk/ts'), path.join(dir, 'node_modules/boilpayment-sdk'), 'dir');
  return { dir, env: env(await fs.readFile(path.join(dir, '.env.example'), 'utf8')) };
}

describe('EC:I10 generated reports', () => {
  it('off by default: nothing generated', async () => {
    const { dir } = await generate(false);
    for (const f of ['paykit/index.ts', 'paykit/index.py', 'INTEGRATION.md']) {
      expect(await fs.readFile(path.join(dir, f), 'utf8')).not.toMatch(/settlement/i);
    }
  }, 60_000);

  it('on: TS and Python kits return the same totals', async () => {
    const { dir, env: e } = await generate(true);
    await fs.writeFile(path.join(dir, 'harness.ts'), `
import { createPaymentKit } from './paykit/index.js';
import { InMemoryRepo, InMemoryLedger, FixedClock, SequentialIdGen, NoopLogger } from 'boilpayment-sdk/core';
import config from './paykit.config.json' with { type: 'json' };
const clock = new FixedClock(new Date('2026-01-10T00:00:00Z')); const ids = new SequentialIdGen('t');
const repo = new InMemoryRepo(); const ledger = new InMemoryLedger(ids, clock);
await repo.customers.put({ id: 'c1', email: null, providerRefs: [], status: 'active', createdAt: clock.now() });
await repo.payments.put({ id: 'p1', customerId: 'c1', provider: 'stripe', providerRef: 'pi_1', subscriptionId: null, amount: { amountMinor: 1000, currency: 'USD' }, status: 'succeeded', kind: 'topup', period: null, occurredAt: clock.now(), failure: null });
await ledger.append({ customerId: 'c1', pool: 'paid', kind: 'grant', amount: 100, unitPriceMinor: 10, currency: 'USD', expiresAt: null, source: 'topup', reference: {}, idempotencyKey: 'g', actor: 's', reason: null });
const kit = createPaymentKit(config, { clock, ids, repo, ledger, logger: new NoopLogger(), env: ${JSON.stringify(e)} });
const r = await kit.reports.settlement({ from: new Date('2026-01-01T00:00:00Z'), to: new Date('2026-02-01T00:00:00Z') });
console.log(JSON.stringify({ net: r.net.map((x) => [x.currency, x.amountMinor]), credits: r.credits.map((x) => [x.kind, x.source, x.amount]) }));
`);
    const ts = spawnSync(path.join(ROOT, 'apps/cli/node_modules/.bin/tsx'), ['harness.ts'], { cwd: dir, encoding: 'utf8' });
    expect(ts.status, `${ts.stdout}\n${ts.stderr}`).toBe(0);
    await fs.writeFile(path.join(dir, 'harness.py'), `
import asyncio, importlib.util, json
from datetime import datetime, timezone
from boilpayment_core import Deps, InMemoryRepo, InMemoryLedger, FixedClock, SequentialIdGen, NoopLogger, Customer, Payment, Money, NewLedgerEntry
spec = importlib.util.spec_from_file_location('g', ${JSON.stringify(path.join(dir, 'paykit/index.py'))})
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
async def main():
    clock = FixedClock(datetime(2026, 1, 10, tzinfo=timezone.utc)); ids = SequentialIdGen('t')
    repo = InMemoryRepo(); ledger = InMemoryLedger(ids, clock)
    await repo.customers.put(Customer(id='c1', email=None, provider_refs=[], status='active', created_at=clock.now()))
    await repo.payments.put(Payment(id='p1', customer_id='c1', provider='stripe', provider_ref='pi_1', subscription_id=None, amount=Money(amount_minor=1000, currency='USD'), status='succeeded', kind='topup', period=None, occurred_at=clock.now(), failure=None))
    await ledger.append(NewLedgerEntry(customer_id='c1', pool='paid', kind='grant', amount=100, unit_price_minor=10, currency='USD', source='topup', idempotency_key='g', actor='s'))
    config = json.load(open(${JSON.stringify(path.join(dir, 'paykit.config.json'))}))
    kit = mod.create_payment_kit(config, Deps(clock=clock, ids=ids, repo=repo, ledger=ledger, logger=NoopLogger(), notifier=None, providers={}, policy=None), json.loads(${JSON.stringify(JSON.stringify(e))}))
    r = await kit['reports']['settlement'](start=datetime(2026, 1, 1, tzinfo=timezone.utc), end=datetime(2026, 2, 1, tzinfo=timezone.utc))
    print(json.dumps({"net": [[x.currency, x.amount_minor] for x in r.net], "credits": [[x.kind, x.source, x.amount] for x in r.credits]}, separators=(",", ":")))
asyncio.run(main())
`);
    const py = spawnSync(path.join(ROOT, '.venv/bin/python'), [path.join(dir, 'harness.py')], { encoding: 'utf8' });
    expect(py.status, `${py.stdout}\n${py.stderr}`).toBe(0);
    const last = (s: string) => JSON.parse(s.trim().split('\n').pop()!);
    expect(last(ts.stdout)).toEqual({ net: [['USD', 1000]], credits: [['grant', 'topup', 100]] });
    expect(last(py.stdout)).toEqual(last(ts.stdout));
  }, 120_000);
});
