// EC:N1-N15 — in-app purchase stores (Apple App Store, Google Play). spec: packages/cs/spec/cs.pseudo.md [EC:N1]
// Mirrors packages/core/py/src/boilpayment_core/store.py.
//
// The purchase happens on the device. The app sends the store's proof to the server; a store provider
// verifies it with the store and returns the facts below. cs.registerStorePurchase records and grants.
import { createHash } from 'node:crypto';
import type { Payment, PaymentProvider, Subscription } from './types.js';
import { currencyExponent } from './money.js';

export type StoreProviderName = 'apple' | 'google_play';
export const STORE_PROVIDERS: readonly StoreProviderName[] = ['apple', 'google_play'];
export type StoreEnvironment = 'production' | 'sandbox';

/** What the app posts after an on-device purchase. Apple: StoreKit 2 `jwsRepresentation`.
 * Google: `purchaseToken` + `productId` (+ whether it is a subscription). */
export interface StoreProof {
  signedTransaction?: string;
  purchaseToken?: string;
  productId?: string;
  subscription?: boolean;
}

export interface VerifiedStorePurchase {
  /** customerId is '' (stores have no customer object); providerRef is the store payment ref. */
  payment: Payment;
  /** amount came from the store (false: the store did not report a price, see EC:N11). */
  amountFromStore: boolean;
  subscriptionRef: string | null;
  subscription: Subscription | null;
  productId: string;
  /** appAccountToken (Apple) / obfuscatedExternalAccountId (Google) the app set at purchase. */
  accountToken: string | null;
  environment: StoreEnvironment;
  ownership: 'purchased' | 'family_shared';
  /** Google acknowledgement state; Apple has no acknowledgement and reports true. */
  acknowledged: boolean;
  /** EC:N9 — Google `linkedPurchaseToken`: this purchase replaces that subscription (upgrade,
   * downgrade, re-subscribe); its local entitlement ends so one purchase is never held twice. */
  replacesSubscriptionRef?: string | null;
}

export interface StorePurchaseProvider {
  verifyPurchase(proof: StoreProof): Promise<VerifiedStorePurchase>;
  /** EC:N1 — Google only: acknowledge a granted purchase. No-op when already acknowledged. */
  acknowledge?(paymentRef: string): Promise<{ acknowledged: boolean }>;
}

export function isStorePurchaseProvider(provider: unknown): provider is PaymentProvider & StorePurchaseProvider {
  return typeof provider === 'object' && provider !== null && typeof (provider as Partial<StorePurchaseProvider>).verifyPurchase === 'function';
}

/** Settings stored under `iap` in paykit.config.json (outside `policy`). */
export interface IapSettings {
  /** EC:N3 — accept sandbox (TestFlight / review / license tester) purchases too. */
  environments: 'production_and_sandbox' | 'production_only';
  /** EC:N4 — the account token on the purchase must match the caller's customer. */
  accountLink: 'require' | 'allow_first_claim';
  /** EC:N5 — Apple Family Sharing: grant the family member, or refuse. */
  familySharing: 'grant' | 'ignore';
  /** EC:N12 — store commission per store, as a fraction (0.15 = 15%). No default: rates depend on
   * the developer's programme and are entered by the developer. Used only by reports. */
  storeFeeRate: Partial<Record<StoreProviderName, number>>;
}

export const DEFAULT_IAP_SETTINGS: IapSettings = {
  environments: 'production_and_sandbox',
  accountLink: 'require',
  familySharing: 'grant',
  storeFeeRate: {},
};

/** Fixed namespace for account tokens. Changing it would unlink every existing purchase. */
export const STORE_ACCOUNT_TOKEN_NAMESPACE = '91f7798e-f5e9-43a3-b1cf-d06287c59c87';

/** EC:N4 — the UUID the app passes as StoreKit `appAccountToken` / Play `obfuscatedAccountId`.
 * UUIDv5 (RFC 9562) of the customer id: deterministic, so nothing has to be stored. */
export function storeAccountToken(customerId: string): string {
  const ns = Buffer.from(STORE_ACCOUNT_TOKEN_NAMESPACE.replace(/-/g, ''), 'hex');
  const bytes = createHash('sha1').update(Buffer.concat([ns, Buffer.from(customerId, 'utf8')])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Store amounts: Apple reports milliunits, Google units + nanos. Converted to minor units. */
export function minorUnitsFromDecimal(units: number, nanos: number, currency: string): number {
  const exp = currencyExponent(currency); // EC:J6
  return Math.round(units * 10 ** exp + nanos / 10 ** (9 - exp));
}

export function minorUnitsFromMilliunits(milliunits: number, currency: string): number {
  const exp = currencyExponent(currency); // EC:J6
  return Math.round((milliunits * 10 ** exp) / 1000);
}
