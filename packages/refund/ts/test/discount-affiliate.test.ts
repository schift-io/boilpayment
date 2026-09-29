import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICY,
  FixedClock,
  InMemoryLedger,
  InMemoryRepo,
  SequentialIdGen,
  resolvePolicy,
} from 'boilpayment-core';
import type {
  AffiliateCommission,
  AffiliateCommissionFilter,
  Money,
  NormalizedEvent,
  Payment,
  PaymentProvider,
  ProviderCapabilities,
  Refund,
  RefundDecision,
} from 'boilpayment-core';
import { appendAffiliateReversals } from '../src/affiliate-reversal.js';
import { evaluate, execute, onExternalRefund } from '../src/index.js';

class RefundProvider implements PaymentProvider {
  readonly name = 'stripe' as const;
  calls = 0;

  capabilities(): ProviderCapabilities {
    return { nativeSubscriptions: true, partialRefund: true, meters: false, scheduling: 'provider', webhookSignature: true };
  }

  async createCustomer(): Promise<never> { throw new Error('unused'); }
  async createCheckout(): Promise<never> { throw new Error('unused'); }
  async getPayment(): Promise<never> { throw new Error('unused'); }
  async listPayments(): Promise<Payment[]> { return []; }
  async getSubscription(): Promise<never> { throw new Error('unused'); }
  async changeSubscription(): Promise<never> { throw new Error('unused'); }
  async cancelSubscription(): Promise<never> { throw new Error('unused'); }
  async chargeBillingKey(): Promise<never> { throw new Error('unused'); }
  async reportUsage(): Promise<void> {}
  async verifyWebhook(): Promise<never> { throw new Error('unused'); }

  async refund(input: { paymentRef: string; amount: Money }): Promise<Refund> {
    this.calls += 1;
    return {
      id: `refund_${input.paymentRef}_${input.amount.amountMinor}`,
      paymentId: '',
      customerId: '',
      amount: input.amount,
      status: 'succeeded',
      providerRef: `provider_${input.paymentRef}_${input.amount.amountMinor}`,
      creditsRevoked: 0,
      ruleId: '',
      reason: null,
      failure: null,
      createdAt: new Date(0),
    };
  }
}

const customerId = 'customer_discount';
let clock: FixedClock;
let ids: SequentialIdGen;
let ledger: InMemoryLedger;
let repo: InMemoryRepo;

class FailOnceReversalTable {
  private failed = false;

  constructor(private readonly delegate: InMemoryRepo['affiliateCommissions']) {}

  async append(row: AffiliateCommission): Promise<AffiliateCommission> {
    if (row.kind === 'reversal' && !this.failed) {
      this.failed = true;
      throw new Error('reversal append interrupted');
    }
    return this.delegate.append(row);
  }

  list(filter?: AffiliateCommissionFilter): Promise<AffiliateCommission[]> {
    return this.delegate.list(filter);
  }
}

beforeEach(() => {
  clock = new FixedClock(new Date('2026-09-28T00:00:00Z'));
  ids = new SequentialIdGen('refund_test_');
  ledger = new InMemoryLedger(ids, clock);
  repo = new InMemoryRepo();
});

async function payment(id: string, paidMinor: number, affiliateId: string | null = null): Promise<Payment> {
  const row: Payment = {
    id,
    customerId,
    provider: 'stripe',
    providerRef: `pi_${id}`,
    subscriptionId: null,
    amount: { amountMinor: paidMinor, currency: 'USD' },
    status: 'succeeded',
    kind: 'topup',
    period: null,
    occurredAt: clock.now(),
    failure: null,
    cashReceipt: null,
    affiliateId,
  };
  await repo.payments.put(row);
  return row;
}

async function grant(row: Payment, credits = 100, listUnitPriceMinor = 10): Promise<void> {
  await ledger.append({
    customerId,
    pool: 'paid',
    kind: 'grant',
    amount: credits,
    source: 'topup',
    reference: { paymentId: row.id },
    idempotencyKey: `grant:${row.id}`,
    actor: 'system',
    reason: null,
    unitPriceMinor: listUnitPriceMinor,
    currency: 'USD',
    expiresAt: null,
  });
}

async function addAccrual(row: Payment, amountMinor = 100): Promise<void> {
  await repo.affiliateCommissions.append({
    id: `accrual_${row.id}`,
    kind: 'accrual',
    affiliateId: row.affiliateId ?? 'affiliate_1',
    paymentId: row.id,
    refundId: null,
    relatedAccrualId: null,
    amount: { amountMinor, currency: row.amount.currency },
    idempotencyKey: `affiliate-accrual:${row.id}`,
    createdAt: clock.now(),
  });
}

function decision(row: Payment, refundMinor: number): RefundDecision {
  return {
    eligible: true,
    amount: { amountMinor: refundMinor, currency: row.amount.currency },
    creditsToRevoke: 0,
    ruleId: 'D2',
    reason: 'test refund',
    needsHuman: false,
    paymentId: row.id,
    customerId: row.customerId,
    subscriptionId: null,
  };
}

describe('discounted refund valuation', () => {
  it('[DC-03] values used credits from the 20%-discounted paid amount', async () => {
    // Given
    const row = await payment('pay_rate_discount', 800);
    await grant(row);
    await ledger.consume({
      customerId,
      poolOrder: ['paid'],
      amount: 25,
      idempotencyKey: 'consume:discounted',
      meta: { reason: 'usage' },
      now: clock.now(),
      negativeBalance: 'block',
      negativeFloor: 0,
    });
    clock.advance(8 * 86_400_000);

    // When
    const result = await evaluate({ payment: row, policy: DEFAULT_POLICY, ledger, repo, clock });

    // Then
    expect(result.amount.amountMinor).toBe(600);
    expect(result.creditsToRevoke).toBe(75);
  });

  it('[DC-04] caps a fixed-discount refund at paid while revoking every unused credit', async () => {
    // Given
    const row = await payment('pay_fixed_discount', 500);
    await grant(row);
    clock.advance(8 * 86_400_000);

    // When
    const result = await evaluate({ payment: row, policy: resolvePolicy({ refund: { method: 'unused_credits' } }), ledger, repo, clock });

    // Then
    expect(result.amount.amountMinor).toBe(500);
    expect(result.creditsToRevoke).toBe(100);
  });
});

describe('affiliate refund reversals', () => {
  it.each([
    { label: 'partial', paidMinor: 1000, refundMinor: 250, expected: 25 },
    { label: 'full', paidMinor: 1000, refundMinor: 1000, expected: 100 },
  ])('[AF-03] appends the exact $label support reversal once on replay', async ({ label, paidMinor, refundMinor, expected }) => {
    // Given
    const row = await payment(`pay_${label}`, paidMinor, 'affiliate_1');
    await addAccrual(row);
    const provider = new RefundProvider();
    const input = { decision: decision(row, refundMinor), provider, ledger, repo, clock, ids, idempotencyKey: `support-refund:${row.id}` };

    // When
    await execute(input);
    await execute(input);

    // Then
    const reversals = await repo.affiliateCommissions.list({ paymentId: row.id, kind: 'reversal' });
    expect(reversals).toHaveLength(1);
    expect(reversals[0]?.amount).toEqual({ amountMinor: expected, currency: 'USD' });
    expect(provider.calls).toBe(1);
  });

  it('[AF-03] appends one proportional reversal for an authoritative external refund replay', async () => {
    // Given
    const row = await payment('pay_external_affiliate', 1000, 'affiliate_1');
    await addAccrual(row, 101);
    const event: NormalizedEvent = {
      id: 'evt_external_refund',
      provider: 'stripe',
      type: 'refund.created',
      occurredAt: clock.now(),
      customerRef: null,
      subscriptionRef: null,
      paymentRef: row.providerRef,
      amount: { amountMinor: 333, currency: 'USD' },
      refundRef: 're_external_affiliate',
      raw: {},
    };
    const cs = { openReconcileMismatchCase: async (): Promise<void> => {} };
    const input = { event, ledger, repo, cs, clock, ids };

    // When
    await onExternalRefund(input);
    await onExternalRefund(input);

    // Then
    const reversals = await repo.affiliateCommissions.list({ paymentId: row.id, kind: 'reversal' });
    expect(reversals).toHaveLength(1);
    expect(reversals[0]?.amount).toEqual({ amountMinor: 34, currency: 'USD' });
  });

  it('[AF-03] appends a zero reversal without division for a zero-paid external refund', async () => {
    // Given
    const row = await payment('pay_external_zero', 0, 'affiliate_1');
    await addAccrual(row, 100);
    const event: NormalizedEvent = {
      id: 'evt_external_zero', provider: 'stripe', type: 'refund.created', occurredAt: clock.now(),
      customerRef: null, subscriptionRef: null, paymentRef: row.providerRef,
      amount: { amountMinor: 0, currency: 'USD' }, refundRef: 're_external_zero', raw: {},
    };

    // When
    await onExternalRefund({
      event, ledger, repo, cs: { openReconcileMismatchCase: async (): Promise<void> => {} }, clock, ids,
    });

    // Then
    const reversals = await repo.affiliateCommissions.list({ paymentId: row.id, kind: 'reversal' });
    expect(reversals).toHaveLength(1);
    expect(reversals[0]?.amount).toEqual({ amountMinor: 0, currency: 'USD' });
  });

  it('[AF-03] repairs a support reversal after settlement persisted before an interrupted append', async () => {
    const row = await payment('pay_support_repair', 1_000, 'affiliate_1');
    await addAccrual(row, 101);
    repo.affiliateCommissions = new FailOnceReversalTable(repo.affiliateCommissions);
    const provider = new RefundProvider();
    const input = { decision: decision(row, 333), provider, ledger, repo, clock, ids, idempotencyKey: `support-refund:${row.id}` };

    await expect(execute(input)).rejects.toThrow('reversal append interrupted');
    await expect(execute(input)).resolves.toMatchObject({ status: 'succeeded' });

    expect(await repo.affiliateCommissions.list({ paymentId: row.id, kind: 'reversal' })).toHaveLength(1);
    expect(provider.calls).toBe(1);
  });

  it('[AF-03] repairs an external reversal when the settled refund is replayed', async () => {
    const row = await payment('pay_external_repair', 1_000, 'affiliate_1');
    await addAccrual(row, 101);
    repo.affiliateCommissions = new FailOnceReversalTable(repo.affiliateCommissions);
    const event: NormalizedEvent = {
      id: 'evt_external_repair', provider: 'stripe', type: 'refund.created', occurredAt: clock.now(),
      customerRef: null, subscriptionRef: null, paymentRef: row.providerRef,
      amount: { amountMinor: 333, currency: 'USD' }, refundRef: 're_external_repair', raw: {},
    };
    const input = { event, ledger, repo, cs: { openReconcileMismatchCase: async (): Promise<void> => {} }, clock, ids };

    await expect(onExternalRefund(input)).rejects.toThrow('reversal append interrupted');
    await expect(onExternalRefund(input)).resolves.toMatchObject({ status: 'succeeded' });

    expect(await repo.affiliateCommissions.list({ paymentId: row.id, kind: 'reversal' })).toHaveLength(1);
  });

  it('[AF-03] never reverses more than the accrual across multiple partial refunds', async () => {
    const row = await payment('pay_external_cumulative', 100, 'affiliate_1');
    await addAccrual(row, 1);
    const cs = { openReconcileMismatchCase: async (): Promise<void> => {} };
    const event = (suffix: string): NormalizedEvent => ({
      id: `evt_${suffix}`, provider: 'stripe', type: 'refund.created', occurredAt: clock.now(),
      customerRef: null, subscriptionRef: null, paymentRef: row.providerRef,
      amount: { amountMinor: 1, currency: 'USD' }, refundRef: `re_${suffix}`, raw: {},
    });

    await onExternalRefund({ event: event('one'), ledger, repo, cs, clock, ids });
    await onExternalRefund({ event: event('two'), ledger, repo, cs, clock, ids });

    const reversals = await repo.affiliateCommissions.list({ paymentId: row.id, kind: 'reversal' });
    expect(reversals.map((row) => row.amount.amountMinor)).toEqual([1, 0]);
  });

  it('[AF-03] atomically caps simultaneous distinct refunds against one accrual', async () => {
    const row = await payment('pay_concurrent_affiliate', 1000, 'affiliate_1');
    await addAccrual(row, 100);
    const refund = (id: string): Refund => ({
      id, paymentId: row.id, customerId, amount: { amountMinor: 750, currency: 'USD' },
      status: 'succeeded', providerRef: id, creditsRevoked: 0, ruleId: 'D8', reason: null,
      failure: null, createdAt: clock.now(),
    });

    await Promise.all([
      appendAffiliateReversals({ repo, ledger, clock, payment: row, refund: refund('refund_concurrent_1') }),
      appendAffiliateReversals({ repo, ledger, clock, payment: row, refund: refund('refund_concurrent_2') }),
    ]);

    const reversals = await repo.affiliateCommissions.list({ paymentId: row.id, kind: 'reversal' });
    expect(reversals.reduce((sum, item) => sum + item.amount.amountMinor, 0)).toBe(100);
  });
});
