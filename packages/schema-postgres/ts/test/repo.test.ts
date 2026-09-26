// Phase 6 regression — PostgresRepo CRUD roundtrip for every table it exposes, plus
// cs_cases-specific behavior: policy_snapshot dedup and EC:I7 partial-unique-index dedup.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { DEFAULT_POLICY, type Customer, type CsCase, type Payment, type Plan, type Refund, type Subscription, type UsageEvent, type WebhookEventRecord, type OutboxItem } from '@schift/payment-kit-core';
import { PostgresRepo, migrate } from '../dist/index.js';
import { createTestDb, dropTestDb, uniqueDbName, PG_HOST } from './helpers.js';

const dbName = uniqueDbName('repo');
let pool: Pool;
let repo: PostgresRepo;

beforeAll(async () => {
  await createTestDb(dbName);
  pool = new Pool({ host: PG_HOST, database: dbName });
  await migrate({ pool });
  repo = new PostgresRepo(pool);
});

afterAll(async () => {
  await pool.end();
  await dropTestDb(dbName);
});

describe('PostgresRepo CRUD roundtrip', () => {
  it('customers', async () => {
    const c: Customer = { id: 'cust_repo_1', email: 'repo1@test.example', providerRefs: [{ provider: 'stripe', ref: 'cus_x1' }], status: 'active', createdAt: new Date('2026-01-01T00:00:00.000Z') };
    await repo.customers.put(c);
    const back = await repo.customers.get(c.id);
    expect(back).toEqual(c);
  });

  it('plans (+ plan_prices child rows)', async () => {
    const plan: Plan = {
      id: 'plan_repo_1', name: 'Repo Pro', interval: 'month', creditsPerPeriod: 500, usageIncluded: 100, trialDays: 14,
      prices: [{ currency: 'USD', amountMinor: 2900 }, { currency: 'KRW', amountMinor: 39000, providerPriceRefs: { stripe: 'price_krw_1' } }],
    };
    await repo.plans.put(plan);
    const back = await repo.plans.get(plan.id);
    expect(back).not.toBeNull();
    expect(back!.name).toBe('Repo Pro');
    expect(back!.prices).toHaveLength(2);
    expect(back!.prices.find((p) => p.currency === 'KRW')?.providerPriceRefs).toEqual({ stripe: 'price_krw_1' });
  });

  it('subscriptions', async () => {
    await repo.customers.put({ id: 'cust_repo_sub', email: null, providerRefs: [], status: 'active', createdAt: new Date() });
    await repo.plans.put({ id: 'plan_repo_sub', name: 'Sub plan', interval: 'month', creditsPerPeriod: 100, usageIncluded: 0, trialDays: 0, prices: [] });
    const now = new Date('2026-01-01T00:00:00.000Z');
    const end = new Date('2026-02-01T00:00:00.000Z');
    const sub: Subscription = {
      id: 'sub_repo_1', customerId: 'cust_repo_sub', planId: 'plan_repo_sub', provider: 'stripe', providerRef: 'sub_ref_1',
      status: 'active', currentPeriod: { start: now, end }, anchorDay: 1, cancelAtPeriodEnd: false, graceUntil: null,
      billingKey: null, scheduledPlanId: null, version: 0, createdAt: now,
    };
    await repo.subscriptions.put(sub);
    const back = await repo.subscriptions.get(sub.id);
    expect(back).toEqual(sub);
  });

  it('payments', async () => {
    await repo.customers.put({ id: 'cust_repo_pay', email: null, providerRefs: [], status: 'active', createdAt: new Date() });
    const payment: Payment = {
      id: 'pay_repo_1', customerId: 'cust_repo_pay', provider: 'stripe', providerRef: 'pi_1', subscriptionId: null,
      amount: { amountMinor: 2900, currency: 'USD' }, status: 'succeeded', kind: 'topup', period: null,
      occurredAt: new Date('2026-01-05T00:00:00.000Z'), failure: null, raw: { foo: 'bar' },
    };
    await repo.payments.put(payment);
    const back = await repo.payments.get(payment.id);
    expect(back).not.toBeNull();
    expect(back!.amount).toEqual(payment.amount);
    expect(back!.status).toBe('succeeded');
    expect(back!.raw).toEqual({ foo: 'bar' });
  });

  it('usage_events', async () => {
    await repo.customers.put({ id: 'cust_repo_usage', email: null, providerRefs: [], status: 'active', createdAt: new Date() });
    const now = new Date('2026-01-10T00:00:00.000Z');
    const ev: UsageEvent = {
      id: 'usage_repo_1', customerId: 'cust_repo_usage', meter: 'api_calls', quantity: 42,
      occurredAt: now, receivedAt: now, periodStart: new Date('2026-01-01T00:00:00.000Z'),
      idempotencyKey: 'usage:repo:1', meta: { requestId: 'req_1' },
    };
    await repo.usageEvents.put(ev);
    const back = await repo.usageEvents.get(ev.id);
    expect(back).toEqual(ev);
  });

  it('refunds', async () => {
    await repo.customers.put({ id: 'cust_repo_refund', email: null, providerRefs: [], status: 'active', createdAt: new Date() });
    const payment: Payment = {
      id: 'pay_repo_refund', customerId: 'cust_repo_refund', provider: 'stripe', providerRef: 'pi_refund_1', subscriptionId: null,
      amount: { amountMinor: 5000, currency: 'USD' }, status: 'succeeded', kind: 'topup', period: null,
      occurredAt: new Date(), failure: null,
    };
    await repo.payments.put(payment);
    const refund: Refund = {
      id: 'refund_repo_1', paymentId: payment.id, customerId: 'cust_repo_refund', amount: { amountMinor: 5000, currency: 'USD' },
      status: 'succeeded', providerRef: 're_1', creditsRevoked: 10, ruleId: 'D1', reason: 'requested', failure: null,
      createdAt: new Date('2026-01-15T00:00:00.000Z'),
    };
    await repo.refunds.put(refund);
    const back = await repo.refunds.get(refund.id);
    expect(back).not.toBeNull();
    expect(back!.status).toBe('succeeded');
    expect(back!.creditsRevoked).toBe(10);
    expect(back!.ruleId).toBe('D1');
  });

  it('webhook_events', async () => {
    const ev: WebhookEventRecord = {
      id: 'evt_repo_1', provider: 'stripe', type: 'payment.succeeded', status: 'received', rawBody: '{"id":"evt_repo_1"}',
      headers: { 'stripe-signature': 'sig_1' }, receivedAt: new Date('2026-01-20T00:00:00.000Z'), processedAt: null, error: null, attempts: 0,
      customerId: null, paymentId: null, subscriptionId: null, correlationId: null,
    };
    await repo.webhookEvents.put(ev);
    const back = await repo.webhookEvents.get(ev.id);
    expect(back).toEqual(ev);
  });

  it('outbox', async () => {
    const item: OutboxItem = {
      id: 'outbox_repo_1', kind: 'webhook.process', payload: { eventId: 'evt_repo_1' }, status: 'pending',
      attempts: 0, nextAttemptAt: new Date('2026-01-20T00:05:00.000Z'), createdAt: new Date('2026-01-20T00:00:00.000Z'),
    };
    await repo.outbox.put(item);
    const back = await repo.outbox.get(item.id);
    expect(back).toEqual(item);
  });

  it('cs_cases: policy_snapshot dedup — two cases with the same Policy content share one policy_snapshots row', async () => {
    await repo.customers.put({ id: 'cust_repo_cs_dedup', email: null, providerRefs: [], status: 'active', createdAt: new Date() });
    const now = new Date('2026-01-25T00:00:00.000Z');
    const case1: CsCase = {
      id: 'cs_repo_dedup_1', customerId: 'cust_repo_cs_dedup', kind: 'refund', status: 'resolved_auto', referenceId: 'ref_dedup_1',
      policySnapshot: DEFAULT_POLICY, decision: null, churnReason: null, churnText: null, openedAt: now, resolvedAt: now,
    };
    const case2: CsCase = {
      id: 'cs_repo_dedup_2', customerId: 'cust_repo_cs_dedup', kind: 'dispute', status: 'resolved_auto', referenceId: 'ref_dedup_2',
      policySnapshot: DEFAULT_POLICY, decision: null, churnReason: null, churnText: null, openedAt: now, resolvedAt: now,
    };
    await repo.csCases.put(case1);
    await repo.csCases.put(case2);
    const back1 = await repo.csCases.get(case1.id);
    const back2 = await repo.csCases.get(case2.id);
    expect(back1!.policySnapshot).toEqual(DEFAULT_POLICY);
    expect(back2!.policySnapshot).toEqual(DEFAULT_POLICY);

    const snapCount = await pool.query(
      `select count(distinct policy_snapshot_id)::int as n from cs_cases where id = any($1)`,
      [[case1.id, case2.id]],
    );
    expect(snapCount.rows[0].n).toBe(1); // both rows point at the SAME dedup'd policy_snapshots row
  });

  it('cs_cases: EC:I7 — partial unique index rejects a second OPEN case with the same (customer_id, kind, reference_id)', async () => {
    await repo.customers.put({ id: 'cust_repo_i7', email: null, providerRefs: [], status: 'active', createdAt: new Date() });
    const now = new Date('2026-01-26T00:00:00.000Z');
    const case1: CsCase = {
      id: 'cs_repo_i7_1', customerId: 'cust_repo_i7', kind: 'regrant', status: 'open', referenceId: 'ref_i7_dup',
      policySnapshot: DEFAULT_POLICY, decision: null, churnReason: null, churnText: null, openedAt: now, resolvedAt: null,
    };
    await repo.csCases.put(case1);

    const case2Dup: CsCase = {
      id: 'cs_repo_i7_2', customerId: 'cust_repo_i7', kind: 'regrant', status: 'open', referenceId: 'ref_i7_dup',
      policySnapshot: DEFAULT_POLICY, decision: null, churnReason: null, churnText: null, openedAt: now, resolvedAt: null,
    };
    let rejected: unknown;
    try {
      await repo.csCases.put(case2Dup);
    } catch (err) {
      rejected = err;
    }
    expect(rejected).toBeDefined();
    expect((rejected as { code?: string }).code).toBe('23505'); // unique_violation
    expect((rejected as Error).message).toMatch(/cs_cases_open_unique_idx/);

    // after resolving case1, the same (customer_id, kind, reference_id) key must be openable again
    await repo.csCases.put({ ...case1, status: 'resolved_auto', resolvedAt: now });
    const case2: CsCase = {
      id: 'cs_repo_i7_3', customerId: 'cust_repo_i7', kind: 'regrant', status: 'open', referenceId: 'ref_i7_dup',
      policySnapshot: DEFAULT_POLICY, decision: null, churnReason: null, churnText: null, openedAt: now, resolvedAt: null,
    };
    const back = await repo.csCases.put(case2);
    expect(back.id).toBe('cs_repo_i7_3');
    expect(back.status).toBe('open');
  });
});
