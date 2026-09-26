// [EC:C11] Round-3 audit L1 (reopened): the generated kit owns `consume` and `reservations.reserve`,
// so it checks the customer's subscription there. Before, the generated reserve passed no `sub`
// (the C11 guard never ran) and consume spent credits for a paused subscription. Runs the actual
// generated TS and Python entries against in-memory stores.
import { describe, it, expect, afterAll } from 'vitest';
import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAll } from '../src/generate/index.js';
import { kitchenSinkConfig } from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function envFromExample(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const eq = line.indexOf('=');
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).split(' #')[0].trim() || 'x';
  }
  out.TOSS_WEBHOOK_ALLOWED_IPS = '203.0.113.10';
  return out;
}

describe('[EC:C11] generated consume and reserve check the subscription', () => {
  it('[EC:C11] paused refuses consume and reserve; canceled keeps bought credits for consume; active reserves', async () => {
    const config = kitchenSinkConfig();
    config.providers = ['toss'];
    config.models = ['subscription', 'topup'];
    config.goods = ['credits'];
    config.cs.enabled = false;
    (config as { reservations?: boolean }).reservations = true;
    const dir = mkdtempSync(path.join(os.tmpdir(), 'paykit-entitlement-'));
    dirs.push(dir);
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    await generateAll(config, dir);
    const env = envFromExample(await fs.readFile(path.join(dir, '.env.example'), 'utf8'));
    await fs.mkdir(path.join(dir, 'node_modules'), { recursive: true });
    await fs.symlink(path.join(ROOT, 'packages/sdk/ts'), path.join(dir, 'node_modules/boilpayment-sdk'), 'dir');

    const ts = `
import { createPaymentKit } from './paykit/index.js';
import { InMemoryRepo, InMemoryLedger, FixedClock, SequentialIdGen, NoopLogger } from 'boilpayment-sdk/core';
import config from './paykit.config.json' with { type: 'json' };
const clock = new FixedClock(new Date('2026-03-01T00:00:00Z'));
const ids = new SequentialIdGen('t');
const repo = new InMemoryRepo(); const ledger = new InMemoryLedger(ids, clock);
const kit = createPaymentKit(config as any, { clock, ids, repo, ledger, logger: new NoopLogger(), env: ${JSON.stringify(env)} } as any);
await ledger.append({ customerId: 'c1', pool: 'paid', kind: 'grant', amount: 100, unitPriceMinor: null, currency: null, expiresAt: null, source: 'topup', reference: {}, idempotencyKey: 'g', actor: 't', reason: null });
const sub = { id: 's1', customerId: 'c1', planId: config.plans[0]?.id ?? 'p', provider: 'toss', providerRef: null, status: 'paused', currentPeriod: { start: clock.now(), end: new Date('2026-04-01T00:00:00Z') }, anchorDay: 1, cancelAtPeriodEnd: false, graceUntil: null, billingKey: 'bk', scheduledPlanId: null, version: 0, currency: 'KRW', createdAt: clock.now() };
await repo.subscriptions.put(sub as any);
const out: unknown[] = [];
try { await kit.consume({ customerId: 'c1', amount: 10, idempotencyKey: 'k1' }); out.push('consumed'); } catch (e) { out.push((e as { code?: string }).code); }
out.push((await kit.reservations.reserve({ customerId: 'c1', jobId: 'j1', amount: 10 }) as { reason?: string }).reason ?? 'reserved');
await repo.subscriptions.put({ ...(await repo.subscriptions.get('s1'))!, status: 'canceled' } as any);
out.push((await kit.consume({ customerId: 'c1', amount: 10, idempotencyKey: 'k2' })).ok);
out.push((await kit.reservations.reserve({ customerId: 'c1', jobId: 'j2', amount: 10 }) as { reason?: string }).reason ?? 'reserved');
await repo.subscriptions.put({ ...(await repo.subscriptions.get('s1'))!, status: 'active' } as any);
out.push((await kit.reservations.reserve({ customerId: 'c1', jobId: 'j3', amount: 10 }) as { ok: boolean }).ok);
console.log(JSON.stringify(out));
`;
    await fs.writeFile(path.join(dir, 'harness.ts'), ts);
    const py = `
import asyncio, importlib.util, json, dataclasses
from datetime import datetime, timezone
from boilpayment_core import Deps, InMemoryRepo, InMemoryLedger, FixedClock, SequentialIdGen, NoopLogger, NewLedgerEntry, LedgerReference, Subscription, Period
spec = importlib.util.spec_from_file_location('generated', ${JSON.stringify(path.join(dir, 'paykit/index.py'))})
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
async def main():
    clock = FixedClock(datetime(2026, 3, 1, tzinfo=timezone.utc)); ids = SequentialIdGen('t')
    repo = InMemoryRepo(); ledger = InMemoryLedger(ids, clock)
    config = json.load(open(${JSON.stringify(path.join(dir, 'paykit.config.json'))}))
    kit = mod.create_payment_kit(config, Deps(clock=clock, ids=ids, repo=repo, ledger=ledger, logger=NoopLogger(), notifier=None, providers={}, policy=None), json.loads(${JSON.stringify(JSON.stringify(env))}))
    await ledger.append(NewLedgerEntry(customer_id='c1', pool='paid', kind='grant', amount=100, unit_price_minor=None, currency=None, expires_at=None, source='topup', reference=LedgerReference(), idempotency_key='g', actor='t'))
    plan_id = config['plans'][0]['id'] if config['plans'] else 'p'
    await repo.subscriptions.put(Subscription(id='s1', customer_id='c1', plan_id=plan_id, provider='toss', provider_ref=None, status='paused', current_period=Period(start=clock.now(), end=datetime(2026, 4, 1, tzinfo=timezone.utc)), anchor_day=1, cancel_at_period_end=False, grace_until=None, billing_key='bk', scheduled_plan_id=None, version=0, currency='KRW', created_at=clock.now()))
    out = []
    try:
        await kit['consume'](customer_id='c1', amount=10, idempotency_key='k1'); out.append('consumed')
    except Exception as e:
        out.append(getattr(e, 'code', str(e)))
    r = await kit['reservations']['reserve'](customer_id='c1', job_id='j1', amount=10); out.append(getattr(r, 'reason', None) or 'reserved')
    await repo.subscriptions.put(dataclasses.replace(await repo.subscriptions.get('s1'), status='canceled'))
    out.append((await kit['consume'](customer_id='c1', amount=10, idempotency_key='k2')).ok)
    r = await kit['reservations']['reserve'](customer_id='c1', job_id='j2', amount=10); out.append(getattr(r, 'reason', None) or 'reserved')
    await repo.subscriptions.put(dataclasses.replace(await repo.subscriptions.get('s1'), status='active'))
    r = await kit['reservations']['reserve'](customer_id='c1', job_id='j3', amount=10); out.append(r.ok)
    print(json.dumps(out))
asyncio.run(main())
`;
    await fs.writeFile(path.join(dir, 'harness.py'), py);
    const tsRes = spawnSync(path.join(ROOT, 'apps/cli/node_modules/.bin/tsx'), ['harness.ts'], { cwd: dir, encoding: 'utf8' });
    const pyRes = spawnSync(path.join(ROOT, '.venv/bin/python'), [path.join(dir, 'harness.py')], { encoding: 'utf8' });
    expect(tsRes.status, `${tsRes.stdout}\n${tsRes.stderr}`).toBe(0);
    expect(pyRes.status, `${pyRes.stdout}\n${pyRes.stderr}`).toBe(0);
    const expected = ['subscription_inactive', 'subscription_inactive', true, 'subscription_inactive', true];
    expect(JSON.parse(tsRes.stdout.trim().split('\n').pop()!)).toEqual(expected);
    expect(JSON.parse(pyRes.stdout.trim().split('\n').pop()!)).toEqual(expected);
  }, 120_000);
  it('[EC:A44] usageDuringGrace=block refuses consume and reserve while past_due; reserve refuses another customer\'s subscription', async () => {
    const config = kitchenSinkConfig();
    config.providers = ['toss'];
    config.models = ['subscription', 'topup'];
    config.goods = ['credits'];
    config.cs.enabled = false;
    (config as { reservations?: boolean }).reservations = true;
    config.policy.dunning.usageDuringGrace = 'block';
    const dir = mkdtempSync(path.join(os.tmpdir(), 'paykit-grace-'));
    dirs.push(dir);
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    await generateAll(config, dir);
    const env = envFromExample(await fs.readFile(path.join(dir, '.env.example'), 'utf8'));
    await fs.mkdir(path.join(dir, 'node_modules'), { recursive: true });
    await fs.symlink(path.join(ROOT, 'packages/sdk/ts'), path.join(dir, 'node_modules/boilpayment-sdk'), 'dir');

    const ts = `
import { createPaymentKit } from './paykit/index.js';
import { InMemoryRepo, InMemoryLedger, FixedClock, SequentialIdGen, NoopLogger } from 'boilpayment-sdk/core';
import config from './paykit.config.json' with { type: 'json' };
const clock = new FixedClock(new Date('2026-03-01T00:00:00Z'));
const ids = new SequentialIdGen('t');
const repo = new InMemoryRepo(); const ledger = new InMemoryLedger(ids, clock);
const kit = createPaymentKit(config as any, { clock, ids, repo, ledger, logger: new NoopLogger(), env: ${JSON.stringify(env)} } as any);
await ledger.append({ customerId: 'c1', pool: 'paid', kind: 'grant', amount: 100, unitPriceMinor: null, currency: null, expiresAt: null, source: 'topup', reference: {}, idempotencyKey: 'g', actor: 't', reason: null });
const sub = { id: 's1', customerId: 'c1', planId: config.plans[0]?.id ?? 'p', provider: 'toss', providerRef: null, status: 'past_due', currentPeriod: { start: clock.now(), end: new Date('2026-04-01T00:00:00Z') }, anchorDay: 1, cancelAtPeriodEnd: false, graceUntil: null, billingKey: 'bk', scheduledPlanId: null, version: 0, currency: 'KRW', createdAt: clock.now() };
await repo.subscriptions.put(sub as any);
const out: unknown[] = [];
try { await kit.consume({ customerId: 'c1', amount: 10, idempotencyKey: 'k1' }); out.push('consumed'); } catch (e) { out.push((e as { code?: string }).code); }
try { await kit.reservations.reserve({ customerId: 'c1', jobId: 'j1', amount: 10 }); out.push('reserved'); } catch (e) { out.push((e as { code?: string }).code); }
await repo.subscriptions.put({ ...(sub as any), id: 's_other', customerId: 'c2', status: 'active' } as any);
await repo.subscriptions.put({ ...(await repo.subscriptions.get('s1'))!, status: 'paused' } as any);
try { await kit.reservations.reserve({ customerId: 'c1', jobId: 'j2', amount: 10, subscriptionId: 's_other' }); out.push('reserved'); } catch (e) { out.push((e as { code?: string }).code); }
console.log(JSON.stringify(out));
`;
    await fs.writeFile(path.join(dir, 'harness.ts'), ts);
    const py = `
import asyncio, importlib.util, json, dataclasses
from datetime import datetime, timezone
from boilpayment_core import Deps, InMemoryRepo, InMemoryLedger, FixedClock, SequentialIdGen, NoopLogger, NewLedgerEntry, LedgerReference, Subscription, Period
spec = importlib.util.spec_from_file_location('generated', ${JSON.stringify(path.join(dir, 'paykit/index.py'))})
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
async def main():
    clock = FixedClock(datetime(2026, 3, 1, tzinfo=timezone.utc)); ids = SequentialIdGen('t')
    repo = InMemoryRepo(); ledger = InMemoryLedger(ids, clock)
    config = json.load(open(${JSON.stringify(path.join(dir, 'paykit.config.json'))}))
    kit = mod.create_payment_kit(config, Deps(clock=clock, ids=ids, repo=repo, ledger=ledger, logger=NoopLogger(), notifier=None, providers={}, policy=None), json.loads(${JSON.stringify(JSON.stringify(env))}))
    await ledger.append(NewLedgerEntry(customer_id='c1', pool='paid', kind='grant', amount=100, unit_price_minor=None, currency=None, expires_at=None, source='topup', reference=LedgerReference(), idempotency_key='g', actor='t'))
    plan_id = config['plans'][0]['id'] if config['plans'] else 'p'
    await repo.subscriptions.put(Subscription(id='s1', customer_id='c1', plan_id=plan_id, provider='toss', provider_ref=None, status='past_due', current_period=Period(start=clock.now(), end=datetime(2026, 4, 1, tzinfo=timezone.utc)), anchor_day=1, cancel_at_period_end=False, grace_until=None, billing_key='bk', scheduled_plan_id=None, version=0, currency='KRW', created_at=clock.now()))
    out = []
    for call in (lambda: kit['consume'](customer_id='c1', amount=10, idempotency_key='k1'), lambda: kit['reservations']['reserve'](customer_id='c1', job_id='j1', amount=10)):
        try:
            await call(); out.append('done')
        except Exception as e:
            out.append(getattr(e, 'code', str(e)))
    s1 = await repo.subscriptions.get('s1')
    await repo.subscriptions.put(dataclasses.replace(s1, id='s_other', customer_id='c2', status='active'))
    await repo.subscriptions.put(dataclasses.replace(s1, status='paused'))
    try:
        await kit['reservations']['reserve'](customer_id='c1', job_id='j2', amount=10, subscription_id='s_other'); out.append('reserved')
    except Exception as e:
        out.append(getattr(e, 'code', str(e)))
    print(json.dumps(out))
asyncio.run(main())
`;
    await fs.writeFile(path.join(dir, 'harness.py'), py);
    const tsRes = spawnSync(path.join(ROOT, 'apps/cli/node_modules/.bin/tsx'), ['harness.ts'], { cwd: dir, encoding: 'utf8' });
    const pyRes = spawnSync(path.join(ROOT, '.venv/bin/python'), [path.join(dir, 'harness.py')], { encoding: 'utf8' });
    expect(tsRes.status, `${tsRes.stdout}\n${tsRes.stderr}`).toBe(0);
    expect(pyRes.status, `${pyRes.stdout}\n${pyRes.stderr}`).toBe(0);
    const expected = ['grace_usage_blocked', 'grace_usage_blocked', 'subscription_not_owned'];
    expect(JSON.parse(tsRes.stdout.trim().split('\n').pop()!)).toEqual(expected);
    expect(JSON.parse(pyRes.stdout.trim().split('\n').pop()!)).toEqual(expected);
  }, 120_000);
});
