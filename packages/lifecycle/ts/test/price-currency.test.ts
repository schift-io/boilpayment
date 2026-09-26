// [EC:A33] A subscription's currency decides its price ref and its upgrade delta: no silent switch to
// another currency's price ref, and a missing old price is refused instead of being read as 0.
import { describe, it, expect } from 'vitest';
import type { Plan } from 'boilpayment-core';
import { resolvePriceRef } from '../src/internal.js';

const plan: Plan = { id: 'pro', name: 'Pro', interval: 'month', creditsPerPeriod: 100, usageIncluded: 0, trialDays: 0,
  prices: [{ currency: 'KRW', amountMinor: 13000, providerPriceRefs: { stripe: 'price_krw' } }] };

describe('[EC:A33] price ref in the subscription currency', () => {
  it('[EC:A33] a USD subscription on a KRW-only plan is refused, not given the KRW price ref', () => {
    expect(() => resolvePriceRef(plan, 'stripe', 'USD')).toThrowError(expect.objectContaining({ code: 'plan_price_missing' }));
  });
  it('[EC:A33] the same currency returns its own ref; no currency keeps the first ref', () => {
    expect(resolvePriceRef(plan, 'stripe', 'KRW')).toBe('price_krw');
    expect(resolvePriceRef(plan, 'stripe', null)).toBe('price_krw');
  });
});
