import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AffiliateCommission, Payment, Subscription } from 'boilpayment-core';
import { PostgresRepo } from '../dist/index.js';
import { createTestDb, dropTestDb, type TestDb } from './db-helper.js';

let db: TestDb;
let repo: PostgresRepo;

beforeAll(async () => {
  db = await createTestDb('affiliate_commissions');
  repo = new PostgresRepo(db.pool);
});

afterAll(async () => {
  await dropTestDb(db);
});

async function seedPayment(): Promise<Payment> {
  const occurredAt = new Date('2026-09-28T00:00:00.000Z');
  await repo.customers.put({
    id: 'cust_affiliate_repo',
    email: null,
    providerRefs: [],
    status: 'active',
    createdAt: occurredAt,
  });
  const payment: Payment = {
    id: 'pay_affiliate_repo',
    customerId: 'cust_affiliate_repo',
    provider: 'stripe',
    providerRef: 'pi_affiliate_repo',
    subscriptionId: null,
    amount: { amountMinor: 8_000, currency: 'KRW' },
    status: 'succeeded',
    kind: 'topup',
    period: null,
    occurredAt,
    failure: null,
    cashReceipt: null,
    saleEvidence: {
      providerSubtotal: { amountMinor: 10_000, currency: 'KRW' },
      discountAmount: { amountMinor: 2_000, currency: 'KRW' },
      priceRef: 'price_affiliate_repo',
      checkoutId: 'checkout_affiliate_repo',
      paymentLinkId: null,
      linkReference: null,
    },
    affiliateId: 'partner-1',
  };
  return repo.payments.put(payment);
}

describe('Postgres affiliate persistence', () => {
  it('persists payment sale evidence and affiliate attribution', async () => {
    const payment = await seedPayment();

    const stored = await repo.payments.get(payment.id);

    expect(stored?.saleEvidence).toEqual(payment.saleEvidence);
    expect(stored?.affiliateId).toBe('partner-1');
  });

  it('persists subscription affiliate attribution', async () => {
    const now = new Date('2026-09-28T00:00:00.000Z');
    await repo.customers.put({
      id: 'cust_affiliate_repo',
      email: null,
      providerRefs: [],
      status: 'active',
      createdAt: now,
    });
    await repo.plans.put({
      id: 'plan_affiliate_repo',
      name: 'Affiliate plan',
      interval: 'month',
      creditsPerPeriod: 100,
      usageIncluded: 0,
      trialDays: 0,
      prices: [],
    });
    const subscription: Subscription = {
      id: 'sub_affiliate_repo',
      customerId: 'cust_affiliate_repo',
      planId: 'plan_affiliate_repo',
      provider: 'stripe',
      providerRef: 'sub_affiliate_repo',
      status: 'active',
      currentPeriod: { start: now, end: new Date('2026-10-28T00:00:00.000Z') },
      anchorDay: 28,
      cancelAtPeriodEnd: false,
      graceUntil: null,
      billingKey: null,
      scheduledPlanId: null,
      version: 0,
      createdAt: now,
      affiliateId: 'partner-1',
    };

    await repo.subscriptions.put(subscription);
    const stored = await repo.subscriptions.get(subscription.id);

    expect(stored?.affiliateId).toBe('partner-1');
  });

  it('appends commissions idempotently and filters without replacing the original', async () => {
    const payment = await seedPayment();
    const createdAt = new Date('2026-09-28T00:00:00.000Z');
    const accrual: AffiliateCommission = {
      id: 'commission-accrual-1',
      kind: 'accrual',
      affiliateId: 'partner-1',
      paymentId: payment.id,
      refundId: null,
      relatedAccrualId: null,
      amount: { amountMinor: 800, currency: 'KRW' },
      idempotencyKey: 'affiliate:pay_affiliate_repo:accrual',
      createdAt,
    };
    const replay: AffiliateCommission = {
      ...accrual,
      id: 'commission-replay-must-not-replace',
      amount: { amountMinor: 999, currency: 'KRW' },
    };

    const first = await repo.affiliateCommissions.append(accrual);
    const second = await repo.affiliateCommissions.append(replay);
    const byAffiliate = await repo.affiliateCommissions.list({ affiliateId: 'partner-1' });
    const byPayment = await repo.affiliateCommissions.list({ paymentId: payment.id, kind: 'accrual' });

    expect(first).toEqual(accrual);
    expect(second).toEqual(accrual);
    expect(byAffiliate).toEqual([accrual]);
    expect(byPayment).toEqual([accrual]);
  });
});
