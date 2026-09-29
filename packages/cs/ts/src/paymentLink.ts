import { PaymentKitError } from 'boilpayment-core';
import type { ProviderName } from 'boilpayment-core';

const STRIPE_REFERENCE = /^[A-Za-z0-9_-]{1,200}$/;

export interface BuildPaymentLinkUrlInput {
  readonly provider: ProviderName;
  readonly linkUrl: string;
  readonly customerId: string;
  readonly affiliateId?: string | null;
}

export interface PaymentLinkReference {
  readonly customerId: string;
  readonly affiliateId: string | null;
}

/** Add a compact, provider-safe customer reference without replacing existing link parameters. */
export function buildPaymentLinkUrl(input: BuildPaymentLinkUrlInput): string {
  if (input.customerId.length === 0 || input.affiliateId === '') {
    throw new PaymentKitError('payment link reference values must be non-empty', 'payment_link_reference_invalid');
  }
  const reference = Buffer.from(JSON.stringify({ v: 1, c: input.customerId, a: input.affiliateId ?? null }), 'utf8').toString('base64url');
  if (!STRIPE_REFERENCE.test(reference)) {
    throw new PaymentKitError('payment link reference exceeds provider limits', 'payment_link_reference_invalid');
  }
  let url: URL;
  try {
    url = new URL(input.linkUrl);
  } catch (error) {
    if (error instanceof TypeError) throw new PaymentKitError('payment link URL is invalid', 'payment_link_url_invalid');
    throw error;
  }
  switch (input.provider) {
    case 'stripe':
      url.searchParams.set('client_reference_id', reference);
      break;
    case 'polar':
      url.searchParams.set('reference_id', reference);
      break;
    default:
      throw new PaymentKitError('payment links support Stripe and Polar only', 'payment_link_provider_unsupported');
  }
  return url.toString();
}

/** Parse an untrusted provider reference. Invalid and non-kit references are intentionally ignored. */
export function decodePaymentLinkReference(reference: string): PaymentLinkReference | null {
  if (!STRIPE_REFERENCE.test(reference)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(reference, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)
      || !('v' in parsed) || parsed.v !== 1 || !('c' in parsed) || typeof parsed.c !== 'string' || parsed.c.length === 0
      || !('a' in parsed) || (parsed.a !== null && (typeof parsed.a !== 'string' || parsed.a.length === 0))) return null;
    return { customerId: parsed.c, affiliateId: parsed.a };
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}
