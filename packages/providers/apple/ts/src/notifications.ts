// EC:N6 N7 N8 N13 N14 — App Store Server Notifications V2 → NormalizedEvent type. spec: ../../spec/apple.pseudo.md
// Types: https://developer.apple.com/documentation/appstoreservernotifications/notificationtype
import type { NormalizedEventType } from 'boilpayment-core';

/** Types this kit understands. Anything else maps to 'unknown' and is logged (newer or unconfirmed types). */
const MAP: Record<string, NormalizedEventType> = {
  SUBSCRIBED: 'payment.succeeded',
  DID_RENEW: 'payment.succeeded',
  ONE_TIME_CHARGE: 'payment.succeeded',
  DID_FAIL_TO_RENEW: 'subscription.payment_failed', // EC:N8 — grace / billing retry is owned by Apple
  GRACE_PERIOD_EXPIRED: 'subscription.payment_failed',
  EXPIRED: 'subscription.canceled',
  REFUND: 'refund.created', // EC:N6 — money already returned by Apple; credits are clawed back
  REVOKE: 'refund.created', // EC:N5 N6 — Family Sharing access withdrawn
  DID_CHANGE_RENEWAL_STATUS: 'subscription.updated',
  DID_CHANGE_RENEWAL_PREF: 'subscription.updated', // EC:N9
  PRICE_INCREASE: 'subscription.updated', // EC:N10 — notify only
  OFFER_REDEEMED: 'subscription.updated',
  RENEWAL_EXTENDED: 'subscription.updated',
  RENEWAL_EXTENSION: 'subscription.updated',
  REFUND_DECLINED: 'unknown',
  REFUND_REVERSED: 'unknown', // EC:N7 — v1 records only; re-grant is a manual CS action
  CONSUMPTION_REQUEST: 'unknown', // EC:N14 — v1 records the request only
  TEST: 'unknown',
};

export function mapNotificationType(type: string): { type: NormalizedEventType; known: boolean } {
  const mapped = MAP[type];
  return mapped === undefined ? { type: 'unknown', known: false } : { type: mapped, known: true };
}
