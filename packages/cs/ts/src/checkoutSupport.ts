import { PaymentKitError, ProviderError, runIdempotent } from 'boilpayment-core';
import type { Checkout, Payment, ProviderName, Subscription } from 'boilpayment-core';
import type { SupportDeps } from './support.js';
import { parseCheckoutSnapshot, parsePurchaseSnapshot, matchesCapturedSaleAmount, matchesCheckoutPayment } from './purchaseSnapshot.js';
import type { CheckoutSnapshot, PurchaseSnapshot } from './purchaseSnapshot.js';

export interface StartCheckoutInput extends SupportDeps {
  readonly customerId: string; readonly planId: string; readonly provider: ProviderName;
  readonly currency: string; readonly requestId: string; readonly successUrl: string; readonly cancelUrl: string;
  readonly allowDiscountCodes?: boolean; readonly presetDiscountCode?: string | null; readonly affiliateId?: string | null;
}
export interface RegisterCompletedCheckoutInput extends SupportDeps {
  readonly customerId: string; readonly checkoutId: string; readonly paymentRef: string; readonly subscriptionRef?: string;
}

function isDefinitiveProviderRefusal(error: ProviderError): boolean {
  const detailStatus = typeof error.details === 'object' && error.details !== null && 'status' in error.details
    && typeof error.details.status === 'number' ? error.details.status : undefined;
  const status = error.httpStatus ?? detailStatus;
  return status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429;
}

/** Capture immutable sale rules before a provider checkout can be created. */
export async function startCheckout(input: StartCheckoutInput): Promise<Checkout> {
  const key = `checkout-entitlement:${input.customerId}:${input.requestId}`;
  // EC:A73 — a frozen or banned customer (an open or lost dispute) buys nothing.
  const owner = await input.repo.customers.get(input.customerId);
  if (owner && owner.status !== 'active') throw new PaymentKitError(`customer is ${owner.status}`, `customer_${owner.status}`, { customerId: input.customerId });
  // EC:A74 — a Toss/PortOne subscription plan starts with startSubscription (a billing key), never a one-time checkout order.
  const selling = await input.repo.plans.get(input.planId);
  const seller = input.providers[input.provider];
  if (selling?.interval && seller && !seller.capabilities().nativeSubscriptions) {
    throw new PaymentKitError(`${input.provider} subscription plans start with startSubscription`, 'use_start_subscription', { planId: input.planId, provider: input.provider });
  }
  const { result: snapshot } = await runIdempotent<CheckoutSnapshot>({ repo: input.repo, clock: input.clock, key, kind: 'checkout.entitlement',
    payload: { customerId: input.customerId, planId: input.planId, provider: input.provider, currency: input.currency,
      allowDiscountCodes: input.allowDiscountCodes ?? false, presetDiscountCode: input.presetDiscountCode ?? null,
      affiliateId: input.affiliateId ?? null },
    serialize: (value) => value, deserialize: parseCheckoutSnapshot,
    fn: async () => {
      const customer = await input.repo.customers.get(input.customerId); const plan = await input.repo.plans.get(input.planId);
      const customerRef = customer?.providerRefs.find((ref) => ref.provider === input.provider)?.ref;
      const prices = plan?.prices.filter((price) => price.currency === input.currency) ?? [];
      const price = prices.length === 1 ? prices[0] : undefined;
      if (!customerRef || !plan || !price) throw new PaymentKitError('customer, plan or unique price missing', 'checkout_evidence_missing');
      return structuredClone({ intentKey: key, checkoutId: null, checkoutProviderRef: null, customerId: input.customerId, customerRef, provider: input.provider, plan, price, policy: input.policy, capturedAt: input.clock.now().toISOString(), allowDiscountCodes: input.allowDiscountCodes ?? false, presetDiscountCode: input.presetDiscountCode ?? null, affiliateId: input.affiliateId ?? null });
    } });
  const provider = input.providers[snapshot.provider];
  if (!provider) throw new PaymentKitError('checkout provider unavailable', 'checkout_evidence_missing');
  // OT-03 — Stripe/Polar adapters require a provider-side price reference. Validate the captured
  // sale before invoking createCheckout, and release the unsold snapshot so a catalog repair can
  // be recaptured by the same request id.
  if ((snapshot.provider === 'stripe' || snapshot.provider === 'polar')
    && !snapshot.price.providerPriceRefs?.[snapshot.provider]) {
    const captured = await input.repo.operations.get(key);
    if (captured?.status === 'done') await input.repo.operations.put({ ...captured, status: 'failed', result: null,
      error: 'missing_provider_price_ref', completedAt: input.clock.now() });
    const legacyKey = `checkout-result:${input.customerId}:${input.requestId}`;
    const legacy = await input.repo.operations.get(legacyKey);
    if (legacy?.status === 'done' && typeof legacy.result === 'object' && legacy.result !== null
      && 'kind' in legacy.result && legacy.result.kind === 'unknown') {
      await input.repo.operations.put({ ...legacy, status: 'failed', result: null,
        error: 'missing_provider_price_ref', completedAt: input.clock.now() });
    }
    throw new PaymentKitError(
      `set plan_prices.provider_price_refs for plan ${snapshot.plan.id} / ${snapshot.price.currency}`,
      'missing_provider_price_ref',
      { planId: snapshot.plan.id },
    );
  }
  const resultKey = `checkout-result:${input.customerId}:${input.requestId}`;
  let attempt;
  try {
    attempt = await runIdempotent<CheckoutAttempt>({ repo: input.repo, clock: input.clock,
    key: resultKey, kind: 'checkout.entitlement',
    payload: { key, successUrl: input.successUrl, cancelUrl: input.cancelUrl },
    serialize: (value) => value, deserialize: parseCheckoutAttempt,
    fn: async () => {
      try {
        const checkout = await provider.createCheckout({ customerRef: snapshot.customerRef, plan: snapshot.plan, price: snapshot.price,
    mode: snapshot.plan.interval === null ? 'one_time' : 'subscription', successUrl: input.successUrl, cancelUrl: input.cancelUrl,
    idempotencyKey: key, allowDiscountCodes: snapshot.allowDiscountCodes, presetDiscountCode: snapshot.presetDiscountCode,
    affiliateId: snapshot.affiliateId, metadata: { customerId: snapshot.customerId, planId: snapshot.plan.id, checkoutEntitlementKey: key,
      ...(snapshot.affiliateId ? { affiliateId: snapshot.affiliateId } : {}) } });

        return { kind: 'succeeded', checkout };
      } catch (error) {
        // OT-03 — the pre-request price validation is definitive; discard the unsold snapshot so a
        // catalog repair is recaptured on retry. Provider/transport outcomes remain unknown here.
        if (error instanceof PaymentKitError) {
          if (error instanceof ProviderError) {
            if (isDefinitiveProviderRefusal(error)) throw error;
            return { kind: 'unknown' };
          }
          if (error.code === 'missing_provider_price_ref') {
            const captured = await input.repo.operations.get(key);
            if (captured?.status === 'done') await input.repo.operations.put({ ...captured, status: 'failed', result: null,
              error: error.message, completedAt: input.clock.now() });
          }
          throw error;
        }
        if (error instanceof Error) return { kind: 'unknown' };
        throw error;
      }
    } });
  } catch (error) {
    if (error instanceof ProviderError && isDefinitiveProviderRefusal(error)) {
      await input.repo.operations.delete(resultKey);
      await input.repo.operations.delete(key);
    }
    throw error;
  }
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
  // EC:A65 — a Toss/PortOne subscription starts from a billing key (startSubscription), not a checkout payment.
  const bound = snapshot.provider === 'toss' || snapshot.provider === 'portone';
  if (snapshot.plan.interval !== null && bound) {
    throw new PaymentKitError(`${snapshot.provider} subscriptions start with startSubscription (billing key), not a checkout payment`, 'use_start_subscription');
  }
  const live = await provider.getPayment(snapshot.provider === 'stripe' ? snapshot.checkoutProviderRef ?? input.paymentRef : input.paymentRef);
  let subscriptionEvidence: { readonly ref: string; readonly live: Subscription } | null = null;
  if (snapshot.plan.interval !== null) {
    const subscriptionRef = input.subscriptionRef ?? live.subscriptionId;
    if (!subscriptionRef || live.subscriptionId !== subscriptionRef) throw new PaymentKitError('subscription payment correlation missing', 'checkout_evidence_missing');
    const liveSub = await provider.getSubscription(subscriptionRef);
    if (liveSub.customerId !== snapshot.customerId && liveSub.customerId !== snapshot.customerRef) throw new PaymentKitError('subscription ownership mismatch', 'checkout_evidence_mismatch');
    subscriptionEvidence = { ref: subscriptionRef, live: liveSub };
  }
  // EC:A67 — Toss and PortOne bind the payment to this checkout by its own order id (checked below), so the
  // customer's payment list (which lags a fresh payment and has no customer filter on Toss) is not asked.
  const listed = bound ? [] : await provider.listPayments({ customerRef: snapshot.customerRef, since: new Date(snapshot.capturedAt) });
  const trialInvoice = snapshot.provider === 'stripe' && snapshot.plan.trialDays > 0
    && subscriptionEvidence?.live.status === 'trialing' && live.amount.amountMinor === 0;
  if (!matchesCheckoutPayment(snapshot, live.raw, input.paymentRef) || live.providerRef !== input.paymentRef || live.provider !== snapshot.provider || live.status !== 'succeeded'
    || (!matchesCapturedSaleAmount(snapshot, live) && !trialInvoice)
    || (!bound && !listed.some((payment) => payment.providerRef === input.paymentRef))
    || (live.customerId !== '' && live.customerId !== snapshot.customerId && live.customerId !== snapshot.customerRef)) {
    throw new PaymentKitError('provider payment does not match captured sale', 'checkout_evidence_mismatch');
  }
  const paymentId = `payment:${snapshot.provider}:${input.paymentRef}`;
  let subscriptionId: string | null = null;
  let period = live.period;
  if (snapshot.plan.interval !== null) {
    if (!subscriptionEvidence) throw new PaymentKitError('subscription payment correlation missing', 'checkout_evidence_missing');
    subscriptionId = `subscription:${snapshot.provider}:${subscriptionEvidence.ref}`;
    period = live.period ?? subscriptionEvidence.live.currentPeriod;
    const existing = await input.repo.subscriptions.get(subscriptionId);
    // EC:A28 — the subscription is charged in the currency it was bought in.
    if (!existing) await input.repo.subscriptions.put({ ...subscriptionEvidence.live, id: subscriptionId, customerId: snapshot.customerId, planId: snapshot.plan.id, provider: snapshot.provider, providerRef: subscriptionEvidence.ref, currency: snapshot.price.currency, affiliateId: snapshot.affiliateId });
  }
  const purchase: PurchaseSnapshot = { ...snapshot, paymentId, paymentRef: input.paymentRef,
    purchasedAt: live.occurredAt.toISOString(), subscriptionId, period: period ? { start: period.start.toISOString(), end: period.end.toISOString() } : null };
  const { result: recorded } = await runIdempotent({ repo: input.repo, clock: input.clock,
    key: `purchase-entitlement:${paymentId}`, kind: 'purchase.entitlement', payload: { checkoutId: input.checkoutId, paymentRef: input.paymentRef },
    serialize: (value) => value, deserialize: parsePurchaseSnapshot, fn: async () => purchase });
  const existing = await input.repo.payments.get(paymentId);
  if (existing) {
    const linked: Payment = { ...existing, customerId: recorded.customerId, subscriptionId: recorded.subscriptionId,
      kind: recorded.plan.interval === null ? 'topup' : 'subscription', period, affiliateId: recorded.affiliateId };
    await input.repo.payments.put(linked);
    return linked;
  }
  const payment: Payment = { ...live, id: paymentId, customerId: recorded.customerId, subscriptionId: recorded.subscriptionId,
    kind: recorded.plan.interval === null ? 'topup' : 'subscription', period, cashReceipt: live.cashReceipt ?? null,
    affiliateId: recorded.affiliateId };
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
