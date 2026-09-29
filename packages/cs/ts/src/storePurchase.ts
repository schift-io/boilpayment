// spec: packages/cs/spec/cs.pseudo.md [EC:N1] — in-app purchases (Apple App Store, Google Play).
// Sibling of registerCompletedCheckout for purchases that happen on the device: the store's proof is
// verified by the store provider, immutable sale facts are pinned, the payment is recorded once, the
// original grant primitive runs, and Google purchases are acknowledged only after the grant.
import { DEFAULT_IAP_SETTINGS, PaymentKitError, isStorePurchaseProvider, runIdempotent, storeAccountToken } from 'boilpayment-core';
import type { IapSettings, Payment, PlanPrice, StoreProof, StoreProviderName, Subscription } from 'boilpayment-core';
import type { SupportDeps } from './support.js';
import type { SupportGrantOutcome, SupportGrants } from './recoverMissingGrant.js';
import { applyPurchasedGrant } from './applyPurchasedGrant.js';
import { parsePurchaseSnapshot } from './purchaseSnapshot.js';
import type { PurchaseSnapshot } from './purchaseSnapshot.js';

export interface RegisterStorePurchaseInput extends SupportDeps {
  readonly customerId: string;
  readonly provider: StoreProviderName;
  readonly proof: StoreProof;
  readonly iap?: Partial<IapSettings>;
  readonly grants: SupportGrants;
}
export interface StorePurchaseResult {
  readonly payment: Payment;
  /** EC:N2 — the same proof was already recorded; nothing new was granted. */
  readonly replayed: boolean;
  readonly grant: SupportGrantOutcome;
  /** EC:N1 — false when a Google acknowledgement failed; `reackStorePurchases` retries it. */
  readonly acknowledged: boolean;
}

const refuse = (code: string, message: string, details?: unknown) => new PaymentKitError(message, code, details);

export async function registerStorePurchase(input: RegisterStorePurchaseInput): Promise<StorePurchaseResult> {
  const { repo, clock, customerId } = input;
  const provider = input.providers[input.provider];
  if (!isStorePurchaseProvider(provider)) throw refuse('iap_provider_missing', `${input.provider} is not configured as an in-app purchase store`);
  const iap: IapSettings = { ...DEFAULT_IAP_SETTINGS, ...input.iap };
  const v = await provider.verifyPurchase(input.proof);
  if (v.environment === 'sandbox' && iap.environments === 'production_only') throw refuse('iap_wrong_environment', 'sandbox purchases are not accepted'); // EC:N3
  if (v.ownership === 'family_shared' && iap.familySharing === 'ignore') throw refuse('iap_family_shared_refused', 'family-shared purchases are not granted'); // EC:N5
  const expectedToken = storeAccountToken(customerId);
  if (v.accountToken !== null ? v.accountToken !== expectedToken : iap.accountLink === 'require') { // EC:N4
    throw refuse('iap_account_mismatch', v.accountToken === null ? 'purchase carries no account token' : 'purchase belongs to another account');
  }
  if (v.payment.status !== 'succeeded') throw refuse('iap_payment_not_succeeded', `store purchase is ${v.payment.status}`, { status: v.payment.status }); // EC:A25
  const paymentRef = v.payment.providerRef;
  const paymentId = `payment:${input.provider}:${paymentRef}`;
  const already = await repo.payments.get(paymentId);
  if (already && already.customerId !== customerId) throw refuse('iap_already_claimed', 'this purchase is recorded for another customer'); // EC:N2 N4

  const plans = await repo.plans.list();
  const plan = plans.find((p) => p.prices.some((price) => price.providerPriceRefs?.[input.provider] === v.productId));
  if (!plan) throw refuse('iap_unknown_product', `no plan maps ${input.provider} product ${v.productId}`, { productId: v.productId });
  if ((plan.interval === null) !== (v.subscriptionRef === null)) throw refuse('iap_product_mismatch', 'store product type does not match the plan interval');
  const catalog = plan.prices.find((price) => price.providerPriceRefs?.[input.provider] === v.productId) as PlanPrice;
  // EC:N11 — the store's charged amount is the payment's money; the plan decides the grant. When the
  // store reports no price (Google one-time products), the catalog price stands in.
  const price: PlanPrice = v.amountFromStore
    ? { currency: v.payment.amount.currency, amountMinor: v.payment.amount.amountMinor, providerPriceRefs: { [input.provider]: v.productId } }
    : { currency: catalog.currency, amountMinor: catalog.amountMinor, providerPriceRefs: { [input.provider]: v.productId } };
  const period = v.payment.period;
  if (v.subscriptionRef && (!period || period.end <= clock.now())) throw refuse('iap_purchase_expired', 'store subscription period has already ended');

  const customer = await repo.customers.get(customerId);
  if (!customer) throw refuse('customer_not_found', 'customer must exist before registering a store purchase');
  const customerRef = v.accountToken ?? customerId;
  if (!customer.providerRefs.some((r) => r.provider === input.provider && r.ref === customerRef)) {
    await repo.customers.put({ ...customer, providerRefs: [...customer.providerRefs, { provider: input.provider, ref: customerRef }] });
  }

  let subscriptionId: string | null = null;
  if (v.subscriptionRef && v.subscription) {
    subscriptionId = `subscription:${input.provider}:${v.subscriptionRef}`;
    const existing = await repo.subscriptions.get(subscriptionId);
    if (existing && existing.customerId !== customerId) throw refuse('iap_already_claimed', 'this subscription is recorded for another customer');
    if (!existing) {
      const sub: Subscription = { ...v.subscription, id: subscriptionId, customerId, planId: plan.id, provider: input.provider, providerRef: v.subscriptionRef, version: 0, currency: catalog.currency }; // EC:A28
      await repo.subscriptions.put(sub);
    }
    if (v.replacesSubscriptionRef) { // EC:N9 — one purchase is never held twice
      for (const old of await repo.subscriptions.list({ provider: input.provider, providerRef: v.replacesSubscriptionRef } as Partial<Subscription>)) {
        if (old.status !== 'canceled' && old.status !== 'expired') await repo.subscriptions.put({ ...old, status: 'canceled' });
      }
    }
  }

  const snapshot: PurchaseSnapshot = {
    intentKey: `store:${input.provider}:${paymentRef}`, checkoutId: null, checkoutProviderRef: null, customerId, customerRef,
    provider: input.provider, plan, price, policy: input.policy, capturedAt: clock.now().toISOString(),
    allowDiscountCodes: false, presetDiscountCode: null, affiliateId: null, paymentId, paymentRef,
    purchasedAt: v.payment.occurredAt.toISOString(), subscriptionId,
    period: period ? { start: period.start.toISOString(), end: period.end.toISOString() } : null,
  };
  await runIdempotent({ repo, clock, key: `purchase-entitlement:${paymentId}`, kind: 'purchase.entitlement',
    payload: { provider: input.provider, paymentRef }, serialize: (value) => value, deserialize: parsePurchaseSnapshot, fn: async () => snapshot });
  const payment = already ?? await repo.payments.put({ ...v.payment, id: paymentId, customerId, subscriptionId,
    amount: { amountMinor: price.amountMinor, currency: price.currency }, kind: plan.interval === null ? 'topup' : 'subscription', cashReceipt: null, raw: undefined });
  const grant = await applyPurchasedGrant({ ...input, customerId, paymentId, grants: input.grants });
  const acknowledged = v.acknowledged || await acknowledgeStorePayment({ ...input, payment });
  return { payment, replayed: already !== null, grant, acknowledged };
}

/** EC:N1 — acknowledge once the grant is committed; a failure is left for the reconcile cron. */
async function acknowledgeStorePayment(input: Pick<SupportDeps, 'providers' | 'repo' | 'clock'> & { payment: Payment }): Promise<boolean> {
  const provider = input.providers[input.payment.provider];
  if (!isStorePurchaseProvider(provider) || !provider.acknowledge) return true;
  try {
    await runIdempotent({ repo: input.repo, clock: input.clock, key: `iap-ack:${input.payment.id}`, kind: 'iap.acknowledge',
      payload: { paymentRef: input.payment.providerRef }, fn: async () => provider.acknowledge!(input.payment.providerRef) });
    return true;
  } catch {
    return false;
  }
}

/** EC:N1 — re-acknowledge store purchases granted in the last `withinDays` (default 3, Google's window). */
export async function reackStorePurchases(input: Pick<SupportDeps, 'providers' | 'repo' | 'clock'> & { withinDays?: number }): Promise<{ acknowledged: number; failed: string[] }> {
  const since = input.clock.now().getTime() - (input.withinDays ?? 3) * 86_400_000;
  let acknowledged = 0;
  const failed: string[] = [];
  for (const name of Object.keys(input.providers) as StoreProviderName[]) {
    const provider = input.providers[name];
    if (!isStorePurchaseProvider(provider) || !provider.acknowledge) continue;
    for (const payment of await input.repo.payments.list({ provider: name } as Partial<Payment>)) {
      if (payment.status !== 'succeeded' || payment.occurredAt.getTime() < since) continue;
      const done = await input.repo.operations.get(`iap-ack:${payment.id}`);
      if (done?.status === 'done') continue;
      if (await acknowledgeStorePayment({ ...input, payment })) acknowledged += 1; else failed.push(payment.id);
    }
  }
  return { acknowledged, failed };
}
