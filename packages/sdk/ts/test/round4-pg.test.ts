// Round-4 audit regressions (bp-audit4.md A4-4, EC:A37): self-scheduled renewal on Postgres with two workers
// (separate pools). Ported from the auditor's PoC with its console output turned into assertions.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createPool } from 'boilpayment-schema-postgres';
import { CollectingNotifier, FixedClock, SequentialIdGen, resolvePolicy, ProviderError } from 'boilpayment-core';
import type { Money, Payment, PaymentProvider, PaymentStatus, Plan, Subscription } from 'boilpayment-core';
import { dunning, scheduler } from 'boilpayment-lifecycle';
import { createPostgresRepo, migrate, PostgresLedgerStore } from 'boilpayment-schema-postgres';

class FakeToss {
  readonly name = 'toss' as const;
  answers = new Map<string, Payment>();
  moneyMoved = new Map<string, number>();
  calls = 0;
  nextStatus: PaymentStatus = 'succeeded';
  hook: ((key: string) => Promise<void>) | null = null;
  capabilities() { return { nativeSubscriptions: false, partialRefund: true, meters: false, scheduling: 'self' as const, webhookSignature: false }; }
  async chargeBillingKey(input: { amount: Money; orderId: string; customerRef: string; idempotencyKey: string }): Promise<Payment> {
    this.calls++;
    if (this.hook) await this.hook(input.idempotencyKey);
    await new Promise((r) => setTimeout(r, 5));
    const replay = this.answers.get(input.idempotencyKey);
    if (replay) return replay;
    const p: Payment = { id: 'x', customerId: input.customerRef, provider: 'toss', providerRef: 'pk_' + input.orderId, subscriptionId: null, amount: input.amount,
      status: this.nextStatus, kind: 'subscription', period: null, occurredAt: new Date(), cashReceipt: null,
      failure: this.nextStatus === 'failed' ? { code: 'card_declined', providerCode: null, retryable: true, userMessage: 'd' } : null };
    this.answers.set(input.idempotencyKey, p);
    if (p.status === 'succeeded') this.moneyMoved.set(input.customerRef, (this.moneyMoved.get(input.customerRef) ?? 0) + 1);
    return p;
  }
}

const basic: Plan = { id: 'basic', name: 'Basic', interval: 'month', creditsPerPeriod: 100, usageIncluded: 0, trialDays: 0,
  prices: [{ currency: 'KRW', amountMinor: 5000, providerPriceRefs: {} }] };
const mkSub = (i: number): Subscription => ({ id: `sub_${i}`, customerId: `c${i}`, planId: 'basic', provider: 'toss', providerRef: null, status: 'active',
  currentPeriod: { start: new Date('2024-01-01T00:00:00Z'), end: new Date('2024-02-01T00:00:00Z') }, anchorDay: 1, cancelAtPeriodEnd: false,
  graceUntil: null, billingKey: 'bk', scheduledPlanId: null, version: 0, currency: 'KRW', createdAt: new Date('2024-01-01T00:00:00Z') } as Subscription);

let dbName = '';
let pools: any[] = [];
beforeAll(async () => {
  dbName = `paykit_test_r4_${process.pid}_${randomBytes(3).toString('hex')}`;
  execFileSync('createdb', ['-h', '127.0.0.1', dbName]);
  pools = [0, 1, 2].map(() => createPool(`postgres://127.0.0.1/${dbName}`, { max: 4 }));
  await migrate({ pool: pools[0] as any, modules: ['core', 'credits', 'usage', 'webhook', 'refund', 'cs'] });
});
afterAll(async () => {
  for (const p of pools) await p.end();
  execFileSync('dropdb', ['-h', '127.0.0.1', '--if-exists', dbName]);
});

function worker(i: number, provider: FakeToss) {
  const repo = createPostgresRepo(pools[i] as any);
  const ledger = new PostgresLedgerStore(pools[i] as any);
  const notifier = new CollectingNotifier();
  const policy = resolvePolicy();
  const clk = (at: string) => new FixedClock(new Date(at));
  return {
    repo, ledger, notifier,
    tick: (at: string) => scheduler.tick({ provider: provider as unknown as PaymentProvider, repo, ledger, policy, clock: clk(at), ids: new SequentialIdGen(`w${i}_`), notifier }),
    retries: async (at: string) => {
      const out: string[] = [];
      for (const item of await dunning.retryDue({ repo, clock: clk(at) })) {
        try { out.push((await dunning.runRetry({ item, provider: provider as unknown as PaymentProvider, repo, ledger, policy, notifier, clock: clk(at) })).outcome); }
        catch (e) { out.push('throw:' + (e as Error).message.slice(0, 60)); }
      }
      return out;
    },
  };
}

describe('a4 pg', () => {
  it('P1 two workers tick 30 subscriptions concurrently (x3 rounds)', async () => {
    const provider = new FakeToss();
    const a = worker(0, provider); const b = worker(1, provider);
    const N = 30;
    await a.repo.plans.put(basic);
    for (let i = 0; i < N; i++) { await a.repo.customers.put({ id: `c${i}`, email: null, providerRefs: [], status: "active", createdAt: new Date() } as any); await a.repo.subscriptions.put(mkSub(i)); }
    const errs: string[] = [];
    for (const at of ['2024-02-01T01:00:00Z', '2024-03-01T01:00:00Z', '2024-04-01T01:00:00Z']) {
      const [ra, rb] = await Promise.all([a.tick(at), b.tick(at)]);
      errs.push(...ra.errors.map((e) => e.code), ...rb.errors.map((e) => e.code));
    }
    await a.tick('2024-04-02T01:00:00Z');
    let bad = 0; const detail: string[] = [];
    for (let i = 0; i < N; i++) {
      const rows = (await a.repo.payments.list({ subscriptionId: `sub_${i}` } as any));
      const ok = rows.filter((r) => r.status === 'succeeded').length;
      const moved = provider.moneyMoved.get(`c${i}`) ?? 0;
      const grants = (await a.ledger.entries(`c${i}`, { kind: 'grant' } as any)).length;
      const sub = (await a.repo.subscriptions.get(`sub_${i}`))!;
      if (moved !== 3 || ok !== 3 || rows.length !== 3 || grants !== 3 || sub.currentPeriod.start.toISOString() !== '2024-04-01T00:00:00.000Z') { bad++; detail.push(`sub_${i} moved=${moved} rows=${rows.map((r) => r.status)} grants=${grants} sub=${sub.status}`); }
    }
    expect(detail).toEqual([]);
    expect(bad).toBe(0);
    expect(provider.calls).toBe(3 * N); // one provider call per (subscription, period) even with two workers
    expect(errs).toEqual([]);
  });

  it('P2 stale reader overwrites a succeeded attempt row with pending (worker B read before A wrote, then transport error)', async () => {
    const provider = new FakeToss();
    const a = worker(0, provider); const b = worker(1, provider);
    await a.repo.plans.put(basic);
    await a.repo.customers.put({ id: `c${100}`, email: null, providerRefs: [], status: "active", createdAt: new Date() } as any); await a.repo.subscriptions.put(mkSub(100));
    // B reads the (absent) attempt row, then is paused until A has finished the whole renewal.
    let release!: () => void; const aDone = new Promise<void>((r) => (release = r));
    const bGet = b.repo.payments.get.bind(b.repo.payments);
    let gated = false;
    (b.repo.payments as any).get = async (id: string) => { const r = await bGet(id); if (!gated) { gated = true; await aDone; } return r; };
    const bCharge = provider.chargeBillingKey.bind(provider);
    let bCalled = false;
    const tb = (async () => {
      // B's provider call gets no answer (transport error)
      (b as any).throwOnCharge = true;
      return b.tick('2024-02-01T01:00:00Z');
    })();
    // A runs to completion while B is parked, then B continues with a network failure on its provider call.
    await new Promise((r) => setTimeout(r, 30));
    const ra = await a.tick('2024-02-01T01:00:00Z');
    provider.hook = async () => { if (!bCalled) { bCalled = true; throw new Error('socket hang up'); } };
    release();
    const rb = await tb;
    provider.hook = null;
    const rows = await a.repo.payments.list({ subscriptionId: 'sub_100' } as any);
    const sub = (await a.repo.subscriptions.get('sub_100'))!;
    const bal = await a.ledger.balance('c100', undefined, new Date('2024-02-02T00:00:00Z'));
    void bCharge; void ra; void rb; void rows; void sub; void bal;
    // does anything later repair the row?
    for (const at of ['2024-02-02T01:00:00Z', '2024-02-10T01:00:00Z']) await a.tick(at);
    const rows2 = await a.repo.payments.list({ subscriptionId: 'sub_100' } as any);
    expect(rows2.map((r) => r.status)).toEqual(['succeeded']); // never left pending over a succeeded charge
    expect(provider.moneyMoved.get('c100')).toBe(1);
    expect((await a.ledger.balance('c100', undefined, new Date('2024-02-11T00:00:00Z'))).available).toBe(100);
  });

  it('P3 tick and two dunning workers concurrently on PG (past_due)', async () => {
    const provider = new FakeToss();
    const a = worker(0, provider); const b = worker(1, provider); const c = worker(2, provider);
    await a.repo.plans.put(basic);
    const N = 15;
    for (let i = 200; i < 200 + N; i++) { await a.repo.customers.put({ id: `c${i}`, email: null, providerRefs: [], status: "active", createdAt: new Date() } as any); await a.repo.subscriptions.put(mkSub(i)); }
    provider.nextStatus = 'failed';
    await a.tick('2024-02-01T01:00:00Z');
    provider.nextStatus = 'succeeded';
    const [ta, rb, rc] = await Promise.all([a.tick('2024-02-02T02:00:00Z'), b.retries('2024-02-02T02:00:00Z'), c.retries('2024-02-02T02:00:00Z')]);
    let bad = 0; const detail: string[] = [];
    for (let i = 200; i < 200 + N; i++) {
      const rows = await a.repo.payments.list({ subscriptionId: `sub_${i}` } as any);
      const moved = provider.moneyMoved.get(`c${i}`) ?? 0;
      const ok = rows.filter((r) => r.status === 'succeeded').length;
      const usable = (await a.ledger.balance(`c${i}`, undefined, new Date('2024-02-03T00:00:00Z'))).available;
      if (moved !== 1 || ok !== 1 || usable !== 100) { bad++; detail.push(`sub_${i} moved=${moved} ok=${ok} usable=${usable}`); }
    }
    const count = (xs: string[]) => JSON.stringify(xs.reduce((m: any, c) => (m[c] = (m[c] ?? 0) + 1, m), {}));
    void count; void ta; void rb; void rc;
    expect(detail).toEqual([]);
    expect(bad).toBe(0);
  });
});
