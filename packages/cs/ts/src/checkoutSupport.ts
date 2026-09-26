import { PaymentKitError, runIdempotent } from '@schift/payment-kit-core';
import type { Checkout, Payment, ProviderName } from '@schift/payment-kit-core';
import type { SupportDeps } from './support.js';
import { parseCheckoutSnapshot, parsePurchaseSnapshot, matchesCheckoutPayment } from './purchaseSnapshot.js';
import type { CheckoutSnapshot, PurchaseSnapshot } from './purchaseSnapshot.js';

export interface StartCheckoutInput extends SupportDeps {
  readonly customerId: string; readonly planId: string; readonly provider: ProviderName;
  readonly currency: string; readonly requestId: string; readonly successUrl: string; readonly cancelUrl: string;
}
export interface RegisterCompletedCheckoutInput extends SupportDeps {
  readonly customerId: string; readonly checkoutId: string; readonly paymentRef: string; readonly subscriptionRef?: string;
}
/** Capture immutable sale rules before a provider checkout can be created. */
export async function startCheckout(input: StartCheckoutInput): Promise<Checkout> {
  const key = `checkout-entitlement:${input.customerId}:${input.requestId}`;
  const { result: snapshot } = await runIdempotent<CheckoutSnapshot>({ repo: input.repo, clock: input.clock, key, kind: 'checkout.entitlement',
    payload: { customerId: input.customerId, planId: input.planId, provider: input.provider, currency: input.currency },
    serialize: (value) => value, deserialize: parseCheckoutSnapshot,
    fn: async () => {
      const customer = await input.repo.customers.get(input.customerId); const plan = await input.repo.plans.get(input.planId);
      const customerRef = customer?.providerRefs.find((ref) => ref.provider === input.provider)?.ref;
      const prices = plan?.prices.filter((price) => price.currency === input.currency) ?? [];
      const price = prices.length === 1 ? prices[0] : undefined;
      if (!customerRef || !plan || !price) throw new PaymentKitError('customer, plan or unique price missing', 'checkout_evidence_missing');
      return structuredClone({ intentKey: key, checkoutId: null, checkoutProviderRef: null, customerId: input.customerId, customerRef, provider: input.provider, plan, price, policy: input.policy, capturedAt: input.clock.now().toISOString() });
    } });
  const provider = input.providers[snapshot.provider];
  if (!provider) throw new PaymentKitError('checkout provider unavailable', 'checkout_evidence_missing');
  const attempt = await runIdempotent<CheckoutAttempt>({ repo: input.repo, clock: input.clock,
    key: `checkout-result:${input.customerId}:${input.requestId}`, kind: 'checkout.entitlement',
    payload: { key, successUrl: input.successUrl, cancelUrl: input.cancelUrl },
    serialize: (value) => value, deserialize: parseCheckoutAttempt,
    fn: async () => {
      try {
        const checkout = await provider.createCheckout({ customerRef: snapshot.customerRef, plan: snapshot.plan, price: snapshot.price,
    mode: snapshot.plan.interval === null ? 'one_time' : 'subscription', successUrl: input.successUrl, cancelUrl: input.cancelUrl,
    idempotencyKey: key, metadata: { customerId: snapshot.customerId, planId: snapshot.plan.id, checkoutEntitlementKey: key } });

        return { kind: 'succeeded', checkout };
      } catch (error) {
        if (error instanceof Error) return { kind: 'unknown' };
        throw error;
      }
    } });
  if (attempt.result.kind === 'unknown') throw new PaymentKitError('checkout creation outcome unknown; reconcile before a new request', 'checkout_outcome_unknown');
  const checkout = attempt.result.checkout;
  await runIdempotent({ repo: input.repo, clock: input.clock, key: `checkout-entitlement-by-id:${checkout.id}`, kind: 'checkout.entitlement',
    payload: { key }, serialize: (value) => value, deserialize: parseCheckoutSnapshot, fn: async () => ({ ...snapshot, checkoutId: checkout.id, checkoutProviderRef: checkout.providerRef }) });
  return checkout;
}

/** Bind verified provider payment facts to the previously captured sale. */
export async function registerCompletedCheckout(input: RegisterCompletedCheckoutInput): Promise<Payment> {
  const operation = await input.repo.operations.get(`checkout-entitlement-by-id:${input.checkoutId}`);
  if (!operation || operation.kind !== 'checkout.entitlement' || operation.status !== 'done') throw new PaymentKitError('checkout snapshot missing', 'checkout_evidence_missing');
  const snapshot = parseCheckoutSnapshot(operation.result);
  if (snapshot.customerId !== input.customerId) throw new PaymentKitError('checkout customer mismatch', 'checkout_evidence_mismatch');
  const provider = input.providers[snapshot.provider];
  if (!provider) throw new PaymentKitError('checkout provider unavailable', 'checkout_evidence_missing');
  const live = await provider.getPayment(input.paymentRef);
  const listed = await provider.listPayments({ customerRef: snapshot.customerRef, since: new Date(snapshot.capturedAt) });
  if (!matchesCheckoutPayment(snapshot, live.raw, input.paymentRef) || live.providerRef !== input.paymentRef || live.provider !== snapshot.provider || live.status !== 'succeeded'
    || live.amount.amountMinor !== snapshot.price.amountMinor || live.amount.currency !== snapshot.price.currency
    || !listed.some((payment) => payment.providerRef === input.paymentRef)
    || (live.customerId !== '' && live.customerId !== snapshot.customerId && live.customerId !== snapshot.customerRef)) {
    throw new PaymentKitError('provider payment does not match captured sale', 'checkout_evidence_mismatch');
  }
  const paymentId = `payment:${snapshot.provider}:${input.paymentRef}`;
  let subscriptionId: string | null = null;
  let period = live.period;
  if (snapshot.plan.interval !== null) {
    const subscriptionRef = input.subscriptionRef ?? live.subscriptionId;
    if (!subscriptionRef || live.subscriptionId !== subscriptionRef) throw new PaymentKitError('subscription payment correlation missing', 'checkout_evidence_missing');
    const liveSub = await provider.getSubscription(subscriptionRef);
    if (liveSub.customerId !== snapshot.customerId && liveSub.customerId !== snapshot.customerRef) throw new PaymentKitError('subscription ownership mismatch', 'checkout_evidence_mismatch');
    subscriptionId = `subscription:${snapshot.provider}:${subscriptionRef}`;
    period = live.period ?? liveSub.currentPeriod;
    const existing = await input.repo.subscriptions.get(subscriptionId);
    if (!existing) await input.repo.subscriptions.put({ ...liveSub, id: subscriptionId, customerId: snapshot.customerId, planId: snapshot.plan.id, provider: snapshot.provider, providerRef: subscriptionRef });
  }
  const purchase: PurchaseSnapshot = { ...snapshot, paymentId, paymentRef: input.paymentRef,
    purchasedAt: live.occurredAt.toISOString(), subscriptionId, period: period ? { start: period.start.toISOString(), end: period.end.toISOString() } : null };
  const { result: recorded } = await runIdempotent({ repo: input.repo, clock: input.clock,
    key: `purchase-entitlement:${paymentId}`, kind: 'purchase.entitlement', payload: { checkoutId: input.checkoutId, paymentRef: input.paymentRef },
    serialize: (value) => value, deserialize: parsePurchaseSnapshot, fn: async () => purchase });
  const existing = await input.repo.payments.get(paymentId);
  if (existing) return existing;
  const payment: Payment = { ...live, id: paymentId, customerId: recorded.customerId, subscriptionId: recorded.subscriptionId,
    kind: recorded.plan.interval === null ? 'topup' : 'subscription', period, cashReceipt: live.cashReceipt ?? null };
  await input.repo.payments.put(payment);
  return payment;
}

type CheckoutAttempt = { readonly kind: 'succeeded'; readonly checkout: Checkout } | { readonly kind: 'unknown' };
function parseCheckoutAttempt(value: unknown): CheckoutAttempt {
  if (typeof value !== 'object' || value === null || !('kind' in value)) throw new PaymentKitError('invalid checkout attempt', 'purchase_snapshot_invalid');
  if (value.kind === 'unknown') return { kind: 'unknown' };
  if (!('checkout' in value) || typeof value.checkout !== 'object' || value.checkout === null) throw new PaymentKitError('missing checkout result', 'purchase_snapshot_invalid');
  const checkout = value.checkout;
  if (!('id' in checkout) || typeof checkout.id !== 'string' || !('url' in checkout) || typeof checkout.url !== 'string'
    || !('providerRef' in checkout) || typeof checkout.providerRef !== 'string') throw new PaymentKitError('invalid checkout result', 'purchase_snapshot_invalid');
  return { kind: 'succeeded', checkout: { id: checkout.id, url: checkout.url, providerRef: checkout.providerRef } };
}
