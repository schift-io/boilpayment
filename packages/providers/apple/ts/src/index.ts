// boilpayment — Apple App Store in-app purchase provider. spec: ../../spec/apple.pseudo.md
// Mirrors packages/providers/apple/py/src/boilpayment_apple/__init__.py.
//
// The purchase happens on the device (StoreKit 2). The app posts `Transaction.jwsRepresentation`;
// verifyPurchase checks the signature chain, bundle id and environment, then re-fetches the
// transaction from the App Store Server API (EC:E3). Notifications V2 arrive at verifyWebhook.
import type {
  Checkout, Logger, NormalizedEvent, Payment, PaymentProvider, ProviderCapabilities, Refund,
  StoreEnvironment, StoreProof, StorePurchaseProvider, Subscription, SubscriptionStatus, VerifiedStorePurchase,
} from 'boilpayment-core';
import { NoopLogger, PaymentKitError, ProviderError, WebhookSignatureError, minorUnitsFromMilliunits } from 'boilpayment-core';
import { appStoreApiToken, verifyAppleJws } from './jws.js';
import { mapNotificationType } from './notifications.js';

export { verifyAppleJws, appStoreApiToken, APPLE_LEAF_OID, APPLE_WWDR_OID } from './jws.js';
export { mapNotificationType } from './notifications.js';

export interface AppleProviderConfig {
  bundleId: string;
  /** Required to accept Production notifications (checked against data.appAppleId). */
  appAppleId?: number | null;
  /** Trusted roots as PEM. Production: Apple Root CA - G3 (https://www.apple.com/certificateauthority/). */
  rootCertificates: string[];
  /** App Store Server API key (App Store Connect > Users and Access > Integrations). */
  issuerId: string;
  keyId: string;
  privateKey: string;
  /** Overrides the API hosts, e.g. the local mock. */
  apiBaseUrl?: { production?: string; sandbox?: string };
  logger?: Logger;
  now?: () => Date;
}

export const APPLE_API_HOSTS = { production: 'https://api.storekit.apple.com', sandbox: 'https://api.storekit-sandbox.apple.com' } as const;

/** Decoded JWSTransaction fields this kit reads. */
export interface AppleTransaction {
  transactionId: string;
  originalTransactionId: string;
  bundleId: string;
  productId: string;
  type: string;
  purchaseDate: number;
  originalPurchaseDate?: number;
  expiresDate?: number;
  appAccountToken?: string;
  inAppOwnershipType?: 'PURCHASED' | 'FAMILY_SHARED';
  environment: 'Sandbox' | 'Production' | string;
  revocationDate?: number;
  price?: number;
  currency?: string;
}

const unsupported = (what: string) => new PaymentKitError(`${what} is not supported for Apple in-app purchases (on-device store)`, 'unsupported');
const isSubscription = (t: AppleTransaction) => t.type === 'Auto-Renewable Subscription';
const envOf = (t: { environment?: string }): StoreEnvironment => (t.environment === 'Production' ? 'production' : 'sandbox');

/** EC:N11 — JWSTransaction → Payment. Apple reports price in milliunits; absent price → amount 0, amountFromStore false. */
export function transactionToPayment(t: AppleTransaction): { payment: Payment; amountFromStore: boolean } {
  const currency = (t.currency ?? 'USD').toUpperCase();
  const amountFromStore = typeof t.price === 'number';
  const sub = isSubscription(t);
  const payment: Payment = {
    id: t.transactionId, customerId: t.appAccountToken ?? '', provider: 'apple', providerRef: t.transactionId,
    subscriptionId: sub ? t.originalTransactionId : null,
    amount: { amountMinor: amountFromStore ? minorUnitsFromMilliunits(t.price as number, currency) : 0, currency },
    status: t.revocationDate ? 'refunded' : 'succeeded',
    kind: sub ? 'subscription' : 'topup',
    period: sub && t.expiresDate ? { start: new Date(t.purchaseDate), end: new Date(t.expiresDate) } : null,
    occurredAt: new Date(t.purchaseDate), failure: null, cashReceipt: null, raw: t,
  };
  return { payment, amountFromStore };
}

const STATUS: Record<number, SubscriptionStatus> = { 1: 'active', 2: 'expired', 3: 'past_due', 4: 'past_due', 5: 'canceled' };

export function transactionToSubscription(t: AppleTransaction, input: { status?: number; autoRenew?: boolean | null; graceUntil?: Date | null; now: Date }): Subscription {
  const end = new Date(t.expiresDate ?? t.purchaseDate);
  const status: SubscriptionStatus = input.status !== undefined ? STATUS[input.status] ?? 'expired' : end > input.now ? 'active' : 'expired';
  return {
    id: t.originalTransactionId, customerId: t.appAccountToken ?? '', planId: '', provider: 'apple', providerRef: t.originalTransactionId,
    status, currentPeriod: { start: new Date(t.purchaseDate), end }, anchorDay: new Date(t.originalPurchaseDate ?? t.purchaseDate).getUTCDate(),
    cancelAtPeriodEnd: input.autoRenew === false, graceUntil: input.graceUntil ?? null, billingKey: null, scheduledPlanId: null,
    version: 0, createdAt: new Date(t.originalPurchaseDate ?? t.purchaseDate),
  };
}

export class AppleProvider implements PaymentProvider, StorePurchaseProvider {
  readonly name = 'apple' as const;
  private readonly logger: Logger;
  constructor(private readonly config: AppleProviderConfig) {
    this.logger = config.logger ?? new NoopLogger();
  }

  capabilities(): ProviderCapabilities {
    return { nativeSubscriptions: true, partialRefund: false, meters: false, scheduling: 'provider', webhookSignature: true, checkout: 'on_device' };
  }

  private now(): Date { return this.config.now?.() ?? new Date(); }
  private verify<T>(jws: string): T { return verifyAppleJws<T>(jws, { rootCertificates: this.config.rootCertificates, now: this.now() }); }

  /** EC:N3 — a proof for another app is refused before anything is recorded. */
  private transaction(jws: string): AppleTransaction {
    const t = this.verify<AppleTransaction>(jws);
    if (t.bundleId !== this.config.bundleId) throw new PaymentKitError('transaction belongs to another app', 'iap_wrong_app', { bundleId: t.bundleId });
    return t;
  }

  private async api<T>(env: StoreEnvironment, path: string): Promise<T | null> {
    const base = this.config.apiBaseUrl?.[env] ?? APPLE_API_HOSTS[env];
    const token = appStoreApiToken({ issuerId: this.config.issuerId, keyId: this.config.keyId, privateKey: this.config.privateKey, bundleId: this.config.bundleId, now: this.now() });
    const started = Date.now();
    const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
    const text = await res.text();
    await this.logger.log({ level: res.ok || res.status === 404 ? 'info' : 'warn', event: 'provider.request', provider: 'apple', method: 'GET', path, status: res.status, durationMs: Date.now() - started, providerErrorCode: res.ok ? null : String(res.status) });
    if (res.status === 404) return null;
    if (!res.ok) throw new ProviderError(`apple GET ${path} failed: ${res.status}`, { code: 'provider_unavailable', providerCode: String(res.status), retryable: res.status >= 500 || res.status === 429, userMessage: 'App Store 확인 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' }, { status: res.status });
    return JSON.parse(text) as T;
  }

  /** Get Transaction Info. Production first, then Sandbox (Apple's documented lookup order). */
  private async fetchTransaction(transactionId: string, env?: StoreEnvironment): Promise<AppleTransaction> {
    for (const e of env ? [env] : (['production', 'sandbox'] as const)) {
      const body = await this.api<{ signedTransactionInfo: string }>(e, `/inApps/v1/transactions/${encodeURIComponent(transactionId)}`);
      if (body) return this.transaction(body.signedTransactionInfo);
    }
    throw new PaymentKitError('transaction not found at the App Store', 'iap_purchase_not_found', { transactionId });
  }

  async verifyPurchase(proof: StoreProof): Promise<VerifiedStorePurchase> {
    if (!proof.signedTransaction) throw new PaymentKitError('Apple proof needs signedTransaction', 'iap_proof_invalid');
    const sent = this.transaction(proof.signedTransaction);
    const env = envOf(sent);
    const live = await this.fetchTransaction(sent.transactionId, env); // EC:E3 — the store's current view wins
    if (live.transactionId !== sent.transactionId || envOf(live) !== env) throw new PaymentKitError('store transaction does not match the proof', 'iap_proof_invalid');
    const { payment, amountFromStore } = transactionToPayment(live);
    return {
      payment, amountFromStore, productId: live.productId,
      subscriptionRef: isSubscription(live) ? live.originalTransactionId : null,
      subscription: isSubscription(live) ? transactionToSubscription(live, { now: this.now() }) : null,
      accountToken: live.appAccountToken ?? null, environment: env,
      ownership: live.inAppOwnershipType === 'FAMILY_SHARED' ? 'family_shared' : 'purchased', acknowledged: true,
    };
  }

  async getPayment(providerRef: string): Promise<Payment> {
    return transactionToPayment(await this.fetchTransaction(providerRef)).payment;
  }

  /** Apple has no per-customer payment list; support flows match on the account token instead. */
  async listPayments(): Promise<Payment[]> { return []; }

  /** Get All Subscription Statuses (ref = originalTransactionId). */
  async getSubscription(providerRef: string): Promise<Subscription> {
    type Item = { originalTransactionId: string; status: number; signedTransactionInfo: string; signedRenewalInfo?: string };
    for (const e of ['production', 'sandbox'] as const) {
      const body = await this.api<{ data: { lastTransactions: Item[] }[] }>(e, `/inApps/v1/subscriptions/${encodeURIComponent(providerRef)}`);
      const item = body?.data.flatMap((g) => g.lastTransactions).find((i) => i.originalTransactionId === providerRef);
      if (!item) continue;
      const t = this.transaction(item.signedTransactionInfo);
      const renewal = item.signedRenewalInfo ? this.verify<{ autoRenewStatus?: number; gracePeriodExpiresDate?: number }>(item.signedRenewalInfo) : null;
      return transactionToSubscription(t, { status: item.status, autoRenew: renewal ? renewal.autoRenewStatus === 1 : null,
        graceUntil: renewal?.gracePeriodExpiresDate ? new Date(renewal.gracePeriodExpiresDate) : null, now: this.now() });
    }
    throw new PaymentKitError('subscription not found at the App Store', 'iap_purchase_not_found', { originalTransactionId: providerRef });
  }

  /** EC:N1 N5 N6 N13 — App Store Server Notifications V2. The whole payload is a signed JWS. */
  async verifyWebhook(input: { headers: Record<string, string>; rawBody: string }): Promise<NormalizedEvent> {
    let signedPayload: unknown;
    try { signedPayload = (JSON.parse(input.rawBody) as { signedPayload?: unknown }).signedPayload; } catch { signedPayload = undefined; }
    if (typeof signedPayload !== 'string') throw new WebhookSignatureError('apple notification has no signedPayload');
    type Note = { notificationType: string; subtype?: string; notificationUUID: string; signedDate?: number; data?: { bundleId?: string; appAppleId?: number; environment?: string; signedTransactionInfo?: string } };
    let note: Note;
    try { note = this.verify<Note>(signedPayload); } catch (err) { throw new WebhookSignatureError(err instanceof Error ? err.message : 'invalid apple signature'); }
    const data = note.data ?? {};
    if (data.bundleId !== undefined && data.bundleId !== this.config.bundleId) throw new WebhookSignatureError('apple notification for another app');
    if (data.environment === 'Production' && (this.config.appAppleId == null || data.appAppleId !== this.config.appAppleId)) {
      throw new WebhookSignatureError('apple production notification with a missing or different appAppleId');
    }
    const { type, known } = mapNotificationType(note.notificationType);
    if (!known) await this.logger.log({ level: 'info', event: 'webhook.unmapped', provider: 'apple', providerErrorCode: note.notificationType });
    const t = data.signedTransactionInfo ? this.transaction(data.signedTransactionInfo) : null;
    const pay = t ? transactionToPayment(t) : null;
    const refund = type === 'refund.created';
    return {
      id: note.notificationUUID, provider: 'apple', type, occurredAt: new Date(note.signedDate ?? Date.now()),
      customerRef: t?.appAccountToken ?? null,
      subscriptionRef: t && isSubscription(t) ? t.originalTransactionId : null,
      paymentRef: t?.transactionId ?? null,
      amount: pay && pay.amountFromStore ? pay.payment.amount : null,
      refundRef: refund && t ? `apple-${note.notificationType.toLowerCase()}:${t.transactionId}` : null,
      raw: { notificationType: note.notificationType, subtype: note.subtype ?? null, transaction: t },
    };
  }

  async createCustomer(): Promise<{ ref: string }> { throw unsupported('createCustomer (use storeAccountToken(customerId))'); }
  async createCheckout(): Promise<Checkout> { throw unsupported('createCheckout'); }
  async changeSubscription(): Promise<Subscription> { throw unsupported('changeSubscription'); }
  async cancelSubscription(): Promise<Subscription> { throw unsupported('cancelSubscription'); }
  async uncancelSubscription(): Promise<Subscription> { throw unsupported('uncancelSubscription'); }
  async chargeBillingKey(): Promise<Payment> { throw unsupported('chargeBillingKey'); }
  async refund(): Promise<Refund> { throw unsupported('refund (Apple decides refunds; REFUND notifications are reconciled)'); }
  async reportUsage(): Promise<void> { throw unsupported('reportUsage'); }
}
