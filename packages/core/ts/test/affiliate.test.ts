import { describe, expect, it } from 'vitest';
import {
  calculateAffiliateAccrual,
  calculateAffiliateReversal,
  InMemoryAffiliateCommissionTable,
  money,
  type AffiliateCommission,
  type CreateCheckoutInput,
  type Deps,
  type Payment,
  type SaleEvidence,
  type Subscription,
} from '../src/index.js';

const createdAt = new Date('2026-09-28T00:00:00Z');

function commission(overrides: Partial<AffiliateCommission> = {}): AffiliateCommission {
  return {
    id: 'commission-1',
    kind: 'accrual',
    affiliateId: 'affiliate-1',
    paymentId: 'payment-1',
    refundId: null,
    relatedAccrualId: null,
    amount: money(100, 'usd'),
    idempotencyKey: 'affiliate:payment-1:accrual',
    createdAt,
    ...overrides,
  };
}

describe('affiliate commission math', () => {
  it('floors a rate accrual and preserves the payment currency', () => {
    // Given / When / Then
    expect(calculateAffiliateAccrual(money(1_999, 'usd'), { type: 'rate', rate: 0.15 })).toEqual(
      money(299, 'usd'),
    );
  });

  it('caps fixed and rate accruals at the nonnegative paid amount', () => {
    // Given / When / Then
    expect(calculateAffiliateAccrual(money(500, 'krw'), { type: 'fixed', amountMinor: 900 })).toEqual(
      money(500, 'krw'),
    );
    expect(calculateAffiliateAccrual(money(500, 'krw'), { type: 'rate', rate: 2 })).toEqual(
      money(500, 'krw'),
    );
    expect(calculateAffiliateAccrual(money(-1, 'krw'), { type: 'fixed', amountMinor: 100 })).toEqual(
      money(0, 'krw'),
    );
  });

  it('ceils a proportional reversal toward the affiliate receiving less', () => {
    // Given / When / Then: 299 * 1 / 3 = 99.666...
    expect(calculateAffiliateReversal(money(299, 'usd'), money(1, 'usd'), money(3, 'usd'))).toEqual(
      money(100, 'usd'),
    );
  });

  it('caps a reversal at its accrual', () => {
    // Given / When / Then
    expect(calculateAffiliateReversal(money(300, 'usd'), money(2_000, 'usd'), money(1_000, 'usd'))).toEqual(
      money(300, 'usd'),
    );
  });
});

describe('InMemoryAffiliateCommissionTable', () => {
  it('appends once per idempotency key and filters by affiliate, payment, and kind', async () => {
    // Given
    const table = new InMemoryAffiliateCommissionTable();
    const first = commission();
    const conflictingRetry = commission({ id: 'commission-2', amount: money(999, 'usd') });
    const reversal = commission({
      id: 'commission-3',
      kind: 'reversal',
      refundId: 'refund-1',
      relatedAccrualId: first.id,
      amount: money(25, 'usd'),
      idempotencyKey: 'affiliate:refund-1:reversal',
    });

    // When
    const appended = await table.append(first);
    const replayed = await table.append(conflictingRetry);
    await table.append(reversal);

    // Then
    expect(appended).toEqual(first);
    expect(replayed).toEqual(first);
    expect(await table.list({ affiliateId: 'affiliate-1' })).toEqual([first, reversal]);
    expect(await table.list({ paymentId: 'payment-1', kind: 'reversal' })).toEqual([reversal]);
    appended.amount.amountMinor = 999;
    const listed = await table.list({ paymentId: 'payment-1', kind: 'accrual' });
    if (listed[0]) listed[0].amount.amountMinor = 888;
    expect((await table.list({ paymentId: 'payment-1', kind: 'accrual' }))[0]?.amount.amountMinor).toBe(100);
  });
});

describe('discount and affiliate contract compatibility', () => {
  it('accepts typed sale evidence and optional checkout and subscription affiliate fields', () => {
    // Given
    const evidence: SaleEvidence = {
      providerSubtotal: money(2_000, 'usd'),
      discountAmount: money(500, 'usd'),
      priceRef: 'price-1',
      checkoutId: 'checkout-1',
      paymentLinkId: null,
      linkReference: null,
    };
    const payment: Pick<Payment, 'saleEvidence' | 'affiliateId'> = {
      saleEvidence: evidence,
      affiliateId: 'affiliate-1',
    };
    const checkout: Pick<CreateCheckoutInput, 'allowDiscountCodes' | 'presetDiscountCode' | 'affiliateId'> = {
      allowDiscountCodes: false,
      presetDiscountCode: null,
      affiliateId: null,
    };
    const subscription: Pick<Subscription, 'affiliateId'> = { affiliateId: 'affiliate-1' };
    const deps: Pick<Deps, 'affiliateCommission'> = {
      affiliateCommission: (input: Payment) => input.amount.amountMinor,
    };

    // When / Then
    expect(payment.saleEvidence).toBe(evidence);
    expect(checkout.allowDiscountCodes).toBe(false);
    expect(subscription.affiliateId).toBe('affiliate-1');
    expect(deps.affiliateCommission).toBeTypeOf('function');
  });
});
