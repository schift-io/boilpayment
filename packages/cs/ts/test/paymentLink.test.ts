import { describe, expect, it } from 'vitest';
import { PaymentKitError } from 'boilpayment-core';
import { buildPaymentLinkUrl, decodePaymentLinkReference } from '../src/index.js';

describe('PL-01 payment link references', () => {
  it.each([
    ['stripe', 'client_reference_id'],
    ['polar', 'reference_id'],
  ] as const)('round-trips customer and affiliate for %s', (provider, parameter) => {
    // Given
    const linkUrl = 'https://pay.example/link?locale=ko';

    // When
    const built = buildPaymentLinkUrl({ provider, linkUrl, customerId: 'customer-1', affiliateId: 'partner-1' });

    // Then
    const reference = new URL(built).searchParams.get(parameter);
    expect(new URL(built).searchParams.get('locale')).toBe('ko');
    expect(reference).toMatch(/^[A-Za-z0-9_-]{1,200}$/);
    expect(decodePaymentLinkReference(reference ?? '')).toEqual({ customerId: 'customer-1', affiliateId: 'partner-1' });
  });

  it('rejects a Stripe reference that would be silently dropped', () => {
    // Given
    const customerId = 'x'.repeat(300);

    // When / Then
    expect(() => buildPaymentLinkUrl({ provider: 'stripe', linkUrl: 'https://buy.stripe.com/x', customerId }))
      .toThrow(PaymentKitError);
  });

  it('returns null for malformed or unsupported reference payloads', () => {
    // Given / When / Then
    expect(decodePaymentLinkReference('not-a-kit-reference')).toBeNull();
  });
});
