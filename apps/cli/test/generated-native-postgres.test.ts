// Round-6 audit follow-up (I-4): the native-renewal tests ran on in-memory stores with UTC only and
// covered payments only, so a Stripe renewal's dashboard refund and dispute (EC:E24: they name the
// PaymentIntent, the row is recorded under the invoice; the fallback case hit the cs_cases FK) and a
// Python grant key that depended on the Postgres session timezone (EC:J11) went unseen. Here, on
// Postgres whose database default timezone is Asia/Seoul, TS and Python:
//   Stripe — Feb invoice.paid (twice + a second event id), Mar paid then refunded from the dashboard
//            inside its period (refund.created twice), Apr paid then disputed (charge.dispute.created);
//   Polar  — P1 order.paid twice, P2 order.paid then refunded from the dashboard (refund.created twice).
// Counted: one grant per period, the refund revokes that period's credits, the dispute freezes the
// customer, every webhook record ends processed, one grant key per period.
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAll } from '../src/generate/index.js';
import { kitchenSinkConfig } from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const STRIPE_PORT = 13300 + Math.floor(Math.random() * 300);
const POLAR_PORT = 13700 + Math.floor(Math.random() * 300);
const STRIPE = `http://127.0.0.1:${STRIPE_PORT}`;
const POLAR = `http://127.0.0.1:${POLAR_PORT}`;
const MODULES = ['core', 'credits', 'webhook', 'refund', 'cs'];
const dirs: string[] = [];
const dbs: string[] = [];
const mocks: ChildProcess[] = [];

async function up(url: string) {
  for (let i = 0; i < 50; i++) {
    try { await fetch(url); return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`mock did not start: ${url}`);
}
beforeAll(async () => {
  mocks.push(spawn(process.execPath, [path.join(ROOT, 'tools/mocks/stripe-renewals/server.mjs')], { env: { ...process.env, STRIPE_FAKE_PORT: String(STRIPE_PORT) }, stdio: 'ignore' }));
  mocks.push(spawn(process.execPath, [path.join(ROOT, 'tools/mocks/polar/server.mjs')], { env: { ...process.env, POLAR_MOCK_PORT: String(POLAR_PORT), PORT: String(POLAR_PORT) }, stdio: 'ignore' }));
  await up(`${STRIPE}/__state`);
  await up(`${POLAR}/`);
});
afterAll(() => {
  for (const m of mocks) m.kill();
  for (const db of dbs) spawnSync('dropdb', ['-h', '127.0.0.1', '--if-exists', '--force', db]);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A database whose sessions default to Asia/Seoul, as on a Korean server (the Python kit pins UTC itself). */
function seoulDb(tag: string): string {
  const db = `paykit_test_native_pg_${tag}_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
  spawnSync('createdb', ['-h', '127.0.0.1', db]);
  dbs.push(db);
  const r = spawnSync('psql', ['-h', '127.0.0.1', '-d', db, '-c', `alter database ${db} set timezone to 'Asia/Seoul'`], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return `postgres://127.0.0.1/${db}`;
}

async function generate(provider: 'stripe' | 'polar') {
  const config = kitchenSinkConfig();
  config.providers = [provider];
  config.models = ['subscription'];
  config.goods = ['credits'];
  const plan = config.plans[0] as any;
  plan.prices = [{ currency: 'USD', amountMinor: provider === 'polar' ? 2900 : 1999, providerPriceRefs: { [provider]: provider === 'polar' ? 'prod_sub_basic' : 'price_basic' } }];
  const dir = mkdtempSync(path.join(os.tmpdir(), `paykit-${provider}-pg-`));
  dirs.push(dir);
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  config.plans = [plan];
  await generateAll(config, dir);
  await fs.mkdir(path.join(dir, 'node_modules'), { recursive: true });
  await fs.symlink(path.join(ROOT, 'packages/sdk/ts'), path.join(dir, 'node_modules/boilpayment-sdk'), 'dir');
  const env: Record<string, string> = provider === 'stripe'
    ? { STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_test_fake', STRIPE_API_BASE: STRIPE }
    : { POLAR_ACCESS_TOKEN: 'polar_oat_test_fake', POLAR_WEBHOOK_SECRET: 'whsec_c2VjcmV0a2V5Zm9ycG9sYXJ0ZXN0', POLAR_API_BASE: POLAR };
  return { dir, env, plan };
}

function run(cmd: string, args: string[], cwd: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
const last = (s: string) => JSON.parse(s.trim().split('\n').pop()!);
const TSX = path.join(ROOT, 'apps/cli/node_modules/.bin/tsx');
const PY = path.join(ROOT, '.venv/bin/python');

/** Shared expectations: one grant per period, the refunded period revoked in full, nothing left unprocessed. */
function expectLedger(out: any, periods: number, refundedPeriod: number) {
  expect(out.grantsPerPeriod, JSON.stringify(out)).toEqual(Array(periods).fill(1));
  expect(out.distinctGrantKeys).toBe(periods);
  expect(out.revokes, JSON.stringify(out)).toEqual(out.revokes.map((_: number, i: number) => (i === refundedPeriod ? -1000 : 0)));
  expect(out.notProcessed, JSON.stringify(out)).toEqual([]);
}

describe('generated native renewals on Postgres (Asia/Seoul sessions): refunds, disputes, redelivery', () => {
  const stripeTs = (dsn: string, env: Record<string, string>) => `
import { createHmac } from 'node:crypto';
import { createPaymentKit } from './paykit/index.js';
import { FixedClock, SequentialIdGen, NoopLogger, CollectingNotifier } from 'boilpayment-sdk/core';
import { createPool, createPostgresRepo, PostgresLedgerStore, migrate } from 'boilpayment-sdk/postgres';
import config from './paykit.config.json' with { type: 'json' };
const BASE = ${JSON.stringify(STRIPE)};
const pool = createPool(${JSON.stringify(dsn)}, { max: 4 });
await migrate({ pool, modules: ${JSON.stringify(MODULES)} } as any);
const clock = new FixedClock(new Date('2026-02-01T01:00:00Z'));
const repo = createPostgresRepo(pool as any); const ledger = new PostgresLedgerStore(pool as any);
const env: any = ${JSON.stringify(env)};
const kit: any = createPaymentKit(config as any, { clock, ids: new SequentialIdGen('h'), repo, ledger, logger: new NoopLogger(), notifier: new CollectingNotifier(), env } as any);
const plan = config.plans[0] as any;
await repo.plans.put(plan);
await repo.customers.put({ id: 'c1', email: null, providerRefs: [{ provider: 'stripe', ref: 'cus_1' }], status: 'active', createdAt: clock.now() } as any);
await repo.subscriptions.put({ id: 's1', customerId: 'c1', planId: plan.id, provider: 'stripe', providerRef: 'sub_1', status: 'active', currentPeriod: { start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-02-01T00:00:00Z') }, anchorDay: 1, cancelAtPeriodEnd: false, graceUntil: null, billingKey: null, scheduledPlanId: null, version: 0, currency: 'USD', createdAt: clock.now() } as any);
const sec = (iso: string) => Math.floor(Date.parse(iso + 'T00:00:00Z') / 1000);
const set = (s: any) => fetch(BASE + '/__set', { method: 'POST', body: JSON.stringify(s) });
const at = (iso: string) => clock.advance(new Date(iso).getTime() - clock.now().getTime());
async function deliver(type: string, obj: any, id: string) {
  const raw = JSON.stringify({ id, object: 'event', type, created: Math.floor(Date.now() / 1000), livemode: false, api_version: '2025-03-31.basil', data: { object: obj } });
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', env.STRIPE_WEBHOOK_SECRET).update(t + '.' + raw).digest('hex');
  await kit.handleWebhook(raw, { 'stripe-signature': 't=' + t + ',v1=' + sig });
}
async function paid(i: number, s: string, e: string, eventIds: string[]) {
  const inv = { id: 'in_' + i, object: 'invoice', status: 'paid', amount_paid: 1999, amount_due: 1999, currency: 'usd', customer: 'cus_1', created: sec(s),
    parent: { subscription_details: { subscription: 'sub_1', metadata: {} } }, lines: { data: [{ period: { start: sec(s), end: sec(e) } }] }, metadata: {},
    payments: { data: [{ payment: { payment_intent: 'pi_' + i } }] } };
  const pi = { id: 'pi_' + i, object: 'payment_intent', amount: 1999, currency: 'usd', customer: 'cus_1', status: 'succeeded', invoice: 'in_' + i, metadata: {},
    last_payment_error: null, latest_charge: { id: 'ch_' + i, object: 'charge', amount: 1999, amount_refunded: 0, refunded: false, disputed: false } };
  const sub = { id: 'sub_1', object: 'subscription', customer: 'cus_1', status: 'active', billing_cycle_anchor: sec('2026-01-01'), cancel_at_period_end: false,
    current_period_start: sec(s), current_period_end: sec(e), metadata: {}, items: { data: [{ current_period_start: sec(s), current_period_end: sec(e) }] }, created: sec('2026-01-01') };
  await set({ invoices: { [inv.id]: inv }, payment_intents: { [pi.id]: pi }, subscriptions: { sub_1: sub } });
  for (const id of eventIds) await deliver('invoice.paid', inv, id);
}
at('2026-02-01T01:00:00Z'); await paid(0, '2026-02-01', '2026-03-01', ['evt_0', 'evt_0', 'evt_0_dup']);
at('2026-03-01T01:00:00Z'); await paid(1, '2026-03-01', '2026-04-01', ['evt_1']);
at('2026-03-05T01:00:00Z');
const refund: any = await (await fetch(BASE + '/v1/refunds', { method: 'POST', body: 'payment_intent=pi_1&amount=1999' })).json();
await deliver('refund.created', refund, 'evt_re'); await deliver('refund.created', refund, 'evt_re_again');
at('2026-04-01T01:00:00Z'); await paid(2, '2026-04-01', '2026-05-01', ['evt_2']);
at('2026-04-04T01:00:00Z');
await deliver('charge.dispute.created', { id: 'dp_1', object: 'dispute', amount: 1999, currency: 'usd', charge: 'ch_2', payment_intent: 'pi_2', status: 'needs_response', reason: 'fraudulent', created: Math.floor(Date.now() / 1000) }, 'evt_dp');
const rows = await repo.payments.list({ subscriptionId: 's1' } as any);
const entries = await ledger.entries('c1');
const rowOf = (i: number) => rows.find((r) => r.providerRef === 'in_' + i);
const grants = entries.filter((e) => e.kind === 'grant' && e.source === 'subscription');
const notProcessed = (await pool.query("select id, status, error from webhook_events where status <> 'processed'")).rows;
console.log(JSON.stringify({
  grantsPerPeriod: [0, 1, 2].map((i) => grants.filter((g) => (g.reference as any).paymentId === rowOf(i)?.id).length),
  distinctGrantKeys: new Set(grants.map((g) => g.idempotencyKey)).size,
  revokes: [0, 1, 2].map((i) => entries.filter((e) => e.kind === 'revoke' && (e.reference as any).paymentId === rowOf(i)?.id).reduce((a, e) => a + e.amount, 0)),
  customer: (await repo.customers.get('c1'))?.status,
  disputeCases: (await repo.csCases.list()).filter((c: any) => c.kind === 'dispute').length,
  notProcessed,
}));
await pool.end();
`;

  it('Stripe TS: dashboard refund of a renewal revokes its credits, a dispute freezes the customer, redelivery grants nothing more', async () => {
    const { dir, env } = await generate('stripe');
    await fs.writeFile(path.join(dir, 'harness.ts'), stripeTs(seoulDb('st'), env));
    const res = await run(TSX, ['harness.ts'], dir);
    expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
    const out = last(res.stdout);
    expectLedger(out, 3, 1);
    expect(out.customer).toBe('frozen');
    expect(out.disputeCases).toBe(1);
  }, 120_000);

  it('Stripe Python: the same, and one grant key per period whatever the session timezone', async () => {
    const { dir, env } = await generate('stripe');
    const dsn = seoulDb('sp');
    await fs.writeFile(path.join(dir, 'harness.py'), `
import asyncio, hashlib, hmac, importlib.util, json, time, urllib.request
from datetime import datetime, timezone
from boilpayment_core import CollectingNotifier, Customer, Deps, FixedClock, SequentialIdGen, NoopLogger, Period, Plan, PlanPrice, ProviderRef, Subscription
from boilpayment.postgres import PostgresRepo, PostgresLedgerStore, migrate
spec = importlib.util.spec_from_file_location('generated', ${JSON.stringify(path.join(dir, 'paykit/index.py'))})
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
BASE = ${JSON.stringify(STRIPE)}; DSN = ${JSON.stringify(dsn.replace('postgres://', 'postgresql://'))}
ENV = json.loads(${JSON.stringify(JSON.stringify(env))})
def d(s): return datetime.fromisoformat(s.replace('Z', '+00:00')).astimezone(timezone.utc)
def sec(iso): return int(d(iso + 'T00:00:00Z').timestamp())
def http(path, body=None, form=None):
    data = json.dumps(body).encode() if body is not None else form.encode()
    req = urllib.request.Request(BASE + path, method='POST', data=data)
    return json.loads(urllib.request.urlopen(req).read() or b'{}')
async def main():
    await migrate(conninfo=DSN, modules=${JSON.stringify(MODULES)})
    clock = FixedClock(d('2026-02-01T01:00:00Z'))
    repo = PostgresRepo(DSN); ledger = PostgresLedgerStore(DSN)
    config = json.load(open(${JSON.stringify(path.join(dir, 'paykit.config.json'))}))
    kit = mod.create_payment_kit(config, Deps(clock=clock, ids=SequentialIdGen('p'), repo=repo, ledger=ledger, logger=NoopLogger(), notifier=CollectingNotifier(), providers={}, policy=None), ENV)
    P = config['plans'][0]
    await repo.plans.put(Plan(id=P['id'], name=P['name'], interval=P['interval'], credits_per_period=P['creditsPerPeriod'], usage_included=P['usageIncluded'], trial_days=P['trialDays'], prices=[PlanPrice(currency=x['currency'], amount_minor=x['amountMinor'], provider_price_refs=x.get('providerPriceRefs') or {}) for x in P['prices']]))
    await repo.customers.put(Customer(id='c1', email=None, provider_refs=[ProviderRef(provider='stripe', ref='cus_1')], status='active', created_at=clock.now()))
    await repo.subscriptions.put(Subscription(id='s1', customer_id='c1', plan_id=P['id'], provider='stripe', provider_ref='sub_1', status='active', current_period=Period(start=d('2026-01-01T00:00:00Z'), end=d('2026-02-01T00:00:00Z')), anchor_day=1, cancel_at_period_end=False, grace_until=None, billing_key=None, scheduled_plan_id=None, version=0, currency='USD', created_at=clock.now()))
    def at(iso): clock.advance(int((d(iso) - clock.now()).total_seconds() * 1000))
    async def deliver(typ, obj, evt):
        raw = json.dumps({'id': evt, 'object': 'event', 'type': typ, 'created': int(time.time()), 'livemode': False, 'api_version': '2025-03-31.basil', 'data': {'object': obj}})
        t = int(time.time())
        sig = hmac.new(ENV['STRIPE_WEBHOOK_SECRET'].encode(), f'{t}.{raw}'.encode(), hashlib.sha256).hexdigest()
        await kit['handle_webhook'](raw, {'stripe-signature': f't={t},v1={sig}'})
    async def paid(i, s, e, evts):
        inv = {'id': f'in_{i}', 'object': 'invoice', 'status': 'paid', 'amount_paid': 1999, 'amount_due': 1999, 'currency': 'usd', 'customer': 'cus_1', 'created': sec(s),
               'parent': {'subscription_details': {'subscription': 'sub_1', 'metadata': {}}}, 'lines': {'data': [{'period': {'start': sec(s), 'end': sec(e)}}]}, 'metadata': {},
               'payments': {'data': [{'payment': {'payment_intent': f'pi_{i}'}}]}}
        pi = {'id': f'pi_{i}', 'object': 'payment_intent', 'amount': 1999, 'currency': 'usd', 'customer': 'cus_1', 'status': 'succeeded', 'invoice': f'in_{i}', 'metadata': {},
              'last_payment_error': None, 'latest_charge': {'id': f'ch_{i}', 'object': 'charge', 'amount': 1999, 'amount_refunded': 0, 'refunded': False, 'disputed': False}}
        sub = {'id': 'sub_1', 'object': 'subscription', 'customer': 'cus_1', 'status': 'active', 'billing_cycle_anchor': sec('2026-01-01'), 'cancel_at_period_end': False,
               'current_period_start': sec(s), 'current_period_end': sec(e), 'metadata': {}, 'items': {'data': [{'current_period_start': sec(s), 'current_period_end': sec(e)}]}, 'created': sec('2026-01-01')}
        http('/__set', {'invoices': {inv['id']: inv}, 'payment_intents': {pi['id']: pi}, 'subscriptions': {'sub_1': sub}})
        for evt in evts:
            await deliver('invoice.paid', inv, evt)
    at('2026-02-01T01:00:00Z'); await paid(10, '2026-02-01', '2026-03-01', ['evt_p0', 'evt_p0', 'evt_p0_dup'])
    at('2026-03-01T01:00:00Z'); await paid(11, '2026-03-01', '2026-04-01', ['evt_p1'])
    at('2026-03-05T01:00:00Z')
    refund = http('/v1/refunds', form='payment_intent=pi_11&amount=1999')
    await deliver('refund.created', refund, 'evt_p_re'); await deliver('refund.created', refund, 'evt_p_re_again')
    at('2026-04-01T01:00:00Z'); await paid(12, '2026-04-01', '2026-05-01', ['evt_p2'])
    at('2026-04-04T01:00:00Z')
    await deliver('charge.dispute.created', {'id': 'dp_p1', 'object': 'dispute', 'amount': 1999, 'currency': 'usd', 'charge': 'ch_12', 'payment_intent': 'pi_12', 'status': 'needs_response', 'reason': 'fraudulent', 'created': int(time.time())}, 'evt_p_dp')
    rows = await repo.payments.list(subscription_id='s1')
    entries = await ledger.entries('c1')
    row_of = {r.provider_ref: r.id for r in rows}
    grants = [e for e in entries if e.kind == 'grant' and e.source == 'subscription']
    ref = lambda e: e.reference.payment_id
    import psycopg
    async with await psycopg.AsyncConnection.connect(DSN) as conn:
        cur = await conn.execute("select id, status, error from webhook_events where status <> 'processed'")
        not_processed = [list(r) for r in await cur.fetchall()]
    print(json.dumps({
        'grantsPerPeriod': [len([g for g in grants if ref(g) == row_of.get(f'in_{i}')]) for i in (10, 11, 12)],
        'distinctGrantKeys': len({g.idempotency_key for g in grants}),
        'grantKeys': sorted(g.idempotency_key for g in grants),
        'revokes': [sum(e.amount for e in entries if e.kind == 'revoke' and ref(e) == row_of.get(f'in_{i}')) for i in (10, 11, 12)],
        'customer': (await repo.customers.get('c1')).status,
        'disputeCases': len([c for c in await repo.cs_cases.list() if c.kind == 'dispute']),
        'notProcessed': not_processed,
    }))
asyncio.run(main())
`);
    const res = await run(PY, [path.join(dir, 'harness.py')], dir);
    expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
    const out = last(res.stdout);
    expectLedger(out, 3, 1);
    expect(out.grantKeys.every((k: string) => /T00:00:00\.000Z$/.test(k)), JSON.stringify(out.grantKeys)).toBe(true);
    expect(out.customer).toBe('frozen');
    expect(out.disputeCases).toBe(1);
  }, 120_000);

  const polarSteps = `P1 paid (order.paid twice), P2 paid then refunded from the dashboard (refund.created twice)`;

  it(`Polar TS: ${polarSteps}`, async () => {
    const { dir, env } = await generate('polar');
    const dsn = seoulDb('pt');
    await fs.writeFile(path.join(dir, 'harness.ts'), `
import http from 'node:http';
import { createPaymentKit } from './paykit/index.js';
import { FixedClock, SequentialIdGen, NoopLogger, CollectingNotifier } from 'boilpayment-sdk/core';
import { createPool, createPostgresRepo, PostgresLedgerStore, migrate } from 'boilpayment-sdk/postgres';
import config from './paykit.config.json' with { type: 'json' };
const POLAR = ${JSON.stringify(POLAR)};
const env: any = ${JSON.stringify(env)};
const auth = { Authorization: 'Bearer polar_oat_test_fake', 'Content-Type': 'application/json' };
const pool = createPool(${JSON.stringify(dsn)}, { max: 4 });
await migrate({ pool, modules: ${JSON.stringify(MODULES)} } as any);
const clock = new FixedClock(new Date());
const repo = createPostgresRepo(pool as any); const ledger = new PostgresLedgerStore(pool as any);
const kit: any = createPaymentKit(config as any, { clock, ids: new SequentialIdGen('h'), repo, ledger, logger: new NoopLogger(), notifier: new CollectingNotifier(), env } as any);
const plan = config.plans[0] as any;
const post = async (p: string, b: any) => (await fetch(POLAR + p, { method: 'POST', headers: auth, body: JSON.stringify(b) })).json() as Promise<any>;
const customer = await post('/v1/customers/', { email: 'c1@example.com' });
const subId = (await post('/v1/checkouts/', { products: ['prod_sub_basic'], customer_id: customer.id }))._mock_subscription_id;
const remote: any = await (await fetch(POLAR + '/v1/subscriptions/' + subId, { headers: auth })).json();
await repo.plans.put(plan);
await repo.customers.put({ id: 'c1', email: 'c1@example.com', providerRefs: [{ provider: 'polar', ref: customer.id }], status: 'active', createdAt: clock.now() } as any);
await repo.subscriptions.put({ id: 's1', customerId: 'c1', planId: plan.id, provider: 'polar', providerRef: subId, status: 'active', currentPeriod: { start: new Date(remote.current_period_start), end: new Date(remote.current_period_end) }, anchorDay: new Date(remote.current_period_start).getUTCDate(), cancelAtPeriodEnd: false, graceUntil: null, billingKey: null, scheduledPlanId: null, version: 0, currency: 'USD', createdAt: clock.now() } as any);
const server = http.createServer((req, res) => { let body = ''; req.on('data', (c) => { body += c; }); req.on('end', async () => {
  try { await kit.handleWebhook(body, req.headers as any); res.writeHead(200).end('{}'); } catch { res.writeHead(500).end('{}'); } }); });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const hook = 'http://127.0.0.1:' + (server.address() as any).port + '/webhook';
const deliver = (type: string, id: string) => post('/__mock/webhook', { url: hook, secret: env.POLAR_WEBHOOK_SECRET, type, id });
const orders: string[] = [];
for (let i = 0; i < 2; i++) {
  const r = await post('/__mock/renew', { subscription_id: subId }); orders.push(r.order_id);
  clock.advance(new Date(r.period_start).getTime() + 3_600_000 - clock.now().getTime());
  await deliver('order.paid', r.order_id); await deliver('order.paid', r.order_id);
}
clock.advance(3_600_000);
const dash = await post('/v1/refunds/', { order_id: orders[1], amount: 2900, reason: 'customer_request' });
await deliver('refund.created', dash.id); await deliver('refund.created', dash.id);
server.close();
const rows = await repo.payments.list({ subscriptionId: 's1' } as any);
const entries = await ledger.entries('c1');
const rowOf = (o: string) => rows.find((r) => r.providerRef === o);
const grants = entries.filter((e) => e.kind === 'grant' && e.source === 'subscription');
console.log(JSON.stringify({
  grantsPerPeriod: orders.map((o) => grants.filter((g) => (g.reference as any).paymentId === rowOf(o)?.id).length),
  distinctGrantKeys: new Set(grants.map((g) => g.idempotencyKey)).size,
  revokes: orders.map((o) => entries.filter((e) => e.kind === 'revoke' && (e.reference as any).paymentId === rowOf(o)?.id).reduce((a, e) => a + e.amount, 0)),
  notProcessed: (await pool.query("select id, status, error from webhook_events where status <> 'processed'")).rows,
}));
await pool.end();
`);
    const res = await run(TSX, ['harness.ts'], dir);
    expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
    expectLedger(last(res.stdout), 2, 1);
  }, 120_000);

  it(`Polar Python: ${polarSteps}`, async () => {
    const { dir, env } = await generate('polar');
    const dsn = seoulDb('pp').replace('postgres://', 'postgresql://');
    await fs.writeFile(path.join(dir, 'harness.py'), `
import asyncio, importlib.util, json, threading, urllib.request
from datetime import datetime, timezone, timedelta
from http.server import BaseHTTPRequestHandler, HTTPServer
from boilpayment_core import CollectingNotifier, Customer, Deps, FixedClock, SequentialIdGen, NoopLogger, Period, Plan, PlanPrice, ProviderRef, Subscription
from boilpayment.postgres import PostgresRepo, PostgresLedgerStore, migrate
spec = importlib.util.spec_from_file_location('generated', ${JSON.stringify(path.join(dir, 'paykit/index.py'))})
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
POLAR = ${JSON.stringify(POLAR)}; DSN = ${JSON.stringify(dsn)}
ENV = json.loads(${JSON.stringify(JSON.stringify(env))})
AUTH = {'Authorization': 'Bearer polar_oat_test_fake', 'Content-Type': 'application/json'}
def d(s): return datetime.fromisoformat(s.replace('Z', '+00:00')).astimezone(timezone.utc)
def post(p, body):
    return json.loads(urllib.request.urlopen(urllib.request.Request(POLAR + p, data=json.dumps(body).encode(), method='POST', headers=AUTH)).read() or b'{}')
def get(p):
    return json.loads(urllib.request.urlopen(urllib.request.Request(POLAR + p, headers=AUTH)).read())
async def main():
    await migrate(conninfo=DSN, modules=${JSON.stringify(MODULES)})
    loop = asyncio.get_running_loop()
    clock = FixedClock(datetime.now(timezone.utc))
    repo = PostgresRepo(DSN); ledger = PostgresLedgerStore(DSN)
    config = json.load(open(${JSON.stringify(path.join(dir, 'paykit.config.json'))}))
    kit = mod.create_payment_kit(config, Deps(clock=clock, ids=SequentialIdGen('p'), repo=repo, ledger=ledger, logger=NoopLogger(), notifier=CollectingNotifier(), providers={}, policy=None), ENV)
    P = config['plans'][0]
    customer = post('/v1/customers/', {'email': 'c1@example.com'})
    sub_id = post('/v1/checkouts/', {'products': ['prod_sub_basic'], 'customer_id': customer['id']})['_mock_subscription_id']
    remote = get('/v1/subscriptions/' + sub_id)
    await repo.plans.put(Plan(id=P['id'], name=P['name'], interval=P['interval'], credits_per_period=P['creditsPerPeriod'], usage_included=P['usageIncluded'], trial_days=P['trialDays'], prices=[PlanPrice(currency=x['currency'], amount_minor=x['amountMinor'], provider_price_refs=x.get('providerPriceRefs') or {}) for x in P['prices']]))
    await repo.customers.put(Customer(id='c1', email='c1@example.com', provider_refs=[ProviderRef(provider='polar', ref=customer['id'])], status='active', created_at=clock.now()))
    start = d(remote['current_period_start']); end = d(remote['current_period_end'])
    await repo.subscriptions.put(Subscription(id='s1', customer_id='c1', plan_id=P['id'], provider='polar', provider_ref=sub_id, status='active', current_period=Period(start=start, end=end), anchor_day=start.day, cancel_at_period_end=False, grace_until=None, billing_key=None, scheduled_plan_id=None, version=0, currency='USD', created_at=clock.now()))
    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers.get('content-length') or 0)).decode()
            fut = asyncio.run_coroutine_threadsafe(kit['handle_webhook'](body, {k.lower(): v for k, v in self.headers.items()}), loop)
            try:
                fut.result(timeout=30); self.send_response(200)
            except Exception:  # noqa: BLE001
                self.send_response(500)
            self.end_headers(); self.wfile.write(b'{}')
        def log_message(self, *a):
            pass
    server = HTTPServer(('127.0.0.1', 0), H)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    hook = f'http://127.0.0.1:{server.server_address[1]}/webhook'
    async def deliver(typ, oid):
        await loop.run_in_executor(None, lambda: post('/__mock/webhook', {'url': hook, 'secret': ENV['POLAR_WEBHOOK_SECRET'], 'type': typ, 'id': oid}))
    orders = []
    for _ in range(2):
        r = await loop.run_in_executor(None, lambda: post('/__mock/renew', {'subscription_id': sub_id}))
        orders.append(r['order_id'])
        clock.advance(int((d(r['period_start']) + timedelta(hours=1) - clock.now()).total_seconds() * 1000))
        await deliver('order.paid', r['order_id']); await deliver('order.paid', r['order_id'])
    clock.advance(3_600_000)
    dash = await loop.run_in_executor(None, lambda: post('/v1/refunds/', {'order_id': orders[1], 'amount': 2900, 'reason': 'customer_request'}))
    await deliver('refund.created', dash['id']); await deliver('refund.created', dash['id'])
    server.shutdown()
    rows = await repo.payments.list(subscription_id='s1')
    entries = await ledger.entries('c1')
    row_of = {r.provider_ref: r.id for r in rows}
    grants = [e for e in entries if e.kind == 'grant' and e.source == 'subscription']
    import psycopg
    async with await psycopg.AsyncConnection.connect(DSN) as conn:
        cur = await conn.execute("select id, status, error from webhook_events where status <> 'processed'")
        not_processed = [list(r) for r in await cur.fetchall()]
    print(json.dumps({
        'grantsPerPeriod': [len([g for g in grants if g.reference.payment_id == row_of.get(o)]) for o in orders],
        'distinctGrantKeys': len({g.idempotency_key for g in grants}),
        'revokes': [sum(e.amount for e in entries if e.kind == 'revoke' and e.reference.payment_id == row_of.get(o)) for o in orders],
        'notProcessed': not_processed,
    }))
asyncio.run(main())
`);
    const res = await run(PY, [path.join(dir, 'harness.py')], dir);
    expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
    expectLedger(last(res.stdout), 2, 1);
  }, 120_000);
});
