// Round-5 audit follow-up: Stripe and Polar renewals in a generated app, 3 periods, were NOT-TESTED
// (stripe-mock returns fixed fixtures; the Polar mock could not create renewal orders). Here:
//   Stripe — a small controllable Stripe API (invoices, subscriptions) over HTTP and signed invoice.paid
//            events, each delivered twice plus once more under a second event id;
//   Polar  — tools/mocks/polar's /__mock/renew creates the subscription_cycle order and /__mock/webhook
//            delivers the signed order.paid to the app, twice.
// Counted per period: grants (exactly one) and the subscription's period (advanced once).
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAll } from '../src/generate/index.js';
import { kitchenSinkConfig } from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const POLAR_PORT = 12900 + Math.floor(Math.random() * 400);
const POLAR = `http://127.0.0.1:${POLAR_PORT}`;
const dirs: string[] = [];
let polarMock: ChildProcess;
let stripeApi: http.Server;
let STRIPE = '';
const stripeState: { invoices: Record<string, unknown>; subscriptions: Record<string, unknown> } = { invoices: {}, subscriptions: {} };

beforeAll(async () => {
  polarMock = spawn(process.execPath, [path.join(ROOT, 'tools/mocks/polar/server.mjs')], { env: { ...process.env, POLAR_MOCK_PORT: String(POLAR_PORT), PORT: String(POLAR_PORT) }, stdio: 'ignore' });
  stripeApi = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (req.method === 'POST' && url.pathname === '/__set') {
        const s = JSON.parse(body);
        Object.assign(stripeState.invoices, s.invoices ?? {});
        Object.assign(stripeState.subscriptions, s.subscriptions ?? {});
        res.writeHead(200).end('{}');
        return;
      }
      const m = /^\/v1\/(invoices|subscriptions)\/([^/?]+)$/.exec(url.pathname);
      const found = m ? (stripeState as Record<string, Record<string, unknown>>)[m[1]][decodeURIComponent(m[2])] : undefined;
      res.writeHead(found ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(found ?? { error: { type: 'invalid_request_error', message: `no such ${url.pathname}` } }));
    });
  });
  await new Promise<void>((r) => stripeApi.listen(0, '127.0.0.1', () => r()));
  STRIPE = `http://127.0.0.1:${(stripeApi.address() as { port: number }).port}`;
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${POLAR}/`); return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('polar mock did not start');
});
afterAll(() => {
  polarMock?.kill();
  stripeApi?.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function generate(provider: 'stripe' | 'polar'): Promise<{ dir: string; env: Record<string, string>; plan: any }> {
  const config = kitchenSinkConfig();
  config.providers = [provider];
  config.models = ['subscription'];
  config.goods = ['credits'];
  config.cs.enabled = false;
  const plan = config.plans[0] as any;
  plan.prices = [{ currency: 'USD', amountMinor: provider === 'polar' ? 2900 : 1999, providerPriceRefs: { [provider]: provider === 'polar' ? 'prod_sub_basic' : 'price_basic' } }];
  const dir = mkdtempSync(path.join(os.tmpdir(), `paykit-${provider}-renew-`));
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
  for (const k of ['STRIPE_WEBHOOK_PREVIOUS_SECRETS', 'POLAR_WEBHOOK_PREVIOUS_SECRETS', 'DATABASE_URL']) delete env[k];
  Object.assign(env, provider === 'stripe'
    ? { STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_test_fake', STRIPE_API_BASE: STRIPE }
    : { POLAR_ACCESS_TOKEN: 'polar_oat_test_fake', POLAR_WEBHOOK_SECRET: 'whsec_c2VjcmV0a2V5Zm9ycG9sYXJ0ZXN0', POLAR_API_BASE: POLAR });
  return { dir, env, plan };
}

/** Async: the fake Stripe API lives in this process, so a blocking spawnSync would starve it. */
function run(cmd: string, args: string[], cwd: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

const MONTHS = [['2026-02-01', '2026-03-01'], ['2026-03-01', '2026-04-01'], ['2026-04-01', '2026-05-01']];
const sec = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 1000);

describe('generated native renewals, 3 periods (round-5 follow-up)', () => {
  it('Stripe TS: each signed invoice.paid grants its period once (redelivery and a duplicate event id grant nothing more)', async () => {
    const { dir, env, plan } = await generate('stripe');
    await fs.writeFile(path.join(dir, 'harness.ts'), `
import { createHmac } from 'node:crypto';
import { createPaymentKit } from './paykit/index.js';
import { InMemoryRepo, InMemoryLedger, FixedClock, SequentialIdGen, NoopLogger } from 'boilpayment-sdk/core';
import config from './paykit.config.json' with { type: 'json' };
const env = ${JSON.stringify(env)};
const clock = new FixedClock(new Date('2026-02-01T01:00:00Z'));
const ids = new SequentialIdGen('t');
const repo = new InMemoryRepo(); const ledger = new InMemoryLedger(ids, clock);
(config as any).plans = [${JSON.stringify(plan)}];
const kit = createPaymentKit(config as any, { clock, ids, repo, ledger, logger: new NoopLogger(), env } as any);
await repo.plans.put((config as any).plans[0]);
await repo.customers.put({ id: 'c1', email: null, providerRefs: [{ provider: 'stripe', ref: 'cus_1' }], status: 'active', createdAt: new Date('2026-01-01T00:00:00Z') } as any);
await repo.subscriptions.put({ id: 's1', customerId: 'c1', planId: (config as any).plans[0].id, provider: 'stripe', providerRef: 'sub_1', status: 'active', currentPeriod: { start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-02-01T00:00:00Z') }, anchorDay: 1, cancelAtPeriodEnd: false, graceUntil: null, billingKey: null, scheduledPlanId: null, version: 0, currency: 'USD', createdAt: new Date('2026-01-01T00:00:00Z') } as any);
const months = ${JSON.stringify(MONTHS)};
const sec = (iso: string) => Math.floor(Date.parse(iso + 'T00:00:00Z') / 1000);
const out: any[] = [];
for (let i = 0; i < months.length; i++) {
  const [s, e] = months[i];
  clock.advance(new Date(s + 'T01:00:00Z').getTime() - clock.now().getTime());
  const invoice = { id: 'in_' + i, object: 'invoice', status: 'paid', amount_paid: 1999, amount_due: 1999, currency: 'usd', customer: 'cus_1', created: sec(s),
    parent: { subscription_details: { subscription: 'sub_1', metadata: {} } }, lines: { data: [{ period: { start: sec(s), end: sec(e) } }] }, metadata: {} };
  const subscription = { id: 'sub_1', object: 'subscription', customer: 'cus_1', status: 'active', billing_cycle_anchor: sec('2026-01-01'), cancel_at_period_end: false,
    current_period_start: sec(s), current_period_end: sec(e), metadata: {}, items: { data: [] }, created: sec('2026-01-01') };
  await fetch(${JSON.stringify(STRIPE)} + '/__set', { method: 'POST', body: JSON.stringify({ invoices: { ['in_' + i]: invoice }, subscriptions: { sub_1: subscription } }) });
  const statuses: string[] = [];
  for (const evtId of ['evt_' + i, 'evt_' + i, 'evt_dup_' + i]) {
    const raw = JSON.stringify({ id: evtId, object: 'event', type: 'invoice.paid', created: Math.floor(Date.now() / 1000), livemode: false, api_version: '2025-03-31.basil', data: { object: invoice } });
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', env.STRIPE_WEBHOOK_SECRET).update(t + '.' + raw).digest('hex');
    const r: any = await kit.handleWebhook(raw, { 'stripe-signature': 't=' + t + ',v1=' + sig });
    statuses.push(String(r?.status ?? r?.record?.status ?? JSON.stringify(r)));
  }
  const grants = (await ledger.entries('c1', { kind: 'grant', source: 'subscription' } as any)).length;
  const sub = await repo.subscriptions.get('s1');
  out.push([s, grants, sub!.currentPeriod.end.toISOString().slice(0, 10), sub!.status]);
}
console.log(JSON.stringify(out));
`);
    const res = await run(path.join(ROOT, 'apps/cli/node_modules/.bin/tsx'), ['harness.ts'], dir);
    expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
    expect(JSON.parse(res.stdout.trim().split('\n').pop()!), res.stdout).toEqual([
      ['2026-02-01', 1, '2026-03-01', 'active'],
      ['2026-03-01', 2, '2026-04-01', 'active'],
      ['2026-04-01', 3, '2026-05-01', 'active'],
    ]);
  }, 120_000);

  it('Polar TS: each signed subscription_cycle order.paid grants its period once (delivered twice)', async () => {
    const { dir, env, plan } = await generate('polar');
    await fs.writeFile(path.join(dir, 'harness.ts'), `
import http from 'node:http';
import { createPaymentKit } from './paykit/index.js';
import { InMemoryRepo, InMemoryLedger, FixedClock, SequentialIdGen, NoopLogger } from 'boilpayment-sdk/core';
import config from './paykit.config.json' with { type: 'json' };
const env = ${JSON.stringify(env)};
const POLAR = ${JSON.stringify(POLAR)};
const auth = { Authorization: 'Bearer polar_oat_test_fake', 'Content-Type': 'application/json' };
const clock = new FixedClock(new Date());
const ids = new SequentialIdGen('t');
const repo = new InMemoryRepo(); const ledger = new InMemoryLedger(ids, clock);
(config as any).plans = [${JSON.stringify(plan)}];
const kit = createPaymentKit(config as any, { clock, ids, repo, ledger, logger: new NoopLogger(), env } as any);
const customer: any = await (await fetch(POLAR + '/v1/customers/', { method: 'POST', headers: auth, body: JSON.stringify({ email: 'c1@example.com' }) })).json();
const checkout: any = await (await fetch(POLAR + '/v1/checkouts/', { method: 'POST', headers: auth, body: JSON.stringify({ products: ['prod_sub_basic'], customer_id: customer.id }) })).json();
const subId = checkout._mock_subscription_id;
const remote: any = await (await fetch(POLAR + '/v1/subscriptions/' + subId, { headers: auth })).json();
await repo.plans.put((config as any).plans[0]);
await repo.customers.put({ id: 'c1', email: 'c1@example.com', providerRefs: [{ provider: 'polar', ref: customer.id }], status: 'active', createdAt: new Date() } as any);
await repo.subscriptions.put({ id: 's1', customerId: 'c1', planId: (config as any).plans[0].id, provider: 'polar', providerRef: subId, status: 'active', currentPeriod: { start: new Date(remote.current_period_start), end: new Date(remote.current_period_end) }, anchorDay: new Date(remote.current_period_start).getUTCDate(), cancelAtPeriodEnd: false, graceUntil: null, billingKey: null, scheduledPlanId: null, version: 0, currency: 'USD', createdAt: new Date() } as any);
const results: string[] = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    try { const r: any = await kit.handleWebhook(body, req.headers as any); results.push(String(r?.status ?? 'ok')); res.writeHead(200).end('{}'); }
    catch (err) { results.push('error:' + (err as Error).message); res.writeHead(500).end('{}'); }
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const hook = 'http://127.0.0.1:' + (server.address() as any).port + '/webhook';
const out: any[] = [];
for (let i = 0; i < 3; i++) {
  const renewed: any = await (await fetch(POLAR + '/__mock/renew', { method: 'POST', headers: auth, body: JSON.stringify({ subscription_id: subId }) })).json();
  clock.advance(new Date(renewed.period_start).getTime() + 3_600_000 - clock.now().getTime());
  for (let k = 0; k < 2; k++) await fetch(POLAR + '/__mock/webhook', { method: 'POST', headers: auth, body: JSON.stringify({ url: hook, secret: env.POLAR_WEBHOOK_SECRET, type: 'order.paid', id: renewed.order_id }) });
  const grants = (await ledger.entries('c1', { kind: 'grant', source: 'subscription' } as any)).length;
  const sub = await repo.subscriptions.get('s1');
  out.push([i, grants, sub!.currentPeriod.end.toISOString() === new Date(renewed.period_end).toISOString(), sub!.status]);
}
server.close();
console.log(JSON.stringify({ out, errors: results.filter((r) => r.startsWith('error')) }));
`);
    const res = await run(path.join(ROOT, 'apps/cli/node_modules/.bin/tsx'), ['harness.ts'], dir);
    expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
    const result = JSON.parse(res.stdout.trim().split('\n').pop()!);
    expect(result.errors).toEqual([]);
    expect(result.out, JSON.stringify(result)).toEqual([[0, 1, true, 'active'], [1, 2, true, 'active'], [2, 3, true, 'active']]);
  }, 120_000);

  const PY_PRELUDE = (dir: string, env: Record<string, string>, plan: unknown) => `
import asyncio, hashlib, hmac, importlib.util, json, time, urllib.request
from datetime import datetime, timezone, timedelta
from boilpayment_core import Customer, Deps, InMemoryRepo, InMemoryLedger, FixedClock, SequentialIdGen, NoopLogger, Period, Plan, PlanPrice, ProviderRef, Subscription
spec = importlib.util.spec_from_file_location('generated', ${JSON.stringify(path.join(dir, 'paykit/index.py'))})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
ENV = json.loads(${JSON.stringify(JSON.stringify(env))})
P = json.loads(${JSON.stringify(JSON.stringify(plan))})
def d(s):
    return datetime.fromisoformat(s).astimezone(timezone.utc)
def post(url, body, headers=None):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method='POST', headers={'Content-Type': 'application/json', **(headers or {})})
    return json.loads(urllib.request.urlopen(req).read() or b'{}')
def plan_obj():
    return Plan(id=P['id'], name=P['name'], interval=P['interval'], credits_per_period=P['creditsPerPeriod'], usage_included=P['usageIncluded'], trial_days=P['trialDays'],
                prices=[PlanPrice(currency=x['currency'], amount_minor=x['amountMinor'], provider_price_refs=x.get('providerPriceRefs') or {}) for x in P['prices']])
async def subscription_grants(ledger):
    return len([e for e in await ledger.entries('c1') if e.kind == 'grant' and e.source == 'subscription'])
`;

  it('Stripe Python: each signed invoice.paid grants its period once', async () => {
    const { dir, env, plan } = await generate('stripe');
    await fs.writeFile(path.join(dir, 'harness.py'), PY_PRELUDE(dir, env, plan) + `
async def main():
    clock = FixedClock(d('2026-02-01T01:00:00Z'))
    ids = SequentialIdGen('t')
    repo = InMemoryRepo(); ledger = InMemoryLedger(ids, clock)
    config = json.load(open(${JSON.stringify(path.join(dir, 'paykit.config.json'))}))
    config['plans'] = [P]
    kit = mod.create_payment_kit(config, Deps(clock=clock, ids=ids, repo=repo, ledger=ledger, logger=NoopLogger(), notifier=None, providers={}, policy=None), ENV)
    await repo.plans.put(plan_obj())
    await repo.customers.put(Customer(id='c1', email=None, provider_refs=[ProviderRef(provider='stripe', ref='cus_1')], status='active', created_at=d('2026-01-01T00:00:00Z')))
    await repo.subscriptions.put(Subscription(id='s1', customer_id='c1', plan_id=P['id'], provider='stripe', provider_ref='sub_1', status='active', current_period=Period(start=d('2026-01-01T00:00:00Z'), end=d('2026-02-01T00:00:00Z')), anchor_day=1, cancel_at_period_end=False, grace_until=None, billing_key=None, scheduled_plan_id=None, version=0, currency='USD', created_at=d('2026-01-01T00:00:00Z')))
    months = ${JSON.stringify(MONTHS)}
    sec = lambda iso: int(d(iso + 'T00:00:00Z').timestamp())
    out = []
    for i, (s, e) in enumerate(months):
        clock.advance(int((d(s + 'T01:00:00Z') - clock.now()).total_seconds() * 1000))
        invoice = {'id': f'in_py_{i}', 'object': 'invoice', 'status': 'paid', 'amount_paid': 1999, 'amount_due': 1999, 'currency': 'usd', 'customer': 'cus_1', 'created': sec(s),
                   'parent': {'subscription_details': {'subscription': 'sub_1', 'metadata': {}}}, 'lines': {'data': [{'period': {'start': sec(s), 'end': sec(e)}}]}, 'metadata': {}}
        subscription = {'id': 'sub_1', 'object': 'subscription', 'customer': 'cus_1', 'status': 'active', 'billing_cycle_anchor': sec('2026-01-01'), 'cancel_at_period_end': False,
                        'current_period_start': sec(s), 'current_period_end': sec(e), 'metadata': {}, 'items': {'data': []}, 'created': sec('2026-01-01')}
        post(${JSON.stringify(STRIPE)} + '/__set', {'invoices': {f'in_py_{i}': invoice}, 'subscriptions': {'sub_1': subscription}})
        for evt in [f'evt_py_{i}', f'evt_py_{i}', f'evt_py_dup_{i}']:
            raw = json.dumps({'id': evt, 'object': 'event', 'type': 'invoice.paid', 'created': int(time.time()), 'livemode': False, 'api_version': '2025-03-31.basil', 'data': {'object': invoice}})
            t = int(time.time())
            sig = hmac.new(ENV['STRIPE_WEBHOOK_SECRET'].encode(), f'{t}.{raw}'.encode(), hashlib.sha256).hexdigest()
            await kit['handle_webhook'](raw, {'stripe-signature': f't={t},v1={sig}'})
        sub = await repo.subscriptions.get('s1')
        out.append([s, await subscription_grants(ledger), sub.current_period.end.date().isoformat(), sub.status])
    print(json.dumps(out))
asyncio.run(main())
`);
    const res = await run(path.join(ROOT, '.venv/bin/python'), [path.join(dir, 'harness.py')], dir);
    expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
    expect(JSON.parse(res.stdout.trim().split('\n').pop()!), res.stdout).toEqual([
      ['2026-02-01', 1, '2026-03-01', 'active'],
      ['2026-03-01', 2, '2026-04-01', 'active'],
      ['2026-04-01', 3, '2026-05-01', 'active'],
    ]);
  }, 120_000);

  it('Polar Python: each signed subscription_cycle order.paid grants its period once (delivered twice)', async () => {
    const { dir, env, plan } = await generate('polar');
    await fs.writeFile(path.join(dir, 'harness.py'), PY_PRELUDE(dir, env, plan) + `
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
POLAR = ${JSON.stringify(POLAR)}
AUTH = {'Authorization': 'Bearer polar_oat_test_fake'}
def get(url):
    return json.loads(urllib.request.urlopen(urllib.request.Request(url, headers=AUTH)).read())
async def main():
    loop = asyncio.get_running_loop()
    clock = FixedClock(datetime.now(timezone.utc))
    ids = SequentialIdGen('t')
    repo = InMemoryRepo(); ledger = InMemoryLedger(ids, clock)
    config = json.load(open(${JSON.stringify(path.join(dir, 'paykit.config.json'))}))
    config['plans'] = [P]
    kit = mod.create_payment_kit(config, Deps(clock=clock, ids=ids, repo=repo, ledger=ledger, logger=NoopLogger(), notifier=None, providers={}, policy=None), ENV)
    customer = post(POLAR + '/v1/customers/', {'email': 'c1@example.com'}, AUTH)
    checkout = post(POLAR + '/v1/checkouts/', {'products': ['prod_sub_basic'], 'customer_id': customer['id']}, AUTH)
    sub_id = checkout['_mock_subscription_id']
    remote = get(POLAR + '/v1/subscriptions/' + sub_id)
    await repo.plans.put(plan_obj())
    await repo.customers.put(Customer(id='c1', email='c1@example.com', provider_refs=[ProviderRef(provider='polar', ref=customer['id'])], status='active', created_at=clock.now()))
    start = d(remote['current_period_start']); end = d(remote['current_period_end'])
    await repo.subscriptions.put(Subscription(id='s1', customer_id='c1', plan_id=P['id'], provider='polar', provider_ref=sub_id, status='active', current_period=Period(start=start, end=end), anchor_day=start.day, cancel_at_period_end=False, grace_until=None, billing_key=None, scheduled_plan_id=None, version=0, currency='USD', created_at=clock.now()))
    errors = []
    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers.get('content-length') or 0)).decode()
            fut = asyncio.run_coroutine_threadsafe(kit['handle_webhook'](body, {k.lower(): v for k, v in self.headers.items()}), loop)
            try:
                fut.result(timeout=30); self.send_response(200)
            except Exception as err:  # noqa: BLE001
                errors.append(str(err)); self.send_response(500)
            self.end_headers(); self.wfile.write(b'{}')
        def log_message(self, *a):
            pass
    server = HTTPServer(('127.0.0.1', 0), H)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    hook = f'http://127.0.0.1:{server.server_address[1]}/webhook'
    out = []
    for i in range(3):
        renewed = await loop.run_in_executor(None, lambda: post(POLAR + '/__mock/renew', {'subscription_id': sub_id}, AUTH))
        clock.advance(int((d(renewed['period_start']) + timedelta(hours=1) - clock.now()).total_seconds() * 1000))
        for _ in range(2):
            await loop.run_in_executor(None, lambda: post(POLAR + '/__mock/webhook', {'url': hook, 'secret': ENV['POLAR_WEBHOOK_SECRET'], 'type': 'order.paid', 'id': renewed['order_id']}, AUTH))
        sub = await repo.subscriptions.get('s1')
        out.append([i, await subscription_grants(ledger), sub.current_period.end == d(renewed['period_end']), sub.status])
    server.shutdown()
    print(json.dumps({'out': out, 'errors': errors}))
asyncio.run(main())
`);
    const res = await run(path.join(ROOT, '.venv/bin/python'), [path.join(dir, 'harness.py')], dir);
    expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
    const result = JSON.parse(res.stdout.trim().split('\n').pop()!);
    expect(result.errors).toEqual([]);
    expect(result.out, JSON.stringify(result)).toEqual([[0, 1, true, 'active'], [1, 2, true, 'active'], [2, 3, true, 'active']]);
  }, 120_000);
});
