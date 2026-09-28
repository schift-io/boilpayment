// boilpayment — Google Play in-app purchase provider. spec: ../../spec/google-play.pseudo.md
// Mirrors packages/providers/google-play/py/src/boilpayment_google_play/__init__.py.
//
// The app posts purchaseToken + productId; verifyPurchase reads the purchase from androidpublisher v3
// (subscriptionsv2.get / products.get). Real-time developer notifications arrive as Pub/Sub pushes.
// Payment refs: subscription `s|<purchaseToken>|<orderId>`, one-time `p|<productId>|<purchaseToken>`.
import type {
  Checkout, Logger, NormalizedEvent, NormalizedEventType, Payment, PaymentProvider, PaymentStatus, ProviderCapabilities, Refund,
  StoreProof, StorePurchaseProvider, Subscription, SubscriptionStatus, VerifiedStorePurchase,
} from 'boilpayment-core';
import { NoopLogger, PaymentKitError, ProviderError, WebhookSignatureError, daysInMonth, minorUnitsFromDecimal } from 'boilpayment-core';
import { PushAuthError, ServiceAccountTokens, verifyPushToken } from './auth.js';
import type { PubsubAuthConfig, ServiceAccount } from './auth.js';

export { verifyPushToken, ServiceAccountTokens, PushAuthError, GOOGLE_JWKS_URL, GOOGLE_ISSUERS } from './auth.js';
export type { PubsubAuthConfig, ServiceAccount } from './auth.js';

export interface GooglePlayProviderConfig {
  packageName: string;
  serviceAccount: ServiceAccount;
  pubsub: PubsubAuthConfig;
  /** EC:N9 — subscription productId → billing interval. Play does not report a period start, so the
   * kit uses expiryTime minus this interval (deterministic: verify and notifications agree). */
  productIntervals: Record<string, 'month' | 'year'>;
  apiBaseUrl?: string;
  logger?: Logger;
  now?: () => Date;
}

export interface SubscriptionPurchaseV2 {
  subscriptionState?: string;
  startTime?: string;
  linkedPurchaseToken?: string;
  acknowledgementState?: string;
  latestOrderId?: string;
  testPurchase?: Record<string, unknown>;
  externalAccountIdentifiers?: { obfuscatedExternalAccountId?: string };
  lineItems?: { productId: string; expiryTime?: string; latestSuccessfulOrderId?: string; autoRenewingPlan?: { autoRenewEnabled?: boolean; recurringPrice?: { currencyCode?: string; units?: string; nanos?: number } } }[];
}
export interface ProductPurchase {
  purchaseState?: number;
  purchaseTimeMillis?: string;
  acknowledgementState?: number;
  orderId?: string;
  purchaseType?: number;
  obfuscatedExternalAccountId?: string;
}

const API = 'https://androidpublisher.googleapis.com';
const unsupported = (what: string) => new PaymentKitError(`${what} is not supported for Google Play in-app purchases`, 'unsupported');

export function parsePaymentRef(ref: string): { kind: 'sub'; token: string; order: string } | { kind: 'product'; productId: string; token: string } {
  const [k, a, b] = ref.split('|');
  if (k === 's' && a && b) return { kind: 'sub', token: a, order: b };
  if (k === 'p' && a && b) return { kind: 'product', productId: a, token: b };
  throw new PaymentKitError(`not a Google Play payment ref: ${ref}`, 'iap_proof_invalid');
}

/** Expiry minus one interval, clamping the day like core `nextPeriod` does (EC:G1). */
export function periodStartFromExpiry(end: Date, interval: 'month' | 'year'): Date {
  const y = end.getUTCFullYear() - (interval === 'year' ? 1 : 0);
  const m = interval === 'month' ? end.getUTCMonth() - 1 : end.getUTCMonth();
  const ty = m < 0 ? y - 1 : y;
  const tm = (m + 12) % 12;
  const d = Math.min(end.getUTCDate(), daysInMonth(ty, tm + 1));
  return new Date(Date.UTC(ty, tm, d, end.getUTCHours(), end.getUTCMinutes(), end.getUTCSeconds(), end.getUTCMilliseconds()));
}

const SUB_PAY: Record<string, PaymentStatus> = {
  SUBSCRIPTION_STATE_ACTIVE: 'succeeded', SUBSCRIPTION_STATE_CANCELED: 'succeeded', SUBSCRIPTION_STATE_IN_GRACE_PERIOD: 'succeeded',
  SUBSCRIPTION_STATE_EXPIRED: 'succeeded', SUBSCRIPTION_STATE_PENDING: 'pending', SUBSCRIPTION_STATE_ON_HOLD: 'failed',
  SUBSCRIPTION_STATE_PAUSED: 'failed', SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED: 'failed',
};
// EC:N15 — PAUSED has no own status in the kit; it is past_due (no access, no grant) until resumed.
const SUB_STATE: Record<string, SubscriptionStatus> = {
  SUBSCRIPTION_STATE_ACTIVE: 'active', SUBSCRIPTION_STATE_CANCELED: 'active', SUBSCRIPTION_STATE_IN_GRACE_PERIOD: 'past_due',
  SUBSCRIPTION_STATE_ON_HOLD: 'past_due', SUBSCRIPTION_STATE_PAUSED: 'past_due', SUBSCRIPTION_STATE_EXPIRED: 'expired',
  SUBSCRIPTION_STATE_PENDING: 'trialing', SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED: 'canceled',
};

// RTDN subscriptionNotification.notificationType (https://developer.android.com/google/play/billing/rtdn-reference)
const RTDN: Record<number, NormalizedEventType> = {
  1: 'payment.succeeded', 2: 'payment.succeeded', 3: 'subscription.updated', 4: 'payment.succeeded', 5: 'subscription.payment_failed',
  6: 'subscription.payment_failed', 7: 'subscription.updated', 9: 'subscription.updated', 10: 'subscription.updated',
  11: 'subscription.updated', 12: 'refund.created', 13: 'subscription.canceled',
};

export class GooglePlayProvider implements PaymentProvider, StorePurchaseProvider {
  readonly name = 'google_play' as const;
  private readonly logger: Logger;
  private readonly tokens: ServiceAccountTokens;
  constructor(private readonly config: GooglePlayProviderConfig) {
    this.logger = config.logger ?? new NoopLogger();
    this.tokens = new ServiceAccountTokens(config.serviceAccount);
  }

  capabilities(): ProviderCapabilities {
    return { nativeSubscriptions: true, partialRefund: false, meters: false, scheduling: 'provider', webhookSignature: true, checkout: 'on_device', upgradeGrant: 'sync' };
  }

  private now(): Date { return this.config.now?.() ?? new Date(); }
  private base(): string { return `${this.config.apiBaseUrl ?? API}/androidpublisher/v3/applications/${encodeURIComponent(this.config.packageName)}`; }

  private async call<T>(method: 'GET' | 'POST', path: string): Promise<T | null> {
    const started = Date.now();
    const res = await fetch(`${this.base()}${path}`, { method, headers: { authorization: `Bearer ${await this.tokens.token()}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) }, body: method === 'POST' ? '{}' : undefined });
    const text = await res.text();
    await this.logger.log({ level: res.ok || res.status === 404 ? 'info' : 'warn', event: 'provider.request', provider: 'google_play', method, path, status: res.status, durationMs: Date.now() - started, providerErrorCode: res.ok ? null : String(res.status) });
    if (res.status === 404 || res.status === 410) return null;
    if (!res.ok) throw new ProviderError(`google_play ${method} ${path} failed: ${res.status}`, { code: 'provider_unavailable', providerCode: String(res.status), retryable: res.status >= 500 || res.status === 429, userMessage: 'Google Play 확인 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' }, { status: res.status });
    return (text ? JSON.parse(text) : {}) as T;
  }

  private subscriptionV2(token: string) { return this.call<SubscriptionPurchaseV2>('GET', `/purchases/subscriptionsv2/tokens/${encodeURIComponent(token)}`); }
  private product(productId: string, token: string) { return this.call<ProductPurchase>('GET', `/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}`); }

  /** Subscription purchase → Payment for its latest order. */
  subscriptionPayment(token: string, s: SubscriptionPurchaseV2, productId?: string): { payment: Payment; amountFromStore: boolean; item: NonNullable<SubscriptionPurchaseV2['lineItems']>[number] } {
    const item = s.lineItems?.find((i) => !productId || i.productId === productId);
    if (!item) throw new PaymentKitError('subscription line item not found', 'iap_purchase_not_found');
    const interval = this.config.productIntervals[item.productId];
    if (!interval) throw new PaymentKitError(`no interval configured for subscription product ${item.productId}`, 'iap_unknown_product');
    const end = new Date(item.expiryTime ?? s.startTime ?? this.now());
    const order = item.latestSuccessfulOrderId ?? s.latestOrderId ?? `exp:${end.toISOString()}`;
    const price = item.autoRenewingPlan?.recurringPrice;
    const currency = (price?.currencyCode ?? 'USD').toUpperCase();
    const amountFromStore = !!price?.currencyCode;
    const payment: Payment = {
      id: `s|${token}|${order}`, customerId: s.externalAccountIdentifiers?.obfuscatedExternalAccountId ?? '', provider: 'google_play',
      providerRef: `s|${token}|${order}`, subscriptionId: token,
      amount: { amountMinor: amountFromStore ? minorUnitsFromDecimal(Number(price?.units ?? 0), price?.nanos ?? 0, currency) : 0, currency },
      status: SUB_PAY[s.subscriptionState ?? ''] ?? 'pending', kind: 'subscription',
      period: { start: periodStartFromExpiry(end, interval), end }, occurredAt: periodStartFromExpiry(end, interval), failure: null, cashReceipt: null, raw: s,
    };
    return { payment, amountFromStore, item };
  }

  toSubscription(token: string, s: SubscriptionPurchaseV2): Subscription {
    const { payment, item } = this.subscriptionPayment(token, s);
    const start = new Date(s.startTime ?? payment.period!.start);
    return {
      id: token, customerId: payment.customerId, planId: '', provider: 'google_play', providerRef: token,
      status: SUB_STATE[s.subscriptionState ?? ''] ?? 'expired', currentPeriod: payment.period!, anchorDay: start.getUTCDate(),
      cancelAtPeriodEnd: s.subscriptionState === 'SUBSCRIPTION_STATE_CANCELED' || item.autoRenewingPlan?.autoRenewEnabled === false,
      graceUntil: null, billingKey: null, scheduledPlanId: null, version: 0, createdAt: start,
    };
  }

  private productPayment(productId: string, token: string, p: ProductPurchase): Payment {
    const at = new Date(Number(p.purchaseTimeMillis ?? this.now().getTime()));
    return {
      id: `p|${productId}|${token}`, customerId: p.obfuscatedExternalAccountId ?? '', provider: 'google_play', providerRef: `p|${productId}|${token}`,
      subscriptionId: null, amount: { amountMinor: 0, currency: '' }, // EC:N11 — products.get reports no price
      status: p.purchaseState === 0 ? 'succeeded' : p.purchaseState === 2 ? 'pending' : 'failed', kind: 'topup',
      period: null, occurredAt: at, failure: null, cashReceipt: null, raw: p,
    };
  }

  async verifyPurchase(proof: StoreProof): Promise<VerifiedStorePurchase> {
    const token = proof.purchaseToken;
    if (!token) throw new PaymentKitError('Google Play proof needs purchaseToken', 'iap_proof_invalid');
    if (proof.subscription !== false) {
      const s = await this.subscriptionV2(token);
      if (s) {
        const { payment, amountFromStore, item } = this.subscriptionPayment(token, s, proof.productId);
        return { payment, amountFromStore, productId: item.productId, subscriptionRef: token, subscription: this.toSubscription(token, s),
          accountToken: s.externalAccountIdentifiers?.obfuscatedExternalAccountId ?? null, environment: s.testPurchase ? 'sandbox' : 'production',
          ownership: 'purchased', acknowledged: s.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED', replacesSubscriptionRef: s.linkedPurchaseToken ?? null };
      }
      if (proof.subscription === true) throw new PaymentKitError('purchase token not found for this app', 'iap_purchase_not_found');
    }
    if (!proof.productId) throw new PaymentKitError('Google Play one-time proof needs productId', 'iap_proof_invalid');
    const p = await this.product(proof.productId, token);
    if (!p) throw new PaymentKitError('purchase token not found for this app', 'iap_purchase_not_found');
    return { payment: this.productPayment(proof.productId, token, p), amountFromStore: false, productId: proof.productId, subscriptionRef: null, subscription: null,
      accountToken: p.obfuscatedExternalAccountId ?? null, environment: p.purchaseType === 0 ? 'sandbox' : 'production', ownership: 'purchased', acknowledged: p.acknowledgementState === 1 };
  }

  /** EC:N1 — acknowledge within 3 days or Google refunds. Idempotent: an acknowledged purchase is left alone. */
  async acknowledge(paymentRef: string): Promise<{ acknowledged: boolean }> {
    const ref = parsePaymentRef(paymentRef);
    if (ref.kind === 'product') {
      const p = await this.product(ref.productId, ref.token);
      if (!p) throw new PaymentKitError('purchase token not found for this app', 'iap_purchase_not_found');
      if (p.acknowledgementState !== 1) await this.call('POST', `/purchases/products/${encodeURIComponent(ref.productId)}/tokens/${encodeURIComponent(ref.token)}:acknowledge`);
      return { acknowledged: true };
    }
    const s = await this.subscriptionV2(ref.token);
    if (!s) throw new PaymentKitError('purchase token not found for this app', 'iap_purchase_not_found');
    if (s.acknowledgementState !== 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED') {
      const productId = s.lineItems?.[0]?.productId ?? '';
      await this.call('POST', `/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(ref.token)}:acknowledge`);
    }
    return { acknowledged: true };
  }

  async getPayment(providerRef: string): Promise<Payment> {
    const ref = parsePaymentRef(providerRef);
    if (ref.kind === 'product') {
      const p = await this.product(ref.productId, ref.token);
      if (!p) throw new PaymentKitError('purchase token not found for this app', 'iap_purchase_not_found');
      return this.productPayment(ref.productId, ref.token, p);
    }
    const s = await this.subscriptionV2(ref.token);
    if (!s) throw new PaymentKitError('purchase token not found for this app', 'iap_purchase_not_found');
    return this.subscriptionPayment(ref.token, s).payment;
  }

  /** Play has no per-customer order list; support flows match on the account id instead. */
  async listPayments(): Promise<Payment[]> { return []; }

  async getSubscription(providerRef: string): Promise<Subscription> {
    const s = await this.subscriptionV2(providerRef);
    if (!s) throw new PaymentKitError('purchase token not found for this app', 'iap_purchase_not_found');
    return this.toSubscription(providerRef, s);
  }

  /** Developer cancel = auto-renew off; access continues to the end of the period. */
  async cancelSubscription(providerRef: string, input: { atPeriodEnd: boolean }): Promise<Subscription> {
    if (!input.atPeriodEnd) throw unsupported('immediate cancellation (Play cancels at period end; revoke is a refund)');
    const s = await this.subscriptionV2(providerRef);
    if (!s) throw new PaymentKitError('purchase token not found for this app', 'iap_purchase_not_found');
    await this.call('POST', `/purchases/subscriptions/${encodeURIComponent(s.lineItems?.[0]?.productId ?? '')}/tokens/${encodeURIComponent(providerRef)}:cancel`);
    return this.getSubscription(providerRef);
  }

  /** EC:N1 N6 N13 — Pub/Sub push: verify the OIDC token, check the package, map the notification. */
  async verifyWebhook(input: { headers: Record<string, string>; rawBody: string; receivedAt?: Date }): Promise<NormalizedEvent> {
    const auth = input.headers.authorization ?? input.headers.Authorization;
    // EC:E17 — the push token's exp is judged at receipt when process() re-verifies later.
    try { await verifyPushToken(auth, this.config.pubsub, input.receivedAt ?? this.now()); } catch (err) {
      throw new WebhookSignatureError(err instanceof PushAuthError ? err.message : 'push token verification failed');
    }
    type Push = { message?: { data?: string; messageId?: string; message_id?: string; publishTime?: string } };
    type Dev = { packageName?: string; eventTimeMillis?: string; subscriptionNotification?: { notificationType: number; purchaseToken: string; subscriptionId?: string };
      oneTimeProductNotification?: { notificationType: number; purchaseToken: string; sku: string }; voidedPurchaseNotification?: { purchaseToken: string; orderId: string; productType: number; refundType: number }; testNotification?: unknown };
    let push: Push; let dev: Dev;
    try {
      push = JSON.parse(input.rawBody) as Push;
      dev = JSON.parse(Buffer.from(push.message?.data ?? '', 'base64').toString('utf8')) as Dev;
    } catch { throw new WebhookSignatureError('push body is not a Pub/Sub message'); }
    if (dev.packageName !== this.config.packageName) throw new WebhookSignatureError('notification for another package');
    const id = push.message?.messageId ?? push.message?.message_id;
    if (!id) throw new WebhookSignatureError('push message has no id');
    const occurredAt = new Date(Number(dev.eventTimeMillis ?? Date.now()));
    const base = { id, provider: 'google_play' as const, occurredAt, customerRef: null, subscriptionRef: null, paymentRef: null, amount: null, refundRef: null };
    if (dev.subscriptionNotification) {
      const n = dev.subscriptionNotification;
      const type = RTDN[n.notificationType] ?? 'unknown';
      if (type === 'unknown') await this.logger.log({ level: 'info', event: 'webhook.unmapped', provider: 'google_play', providerErrorCode: `subscription:${n.notificationType}` });
      let payment: Payment | null = null;
      if (type === 'payment.succeeded' || type === 'refund.created') {
        const s = await this.subscriptionV2(n.purchaseToken);
        if (s) payment = this.subscriptionPayment(n.purchaseToken, s).payment;
      }
      return { ...base, type, subscriptionRef: n.purchaseToken, customerRef: payment?.customerId || null, paymentRef: payment?.providerRef ?? null,
        amount: payment && payment.amount.currency ? payment.amount : null, refundRef: type === 'refund.created' && payment ? `gp-revoke:${payment.providerRef}` : null,
        raw: { subscriptionNotification: n } };
    }
    if (dev.oneTimeProductNotification) {
      const n = dev.oneTimeProductNotification;
      const type: NormalizedEventType = n.notificationType === 1 ? 'payment.succeeded' : n.notificationType === 2 ? 'payment.failed' : 'unknown';
      return { ...base, type, paymentRef: `p|${n.sku}|${n.purchaseToken}`, raw: { oneTimeProductNotification: n } };
    }
    if (dev.voidedPurchaseNotification) {
      const v = dev.voidedPurchaseNotification;
      // EC:N6 — voided notifications carry no amount (and no productId for one-time products); the
      // webhook resolves both from the local payment (packages/webhook refund.ts).
      const paymentRef = v.productType === 1 ? `s|${v.purchaseToken}|${v.orderId}` : `p|?|${v.purchaseToken}`;
      return { ...base, type: 'refund.created', paymentRef, refundRef: `gp-void:${v.orderId}`, subscriptionRef: v.productType === 1 ? v.purchaseToken : null, raw: { voidedPurchaseNotification: v } };
    }
    return { ...base, type: 'unknown', raw: { testNotification: dev.testNotification ?? null } };
  }

  async createCustomer(): Promise<{ ref: string }> { throw unsupported('createCustomer (use storeAccountToken(customerId))'); }
  async createCheckout(): Promise<Checkout> { throw unsupported('createCheckout'); }
  async changeSubscription(): Promise<Subscription> { throw unsupported('changeSubscription'); }
  async uncancelSubscription(): Promise<Subscription> { throw unsupported('uncancelSubscription'); }
  async chargeBillingKey(): Promise<Payment> { throw unsupported('chargeBillingKey'); }
  async refund(): Promise<Refund> { throw unsupported('refund (v1 records store refunds; server-side refund API unconfirmed)'); }
  async reportUsage(): Promise<void> { throw unsupported('reportUsage'); }
}
