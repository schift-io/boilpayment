// EC:C10 — the generated kit's reservations (reserve / commit / release / cron sweep) actually run,
// in both languages, and only exist when the wizard answer `reservations` is on.
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
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tmpDir(prefix: string): string {
  const d = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}
function envFromExample(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const eq = line.indexOf('=');
    if (!line || line.startsWith('#') || eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (/^[A-Z0-9_]+$/.test(key)) out[key] = line.slice(eq + 1).split(' #')[0].trim();
  }
  return out;
}

async function generate(reservations: boolean): Promise<{ dir: string; env: Record<string, string> }> {
  const config = kitchenSinkConfig();
  config.reservations = reservations;
  const dir = tmpDir('paykit-reserve-');
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  await generateAll(config, dir, { csApiKey: 'pk_live_test' });
  await fs.mkdir(path.join(dir, 'node_modules'), { recursive: true });
  await fs.symlink(path.join(ROOT, 'packages/sdk/ts'), path.join(dir, 'node_modules/boilpayment-sdk'), 'dir');
  return { dir, env: envFromExample(await fs.readFile(path.join(dir, '.env.example'), 'utf8')) };
}

describe('EC:C10 generated reservations', () => {
  it('off by default: no reservations in the generated code or INTEGRATION.md', async () => {
    const { dir } = await generate(false);
    for (const f of ['paykit/index.ts', 'paykit/index.py', 'INTEGRATION.md']) {
      expect(await fs.readFile(path.join(dir, f), 'utf8')).not.toMatch(/reservation|sweepReservations|sweep_reservations/i);
    }
  }, 60_000);

  it('on: TS kit reserves, refuses the overflow, commits, releases and sweeps', async () => {
    const { dir, env } = await generate(true);
    expect(await fs.readFile(path.join(dir, 'INTEGRATION.md'), 'utf8')).toContain('cron.sweepReservations()');
    const harness = `
import assert from 'node:assert/strict';
import { createPaymentKit } from './paykit/index.js';
import { InMemoryRepo, InMemoryLedger, FixedClock, SequentialIdGen, NoopLogger } from 'boilpayment-sdk/core';
import config from './paykit.config.json' with { type: 'json' };
const clock = new FixedClock(new Date('2026-03-01T00:00:00Z'));
const ids = new SequentialIdGen('t');
const repo = new InMemoryRepo();
const ledger = new InMemoryLedger(ids, clock);
await repo.customers.put({ id: 'cus_1', email: null, providerRefs: [], status: 'active', createdAt: clock.now() });
await ledger.append({ customerId: 'cus_1', pool: 'paid', kind: 'grant', amount: 100, unitPriceMinor: null, currency: null, expiresAt: null, source: 'manual', reference: {}, idempotencyKey: 'seed', actor: 't', reason: 'seed' });
const kit = createPaymentKit(config, { clock, ids, repo, ledger, logger: new NoopLogger(), env: ${JSON.stringify(env)} });
const avail = async () => (await ledger.balance('cus_1', undefined, clock.now())).available;
assert.equal((await kit.reservations.reserve({ customerId: 'cus_1', jobId: 'a', amount: 70 })).ok, true);
assert.deepEqual(await kit.reservations.reserve({ customerId: 'cus_1', jobId: 'b', amount: 40 }), { ok: false, reason: 'insufficient', need: 40, available: 30 });
await kit.reservations.commit({ customerId: 'cus_1', jobId: 'a', amount: 45 });
assert.equal(await avail(), 55);
await kit.reservations.reserve({ customerId: 'cus_1', jobId: 'c', amount: 10 });
await kit.reservations.release({ customerId: 'cus_1', jobId: 'c' });
await kit.reservations.reserve({ customerId: 'cus_1', jobId: 'd', amount: 20 });
clock.advance((config.policy.usage.reservationTtlMinutes + 1) * 60000);
assert.deepEqual(await kit.cron.sweepReservations(), { expired: 1 });
assert.equal(await avail(), 55);
console.log(JSON.stringify((await kit.reservations.list('cus_1')).map((r) => [r.jobId, r.status])));
`;
    await fs.writeFile(path.join(dir, 'harness.ts'), harness);
    const res = spawnSync(path.join(ROOT, 'apps/cli/node_modules/.bin/tsx'), ['harness.ts'], { cwd: dir, encoding: 'utf8' });
    expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
    expect(JSON.parse(res.stdout.trim().split('\n').pop()!)).toEqual([['a', 'committed'], ['c', 'released'], ['d', 'expired']]);
  }, 120_000);

  it('on: Python kit does the same', async () => {
    const { dir, env } = await generate(true);
    const harness = `
import asyncio, importlib.util, json
from datetime import datetime, timezone
from boilpayment_core import Deps, InMemoryRepo, InMemoryLedger, FixedClock, SequentialIdGen, NoopLogger, Customer, NewLedgerEntry
spec = importlib.util.spec_from_file_location('generated', ${JSON.stringify(path.join(dir, 'paykit/index.py'))})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
async def main():
    clock = FixedClock(datetime(2026, 3, 1, tzinfo=timezone.utc))
    ids = SequentialIdGen('t')
    repo = InMemoryRepo()
    ledger = InMemoryLedger(ids, clock)
    await repo.customers.put(Customer(id='cus_1', email=None, provider_refs=[], status='active', created_at=clock.now()))
    await ledger.append(NewLedgerEntry(customer_id='cus_1', pool='paid', kind='grant', amount=100, source='manual', idempotency_key='seed', actor='t', reason='seed'))
    config = json.load(open(${JSON.stringify(path.join(dir, 'paykit.config.json'))}))
    kit = mod.create_payment_kit(config, Deps(clock=clock, ids=ids, repo=repo, ledger=ledger, logger=NoopLogger(), notifier=None, providers={}, policy=None), json.loads(${JSON.stringify(JSON.stringify(env))}))
    r = kit['reservations']
    async def avail():
        return (await ledger.balance('cus_1', None, clock.now())).available
    assert (await r['reserve'](customer_id='cus_1', job_id='a', amount=70)).ok
    b = await r['reserve'](customer_id='cus_1', job_id='b', amount=40)
    assert (b.ok, b.need, b.available) == (False, 40, 30)
    await r['commit'](customer_id='cus_1', job_id='a', amount=45)
    assert await avail() == 55
    await r['reserve'](customer_id='cus_1', job_id='c', amount=10)
    await r['release'](customer_id='cus_1', job_id='c')
    await r['reserve'](customer_id='cus_1', job_id='d', amount=20)
    clock.advance((config['policy']['usage']['reservationTtlMinutes'] + 1) * 60000)
    assert await kit['cron']['sweep_reservations']() == {'expired': 1}
    assert await avail() == 55
    print(json.dumps([[x.job_id, x.status] for x in await r['list']('cus_1')]))
asyncio.run(main())
`;
    await fs.writeFile(path.join(dir, 'harness.py'), harness);
    const res = spawnSync(path.join(ROOT, '.venv/bin/python'), [path.join(dir, 'harness.py')], { encoding: 'utf8' });
    expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
    expect(JSON.parse(res.stdout.trim().split('\n').pop()!)).toEqual([['a', 'committed'], ['c', 'released'], ['d', 'expired']]);
  }, 120_000);
});
