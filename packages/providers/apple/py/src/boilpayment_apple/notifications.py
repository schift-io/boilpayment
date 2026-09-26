"""EC:N6 N7 N8 N13 N14 -- App Store Server Notifications V2 -> NormalizedEvent type.

Mirrors packages/providers/apple/ts/src/notifications.ts.
Types: https://developer.apple.com/documentation/appstoreservernotifications/notificationtype
"""

from __future__ import annotations

# Types this kit understands. Anything else maps to "unknown" and is logged (newer or unconfirmed types).
_MAP = {
    "SUBSCRIBED": "payment.succeeded",
    "DID_RENEW": "payment.succeeded",
    "ONE_TIME_CHARGE": "payment.succeeded",
    "DID_FAIL_TO_RENEW": "subscription.payment_failed",  # EC:N8 -- Apple owns grace / billing retry
    "GRACE_PERIOD_EXPIRED": "subscription.payment_failed",
    "EXPIRED": "subscription.canceled",
    "REFUND": "refund.created",  # EC:N6 -- money already returned by Apple; credits clawed back
    "REVOKE": "refund.created",  # EC:N5 N6 -- Family Sharing access withdrawn
    "DID_CHANGE_RENEWAL_STATUS": "subscription.updated",
    "DID_CHANGE_RENEWAL_PREF": "subscription.updated",  # EC:N9
    "PRICE_INCREASE": "subscription.updated",  # EC:N10 -- notify only
    "OFFER_REDEEMED": "subscription.updated",
    "RENEWAL_EXTENDED": "subscription.updated",
    "RENEWAL_EXTENSION": "subscription.updated",
    "REFUND_DECLINED": "unknown",
    "REFUND_REVERSED": "unknown",  # EC:N7 -- v1 records only; re-grant is a manual CS action
    "CONSUMPTION_REQUEST": "unknown",  # EC:N14 -- v1 records the request only
    "TEST": "unknown",
}


def map_notification_type(notification_type: str) -> tuple[str, bool]:
    mapped = _MAP.get(notification_type)
    return ("unknown", False) if mapped is None else (mapped, True)
