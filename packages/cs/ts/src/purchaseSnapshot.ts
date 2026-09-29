import { PaymentKitError, validatePolicy } from 'boilpayment-core';
import type { Payment, Plan, PlanPrice, Policy, ProviderName, Repo } from 'boilpayment-core';

export interface CheckoutSnapshot {
  readonly intentKey: string;
  readonly checkoutId: string | null;
  readonly checkoutProviderRef: string | null;
  readonly customerId: string;
  readonly customerRef: string;
  readonly provider: ProviderName;
  readonly plan: Plan;
  readonly price: PlanPrice;
  readonly policy: Policy;
  readonly capturedAt: string;
  readonly allowDiscountCodes: boolean;
  readonly presetDiscountCode: string | null;
  readonly affiliateId: string | null;
}
export interface PurchaseSnapshot extends CheckoutSnapshot {
  readonly paymentId: string;
  readonly paymentRef: string;
  readonly purchasedAt: string;
  readonly subscriptionId: string | null;
  readonly period: { readonly start: string; readonly end: string } | null;
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new PaymentKitError('invalid purchase snapshot string', 'purchase_snapshot_invalid');
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new PaymentKitError('invalid purchase snapshot amount', 'purchase_snapshot_invalid');
  return value;
}
function optionalText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}
function price(value: unknown): PlanPrice {
  if (!record(value)) throw new PaymentKitError('invalid purchase price', 'purchase_snapshot_invalid');
  const providerPriceRefs: Partial<Record<ProviderName, string>> = {};
  if (record(value.providerPriceRefs)) for (const provider of ['stripe', 'polar', 'toss', 'portone', 'apple', 'google_play'] as const) {
    const ref = value.providerPriceRefs[provider];
    if (typeof ref === 'string') providerPriceRefs[provider] = ref;
  }
  return { currency: text(value.currency), amountMinor: integer(value.amountMinor), providerPriceRefs };
}
export function parseCheckoutSnapshot(value: unknown): CheckoutSnapshot {
  if (!record(value) || !record(value.plan) || !Array.isArray(value.plan.prices)) throw new PaymentKitError('purchase snapshot is missing', 'purchase_snapshot_invalid');
  const provider = value.provider;
  if (provider !== 'stripe' && provider !== 'polar' && provider !== 'toss' && provider !== 'portone' && provider !== 'apple' && provider !== 'google_play') throw new PaymentKitError('invalid purchase provider', 'purchase_snapshot_invalid');
  const interval = value.plan.interval;
  if (interval !== null && interval !== 'month' && interval !== 'year') throw new PaymentKitError('invalid purchase interval', 'purchase_snapshot_invalid');
  const plan: Plan = { id: text(value.plan.id), name: text(value.plan.name), interval,
    creditsPerPeriod: integer(value.plan.creditsPerPeriod), usageIncluded: integer(value.plan.usageIncluded),
    trialDays: integer(value.plan.trialDays), prices: value.plan.prices.map(price) };
  return { intentKey: text(value.intentKey), checkoutId: value.checkoutId === null ? null : text(value.checkoutId), checkoutProviderRef: value.checkoutProviderRef === null ? null : text(value.checkoutProviderRef), customerId: text(value.customerId), customerRef: text(value.customerRef), provider, plan,
    price: price(value.price), policy: validatePolicy(value.policy), capturedAt: text(value.capturedAt),
    allowDiscountCodes: value.allowDiscountCodes === true, presetDiscountCode: optionalText(value.presetDiscountCode),
    affiliateId: optionalText(value.affiliateId) };
}
export function parsePurchaseSnapshot(value: unknown): PurchaseSnapshot {
  const checkout = parseCheckoutSnapshot(value);
  if (!record(value)) throw new PaymentKitError('purchase snapshot is missing', 'purchase_snapshot_invalid');
  const period = record(value.period) ? { start: text(value.period.start), end: text(value.period.end) } : null;
  return { ...checkout, paymentId: text(value.paymentId), paymentRef: text(value.paymentRef), purchasedAt: text(value.purchasedAt),
    subscriptionId: value.subscriptionId === null ? null : text(value.subscriptionId), period };
}
export async function getPurchaseSnapshot(input: { readonly paymentId: string; readonly repo: Repo }): Promise<PurchaseSnapshot | null> {
  const operation = await input.repo.operations.get(`purchase-entitlement:${input.paymentId}`);
  return operation?.status === 'done' && operation.kind === 'purchase.entitlement' ? parsePurchaseSnapshot(operation.result) : null;
}

export function matchesCheckoutPayment(snapshot: CheckoutSnapshot, raw: unknown, paymentRef: string): boolean {
  if (snapshot.provider === 'portone') return paymentRef === snapshot.checkoutId;
  if (!record(raw)) return false;
  if (snapshot.provider === 'toss') return raw.orderId === snapshot.checkoutId;
  const metadata = record(raw.metadata) ? raw.metadata : null;
  return metadata?.checkoutEntitlementKey === snapshot.intentKey || (snapshot.provider === 'polar' && raw.checkout_id === snapshot.checkoutId);
}

/** Accept list price, or a lower amount only with provider-authored discount arithmetic. */
export function matchesCapturedSaleAmount(snapshot: CheckoutSnapshot, payment: Payment): boolean {
  if (snapshot.price.currency !== payment.amount.currency || payment.amount.amountMinor < 0) return false;
  if (snapshot.price.amountMinor === payment.amount.amountMinor) return true;
  const evidence = payment.saleEvidence;
  if (!evidence || evidence.providerSubtotal.currency !== snapshot.price.currency
    || evidence.discountAmount.currency !== snapshot.price.currency
    || evidence.providerSubtotal.amountMinor !== snapshot.price.amountMinor || evidence.discountAmount.amountMinor <= 0
    || evidence.providerSubtotal.amountMinor - evidence.discountAmount.amountMinor !== payment.amount.amountMinor) return false;
  const capturedPriceRef = snapshot.price.providerPriceRefs?.[snapshot.provider];
  return !capturedPriceRef || !evidence.priceRef || capturedPriceRef === evidence.priceRef;
}
