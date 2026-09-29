// AF-01..04 through the composition the CLI generates: a payment granted by recovery (cron.reconcile or
// support.recoverMissingGrant) appends its one affiliate accrual, exactly once however often recovery
// runs, in both languages.
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

it('generated recovery paths append one affiliate accrual per recovered payment', async () => {
  // Given a generated credits + top-up kit with a fixed affiliate commission
  const config = kitchenSinkConfig();
  config.providers = ['stripe'];
  config.models = ['topup'];
  config.goods = ['credits'];
  config.cs.enabled = false;
  config.infra.notify.email = 'none';
  config.infra.notify.slack = false;
  config.affiliate = { commission: { type: 'fixed', amountMinor: 150 }, renewals: 'first_only' };
  const plan = config.plans[0];
  if (!plan) throw new Error('no plan');
  plan.interval = null;
  plan.prices = [{ currency: 'USD', amountMinor: 1000, providerPriceRefs: { stripe: 'price_x' } }];
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paykit-recover-aff-'));
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
const now = new Date('2026-09-28T00:00:00Z');
const repo = new InMemoryRepo();
const clock = new FixedClock(now);
const ids = new SequentialIdGen('aff');
const ledger = new InMemoryLedger(ids, clock);
const keys = new Map();
let n = 0;
const unused = async () => { throw new Error('unused'); };
const paymentFor = (given) => { const ref = given.replace('cs_', 'pi_'); return { id: 'remote-' + ref, customerId: 'cus_1', provider: 'stripe', providerRef: ref, subscriptionId: null,
  amount: { amountMinor: 1000, currency: 'USD' }, status: 'succeeded', kind: 'topup', period: null, occurredAt: now, failure: null,
  cashReceipt: null, raw: { metadata: { checkoutEntitlementKey: keys.get(ref) } } }; };
const stripe = {
  name: 'stripe',
  capabilities: () => ({ nativeSubscriptions: false, partialRefund: true, meters: false, scheduling: 'provider', webhookSignature: true }),
  createCustomer: unused, changeSubscription: unused, cancelSubscription: unused, chargeBillingKey: unused, reportUsage: unused, verifyWebhook: unused,
  getSubscription: unused, refund: unused,
  createCheckout: async (args) => { n += 1; keys.set('pi_' + n, args.metadata.checkoutEntitlementKey); return { id: 'cs_' + n, url: 'https://example.test/c', providerRef: 'cs_' + n }; },
  getPayment: async (ref) => paymentFor(ref),
  listPayments: async () => [...keys.keys()].map(paymentFor),
};
const kit = createPaymentKit(config, { repo, clock, ids, ledger, providers: { stripe }, logger: new NoopLogger(), env: { DATABASE_URL: '' } });
await kit.initialize({ verifySchema: false });
await repo.customers.put({ id: 'cus', email: null, providerRefs: [{ provider: 'stripe', ref: 'cus_1' }], status: 'active', createdAt: now });
const sell = async (requestId) => {
  await kit.checkout({ customerId: 'cus', planId: config.plans[0].id, provider: 'stripe', currency: 'USD', requestId,
    successUrl: 'https://example.test/ok', cancelUrl: 'https://example.test/no', affiliateId: 'aff-1' });
  const ref = 'pi_' + n;
  const payment = await kit.registerCompletedCheckout({ customerId: 'cus', checkoutId: 'cs_' + n, paymentRef: ref });
  return payment.id;
};
const viaSupport = await sell('sale-1');
const viaCron = await sell('sale-2');
assert.equal((await kit.affiliate.list({ affiliateId: 'aff-1' })).length, 0);

// When one payment is recovered by support and the other by reconcile, each repeated
await kit.support.recoverMissingGrant({ customerId: 'cus', paymentId: viaSupport });
await kit.support.recoverMissingGrant({ customerId: 'cus', paymentId: viaSupport });
const since = new Date('2026-01-01');
await kit.cron.reconcile(since);
await kit.cron.reconcile(since);

// Then both were granted and each accrued once
const grants = await ledger.entries('cus', { kind: 'grant' });
assert.equal(grants.length, 2);
const accruals = await kit.affiliate.list({ affiliateId: 'aff-1' });
assert.deepEqual(accruals.map((row) => row.paymentId).sort(), [viaSupport, viaCron].sort());
assert.ok(accruals.every((row) => row.kind === 'accrual' && row.amount.amountMinor === 150));
console.log('PASS');
`);
  await fs.writeFile(path.join(dir, 'run.py'), `
import asyncio, json
from dataclasses import replace
from datetime import datetime, timezone
from paykit.index import create_payment_kit
from boilpayment.core import (Checkout, Customer, Deps, FixedClock, InMemoryLedger, InMemoryRepo, Money, NoopLogger,
    Payment, ProviderCapabilities, ProviderRef, SequentialIdGen)
now = datetime(2026, 9, 28, tzinfo=timezone.utc)
class Stripe:
    name = 'stripe'
    def __init__(self):
        self.keys = {}
        self.n = 0
    def capabilities(self):
        return ProviderCapabilities(native_subscriptions=False, partial_refund=True, meters=False, scheduling='provider', webhook_signature=True)
    def _payment(self, given):
        ref = given.replace('cs_', 'pi_')
        return Payment(id='remote-' + ref, customer_id='cus_1', provider='stripe', provider_ref=ref, subscription_id=None,
            amount=Money(amount_minor=1000, currency='USD'), status='succeeded', kind='topup', period=None, occurred_at=now,
            failure=None, raw={'metadata': {'checkoutEntitlementKey': self.keys.get(ref)}})
    async def create_checkout(self, input):
        self.n += 1
        self.keys['pi_%d' % self.n] = input.metadata['checkoutEntitlementKey']
        return Checkout(id='cs_%d' % self.n, provider_ref='cs_%d' % self.n, url='https://example.test/c')
    async def get_payment(self, ref):
        return self._payment(ref)
    async def list_payments(self, **kwargs):
        return [self._payment(ref) for ref in self.keys]
async def main():
    repo = InMemoryRepo()
    clock = FixedClock(now)
    ids = SequentialIdGen('aff')
    ledger = InMemoryLedger(ids, clock)
    stripe = Stripe()
    deps = Deps(repo=repo, clock=clock, ids=ids, ledger=ledger, providers={'stripe': stripe}, policy=None, notifier=None, logger=NoopLogger())
    with open('paykit.config.json') as source:
        config = json.load(source)
    kit = create_payment_kit(config, deps, {'DATABASE_URL': ''}, providers_override={'stripe': stripe})
    await kit['initialize'](verify_schema_first=False)
    await repo.customers.put(Customer(id='cus', email=None, provider_refs=[ProviderRef(provider='stripe', ref='cus_1')], status='active', created_at=now))
    async def sell(request_id):
        await kit['checkout'](customer_id='cus', plan_id=config['plans'][0]['id'], provider='stripe', currency='USD', request_id=request_id,
            success_url='https://example.test/ok', cancel_url='https://example.test/no', affiliate_id='aff-1')
        payment = await kit['register_completed_checkout'](customer_id='cus', checkout_id='cs_%d' % stripe.n, payment_ref='pi_%d' % stripe.n)
        return payment.id
    via_support = await sell('sale-1')
    via_cron = await sell('sale-2')
    assert len(await kit['affiliate']['list'](affiliate_id='aff-1')) == 0
    await kit['support']['recover_missing_grant'](customer_id='cus', payment_id=via_support)
    await kit['support']['recover_missing_grant'](customer_id='cus', payment_id=via_support)
    since = datetime(2026, 1, 1, tzinfo=timezone.utc)
    await kit['cron']['reconcile'](since)
    await kit['cron']['reconcile'](since)
    assert len(await ledger.entries('cus', kind='grant')) == 2
    accruals = await kit['affiliate']['list'](affiliate_id='aff-1')
    assert sorted(row.payment_id for row in accruals) == sorted([via_support, via_cron]), accruals
    assert all(row.kind == 'accrual' and row.amount.amount_minor == 150 for row in accruals)
    print('PASS')
asyncio.run(main())
`);

  // When both generated runtimes run the scenario
  const ts = spawnSync(process.execPath, ['--import', path.join(root, 'apps/cli/node_modules/tsx/dist/loader.mjs'), 'run.ts'], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_PATH: path.join(root, 'node_modules') },
  });
  const py = spawnSync(path.join(root, '.venv/bin/python'), ['run.py'], { cwd: dir, encoding: 'utf8' });

  // Then
  expect(ts.status, ts.stdout + ts.stderr).toBe(0);
  expect(py.status, py.stdout + py.stderr).toBe(0);
}, 60_000);
