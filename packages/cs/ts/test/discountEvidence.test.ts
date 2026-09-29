import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from 'boilpayment-core';
import type { Payment } from 'boilpayment-core';
import { matchesCapturedSaleAmount } from '../src/purchaseSnapshot.js';
import type { CheckoutSnapshot } from '../src/purchaseSnapshot.js';

const snapshot = {
  intentKey: 'key', checkoutId: 'cs_1', checkoutProviderRef: 'cs_1', customerId: 'customer', customerRef: 'cus_1',
  provider: 'stripe', plan: { id: 'plan', name: 'Plan', interval: null, creditsPerPeriod: 100, usageIncluded: 0, trialDays: 0, prices: [] },
  price: { currency: 'USD', amountMinor: 2_000, providerPriceRefs: { stripe: 'price_1' } }, policy: DEFAULT_POLICY,
  capturedAt: '2026-09-28T00:00:00.000Z', allowDiscountCodes: true, presetDiscountCode: null, affiliateId: null,
} satisfies CheckoutSnapshot;
const saleEvidence = { providerSubtotal: { currency: 'USD', amountMinor: 2_000 }, discountAmount: { currency: 'USD', amountMinor: 400 }, priceRef: 'price_1', checkoutId: 'cs_1', paymentLinkId: null, linkReference: null };
const payment = {
  id: 'payment:stripe:pi_1', customerId: 'customer', provider: 'stripe', providerRef: 'pi_1', subscriptionId: null,
  amount: { currency: 'USD', amountMinor: 1_600 }, status: 'succeeded', kind: 'topup', period: null,
  occurredAt: new Date('2026-09-28T00:00:00.000Z'), failure: null, cashReceipt: null, saleEvidence,
} satisfies Payment;

describe('DC-02 provider discount evidence', () => {
  it('accepts a discounted amount when provider arithmetic matches the captured price', () => {
    // Given / When / Then
    expect(matchesCapturedSaleAmount(snapshot, payment)).toBe(true);
  });

  it('refuses a lower payment without a provider discount', () => {
    // Given / When / Then
    expect(matchesCapturedSaleAmount(snapshot, { ...payment, saleEvidence: null })).toBe(false);
  });

  it('refuses discount evidence for a different provider price', () => {
    // Given / When / Then
    expect(matchesCapturedSaleAmount(snapshot, { ...payment, saleEvidence: { ...saleEvidence, priceRef: 'price_other' } })).toBe(false);
  });
});
