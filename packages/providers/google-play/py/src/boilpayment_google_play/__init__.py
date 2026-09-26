"""boilpayment -- Google Play in-app purchase provider.

spec: ../../spec/google-play.pseudo.md
Mirrors packages/providers/google-play/ts/src/index.ts (camelCase <-> snake_case only).

The app posts purchase_token + product_id; verify_purchase reads the purchase from androidpublisher
v3 (subscriptionsv2.get / products.get). Real-time developer notifications arrive as Pub/Sub pushes.
Payment refs: subscription `s|<purchaseToken>|<orderId>`, one-time `p|<productId>|<purchaseToken>`.
"""

from __future__ import annotations

import base64
import json
import time
from calendar import monthrange
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from urllib.parse import quote

import httpx
from boilpayment_core import (
    Logger,
    Money,
    NoopLogger,
    NormalizedEvent,
    Payment,
    PaymentFailure,
    PaymentKitError,
    Period,
    ProviderCapabilities,
    ProviderError,
    StoreProof,
    Subscription,
    VerifiedStorePurchase,
    WebhookSignatureError,
    minor_units_from_decimal,
)

from .auth import (
    GOOGLE_ISSUERS,
    GOOGLE_JWKS_URL,
    PubsubAuthConfig,
    PushAuthError,
    ServiceAccountTokens,
    verify_push_token,
)

__all__ = [
    "GOOGLE_ISSUERS",
    "GOOGLE_JWKS_URL",
    "GooglePlayProvider",
    "GooglePlayProviderConfig",
    "PubsubAuthConfig",
    "PushAuthError",
    "ServiceAccountTokens",
    "parse_payment_ref",
    "period_start_from_expiry",
    "verify_push_token",
]

API = "https://androidpublisher.googleapis.com"

_SUB_PAY = {
    "SUBSCRIPTION_STATE_ACTIVE": "succeeded",
    "SUBSCRIPTION_STATE_CANCELED": "succeeded",
    "SUBSCRIPTION_STATE_IN_GRACE_PERIOD": "succeeded",
    "SUBSCRIPTION_STATE_EXPIRED": "succeeded",
    "SUBSCRIPTION_STATE_PENDING": "pending",
    "SUBSCRIPTION_STATE_ON_HOLD": "failed",
    "SUBSCRIPTION_STATE_PAUSED": "failed",
    "SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED": "failed",
}
# EC:N15 -- PAUSED has no own status in the kit; it is past_due (no access, no grant) until resumed.
_SUB_STATE = {
    "SUBSCRIPTION_STATE_ACTIVE": "active",
    "SUBSCRIPTION_STATE_CANCELED": "active",
    "SUBSCRIPTION_STATE_IN_GRACE_PERIOD": "past_due",
    "SUBSCRIPTION_STATE_ON_HOLD": "past_due",
    "SUBSCRIPTION_STATE_PAUSED": "past_due",
    "SUBSCRIPTION_STATE_EXPIRED": "expired",
    "SUBSCRIPTION_STATE_PENDING": "trialing",
    "SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED": "canceled",
}
# RTDN subscriptionNotification.notificationType (developer.android.com/google/play/billing/rtdn-reference)
_RTDN = {
    1: "payment.succeeded",
    2: "payment.succeeded",
    3: "subscription.updated",
    4: "payment.succeeded",
    5: "subscription.payment_failed",
    6: "subscription.payment_failed",
    7: "subscription.updated",
    9: "subscription.updated",
    10: "subscription.updated",
    11: "subscription.updated",
    12: "refund.created",
    13: "subscription.canceled",
}


@dataclass(kw_only=True, slots=True)
class GooglePlayProviderConfig:
    package_name: str
    service_account: dict[str, Any]
    pubsub: PubsubAuthConfig
    # EC:N9 -- subscription productId -> "month" | "year". Play reports no period start, so the kit
    # uses expiryTime minus this interval (deterministic: verify and notifications agree).
    product_intervals: dict[str, str] = field(default_factory=dict)
    api_base_url: str | None = None
    logger: Logger | None = None
    now: Any = None


def _unsupported(what: str) -> PaymentKitError:
    return PaymentKitError(
        f"{what} is not supported for Google Play in-app purchases", "unsupported"
    )


def parse_payment_ref(ref: str) -> tuple[str, str, str]:
    """("sub", token, order) or ("product", product_id, token)."""
    parts = ref.split("|")
    if len(parts) == 3 and parts[0] == "s" and parts[1] and parts[2]:
        return ("sub", parts[1], parts[2])
    if len(parts) == 3 and parts[0] == "p" and parts[1] and parts[2]:
        return ("product", parts[1], parts[2])
    raise PaymentKitError(f"not a Google Play payment ref: {ref}", "iap_proof_invalid")


def period_start_from_expiry(end: datetime, interval: str) -> datetime:
    """Expiry minus one interval, clamping the day like core next_period does (EC:G1)."""
    y = end.year - (1 if interval == "year" else 0)
    m = end.month - 1 if interval == "month" else end.month
    if m < 1:
        y, m = y - 1, 12
    return end.replace(year=y, month=m, day=min(end.day, monthrange(y, m)[1]))


def _parse_rfc3339(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value)


class GooglePlayProvider:
    name = "google_play"

    def __init__(self, config: GooglePlayProviderConfig):
        self._c = config
        self._logger: Logger = config.logger or NoopLogger()
        self._tokens = ServiceAccountTokens(config.service_account)

    def capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            native_subscriptions=True,
            partial_refund=False,
            meters=False,
            scheduling="provider",
            webhook_signature=True,
            checkout="on_device",
        )

    def _now(self) -> datetime:
        return self._c.now() if self._c.now else datetime.now(tz=UTC)

    def _base(self) -> str:
        return f"{self._c.api_base_url or API}/androidpublisher/v3/applications/{quote(self._c.package_name, safe='')}"

    async def _call(self, method: str, path: str) -> Any:
        started = time.monotonic()
        headers = {"Authorization": f"Bearer {await self._tokens.token()}"}
        async with httpx.AsyncClient(timeout=30.0) as client:
            res = await client.request(
                method,
                f"{self._base()}{path}",
                headers=headers,
                content=b"{}" if method == "POST" else None,
            )
        ok = res.status_code < 400
        await self._logger.log(
            {
                "level": "info" if ok or res.status_code == 404 else "warn",
                "event": "provider.request",
                "provider": "google_play",
                "method": method,
                "path": path,
                "status": res.status_code,
                "durationMs": round((time.monotonic() - started) * 1000),
                "providerErrorCode": None if ok else str(res.status_code),
            }
        )
        if res.status_code in (404, 410):
            return None
        if not ok:
            raise ProviderError(
                f"google_play {method} {path} failed: {res.status_code}",
                PaymentFailure(
                    code="provider_unavailable",
                    provider_code=str(res.status_code),
                    retryable=res.status_code >= 500 or res.status_code == 429,
                    user_message="Google Play 확인 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.",
                ),
                {"status": res.status_code},
            )
        return json.loads(res.text) if res.text else {}

    async def _subscription_v2(self, token: str) -> dict[str, Any] | None:
        return await self._call(
            "GET", f"/purchases/subscriptionsv2/tokens/{quote(token, safe='')}"
        )

    async def _product(self, product_id: str, token: str) -> dict[str, Any] | None:
        return await self._call(
            "GET",
            f"/purchases/products/{quote(product_id, safe='')}/tokens/{quote(token, safe='')}",
        )

    def subscription_payment(
        self, token: str, s: dict[str, Any], product_id: str | None = None
    ) -> tuple[Payment, bool, dict[str, Any]]:
        item = next(
            (
                i
                for i in s.get("lineItems") or []
                if not product_id or i.get("productId") == product_id
            ),
            None,
        )
        if item is None:
            raise PaymentKitError(
                "subscription line item not found", "iap_purchase_not_found"
            )
        interval = self._c.product_intervals.get(item["productId"])
        if not interval:
            raise PaymentKitError(
                f"no interval configured for subscription product {item['productId']}",
                "iap_unknown_product",
            )
        end = (
            _parse_rfc3339(item.get("expiryTime"))
            or _parse_rfc3339(s.get("startTime"))
            or self._now()
        )
        order = (
            item.get("latestSuccessfulOrderId")
            or s.get("latestOrderId")
            or f"exp:{end.isoformat(timespec='milliseconds').replace('+00:00', 'Z')}"
        )
        price = (item.get("autoRenewingPlan") or {}).get("recurringPrice") or {}
        currency = (price.get("currencyCode") or "USD").upper()
        from_store = bool(price.get("currencyCode"))
        start = period_start_from_expiry(end, interval)
        ref = f"s|{token}|{order}"
        ids = s.get("externalAccountIdentifiers") or {}
        payment = Payment(
            id=ref,
            customer_id=ids.get("obfuscatedExternalAccountId") or "",
            provider="google_play",
            provider_ref=ref,
            subscription_id=token,
            amount=Money(
                amount_minor=minor_units_from_decimal(
                    int(price.get("units") or 0), int(price.get("nanos") or 0), currency
                )
                if from_store
                else 0,
                currency=currency,
            ),
            status=_SUB_PAY.get(s.get("subscriptionState") or "", "pending"),  # type: ignore[arg-type]
            kind="subscription",
            period=Period(start=start, end=end),
            occurred_at=start,
            failure=None,
            cash_receipt=None,
            raw=s,
        )
        return payment, from_store, item

    def to_subscription(self, token: str, s: dict[str, Any]) -> Subscription:
        payment, _, item = self.subscription_payment(token, s)
        start = _parse_rfc3339(s.get("startTime")) or payment.period.start  # type: ignore[union-attr]
        auto = (item.get("autoRenewingPlan") or {}).get("autoRenewEnabled")
        return Subscription(
            id=token,
            customer_id=payment.customer_id,
            plan_id="",
            provider="google_play",
            provider_ref=token,
            status=_SUB_STATE.get(s.get("subscriptionState") or "", "expired"),  # type: ignore[arg-type]
            current_period=payment.period,
            anchor_day=start.day,  # type: ignore[arg-type]
            cancel_at_period_end=s.get("subscriptionState")
            == "SUBSCRIPTION_STATE_CANCELED"
            or auto is False,
            grace_until=None,
            billing_key=None,
            scheduled_plan_id=None,
            version=0,
            created_at=start,
        )

    def _product_payment(
        self, product_id: str, token: str, p: dict[str, Any]
    ) -> Payment:
        at = datetime.fromtimestamp(
            int(p.get("purchaseTimeMillis") or self._now().timestamp() * 1000) / 1000,
            tz=UTC,
        )
        state = p.get("purchaseState")
        ref = f"p|{product_id}|{token}"
        return Payment(
            id=ref,
            customer_id=p.get("obfuscatedExternalAccountId") or "",
            provider="google_play",
            provider_ref=ref,
            subscription_id=None,
            amount=Money(
                amount_minor=0, currency=""
            ),  # EC:N11 -- products.get reports no price
            status="succeeded" if state == 0 else "pending" if state == 2 else "failed",
            kind="topup",
            period=None,
            occurred_at=at,
            failure=None,
            cash_receipt=None,
            raw=p,
        )

    async def verify_purchase(self, proof: StoreProof) -> VerifiedStorePurchase:
        token = proof.purchase_token
        if not token:
            raise PaymentKitError(
                "Google Play proof needs purchase_token", "iap_proof_invalid"
            )
        if proof.subscription is not False:
            s = await self._subscription_v2(token)
            if s:
                payment, from_store, item = self.subscription_payment(
                    token, s, proof.product_id
                )
                ids = s.get("externalAccountIdentifiers") or {}
                return VerifiedStorePurchase(
                    payment=payment,
                    amount_from_store=from_store,
                    product_id=item["productId"],
                    subscription_ref=token,
                    subscription=self.to_subscription(token, s),
                    account_token=ids.get("obfuscatedExternalAccountId"),
                    environment="sandbox"
                    if s.get("testPurchase") is not None
                    else "production",
                    ownership="purchased",
                    acknowledged=s.get("acknowledgementState")
                    == "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
                    replaces_subscription_ref=s.get("linkedPurchaseToken"),
                )
            if proof.subscription is True:
                raise PaymentKitError(
                    "purchase token not found for this app", "iap_purchase_not_found"
                )
        if not proof.product_id:
            raise PaymentKitError(
                "Google Play one-time proof needs product_id", "iap_proof_invalid"
            )
        p = await self._product(proof.product_id, token)
        if not p:
            raise PaymentKitError(
                "purchase token not found for this app", "iap_purchase_not_found"
            )
        return VerifiedStorePurchase(
            payment=self._product_payment(proof.product_id, token, p),
            amount_from_store=False,
            product_id=proof.product_id,
            subscription_ref=None,
            subscription=None,
            account_token=p.get("obfuscatedExternalAccountId"),
            environment="sandbox" if p.get("purchaseType") == 0 else "production",
            ownership="purchased",
            acknowledged=p.get("acknowledgementState") == 1,
        )

    async def acknowledge(self, payment_ref: str) -> dict[str, bool]:
        """EC:N1 -- acknowledge within 3 days or Google refunds. Idempotent."""
        kind, a, b = parse_payment_ref(payment_ref)
        if kind == "product":
            p = await self._product(a, b)
            if not p:
                raise PaymentKitError(
                    "purchase token not found for this app", "iap_purchase_not_found"
                )
            if p.get("acknowledgementState") != 1:
                await self._call(
                    "POST",
                    f"/purchases/products/{quote(a, safe='')}/tokens/{quote(b, safe='')}:acknowledge",
                )
            return {"acknowledged": True}
        s = await self._subscription_v2(a)
        if not s:
            raise PaymentKitError(
                "purchase token not found for this app", "iap_purchase_not_found"
            )
        if s.get("acknowledgementState") != "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED":
            product_id = ((s.get("lineItems") or [{}])[0]).get("productId", "")
            await self._call(
                "POST",
                f"/purchases/subscriptions/{quote(product_id, safe='')}/tokens/{quote(a, safe='')}:acknowledge",
            )
        return {"acknowledged": True}

    async def get_payment(self, provider_ref: str) -> Payment:
        kind, a, b = parse_payment_ref(provider_ref)
        if kind == "product":
            p = await self._product(a, b)
            if not p:
                raise PaymentKitError(
                    "purchase token not found for this app", "iap_purchase_not_found"
                )
            return self._product_payment(a, b, p)
        s = await self._subscription_v2(a)
        if not s:
            raise PaymentKitError(
                "purchase token not found for this app", "iap_purchase_not_found"
            )
        return self.subscription_payment(a, s)[0]

    async def list_payments(self, **_: Any) -> list[Payment]:
        """Play has no per-customer order list; support flows match on the account id instead."""
        return []

    async def get_subscription(self, provider_ref: str) -> Subscription:
        s = await self._subscription_v2(provider_ref)
        if not s:
            raise PaymentKitError(
                "purchase token not found for this app", "iap_purchase_not_found"
            )
        return self.to_subscription(provider_ref, s)

    async def cancel_subscription(
        self, provider_ref: str, *, at_period_end: bool
    ) -> Subscription:
        """Developer cancel = auto-renew off; access continues to the end of the period."""
        if not at_period_end:
            raise _unsupported(
                "immediate cancellation (Play cancels at period end; revoke is a refund)"
            )
        s = await self._subscription_v2(provider_ref)
        if not s:
            raise PaymentKitError(
                "purchase token not found for this app", "iap_purchase_not_found"
            )
        product_id = ((s.get("lineItems") or [{}])[0]).get("productId", "")
        await self._call(
            "POST",
            f"/purchases/subscriptions/{quote(product_id, safe='')}/tokens/{quote(provider_ref, safe='')}:cancel",
        )
        return await self.get_subscription(provider_ref)

    async def verify_webhook(
        self,
        *,
        headers: dict[str, str],
        raw_body: str,
        received_at: datetime | None = None,
    ) -> NormalizedEvent:
        """EC:N1 N6 N13 -- Pub/Sub push: verify the OIDC token, check the package, map the notification."""
        auth = headers.get("authorization") or headers.get("Authorization")
        try:
            # EC:E17 -- the push token's exp is judged at receipt on a later re-verify.
            await verify_push_token(
                auth, self._c.pubsub, received_at if received_at is not None else self._now()
            )
        except PushAuthError as err:
            raise WebhookSignatureError(str(err)) from err
        try:
            push = json.loads(raw_body)
            dev = json.loads(
                base64.b64decode((push.get("message") or {}).get("data") or "")
            )
        except (ValueError, AttributeError) as err:
            raise WebhookSignatureError("push body is not a Pub/Sub message") from err
        if dev.get("packageName") != self._c.package_name:
            raise WebhookSignatureError("notification for another package")
        msg = push.get("message") or {}
        event_id = msg.get("messageId") or msg.get("message_id")
        if not event_id:
            raise WebhookSignatureError("push message has no id")
        occurred = datetime.fromtimestamp(
            int(dev.get("eventTimeMillis") or time.time() * 1000) / 1000, tz=UTC
        )

        def ev(event_type: str, raw: dict[str, Any], **kw: Any) -> NormalizedEvent:
            return NormalizedEvent(
                id=event_id,
                provider="google_play",
                type=event_type,
                occurred_at=occurred,  # type: ignore[arg-type]
                customer_ref=kw.get("customer_ref"),
                subscription_ref=kw.get("subscription_ref"),
                payment_ref=kw.get("payment_ref"),
                amount=kw.get("amount"),
                refund_ref=kw.get("refund_ref"),
                raw=raw,
            )

        if "subscriptionNotification" in dev:
            n = dev["subscriptionNotification"]
            event_type = _RTDN.get(n.get("notificationType"), "unknown")
            if event_type == "unknown":
                await self._logger.log(
                    {
                        "level": "info",
                        "event": "webhook.unmapped",
                        "provider": "google_play",
                        "providerErrorCode": f"subscription:{n.get('notificationType')}",
                    }
                )
            payment = None
            if event_type in ("payment.succeeded", "refund.created"):
                s = await self._subscription_v2(n["purchaseToken"])
                if s:
                    payment = self.subscription_payment(n["purchaseToken"], s)[0]
            return ev(
                event_type,
                {"subscriptionNotification": n},
                subscription_ref=n["purchaseToken"],
                customer_ref=(payment.customer_id or None) if payment else None,
                payment_ref=payment.provider_ref if payment else None,
                amount=payment.amount if payment and payment.amount.currency else None,
                refund_ref=f"gp-revoke:{payment.provider_ref}"
                if event_type == "refund.created" and payment
                else None,
            )
        if "oneTimeProductNotification" in dev:
            n = dev["oneTimeProductNotification"]
            t = n.get("notificationType")
            event_type = (
                "payment.succeeded"
                if t == 1
                else "payment.failed"
                if t == 2
                else "unknown"
            )
            return ev(
                event_type,
                {"oneTimeProductNotification": n},
                payment_ref=f"p|{n['sku']}|{n['purchaseToken']}",
            )
        if "voidedPurchaseNotification" in dev:
            v = dev["voidedPurchaseNotification"]
            # EC:N6 -- no amount (and no productId for one-time); resolved from the local payment.
            sub = v.get("productType") == 1
            ref = (
                f"s|{v['purchaseToken']}|{v['orderId']}"
                if sub
                else f"p|?|{v['purchaseToken']}"
            )
            return ev(
                "refund.created",
                {"voidedPurchaseNotification": v},
                payment_ref=ref,
                refund_ref=f"gp-void:{v['orderId']}",
                subscription_ref=v["purchaseToken"] if sub else None,
            )
        return ev("unknown", {"testNotification": dev.get("testNotification")})

    async def create_customer(self, **_: Any) -> dict[str, str]:
        raise _unsupported("create_customer (use store_account_token(customer_id))")

    async def create_checkout(self, *_: Any, **__: Any) -> Any:
        raise _unsupported("create_checkout")

    async def change_subscription(self, *_: Any, **__: Any) -> Subscription:
        raise _unsupported("change_subscription")

    async def uncancel_subscription(self, *_: Any, **__: Any) -> Subscription:
        raise _unsupported("uncancel_subscription")

    async def charge_billing_key(self, **_: Any) -> Payment:
        raise _unsupported("charge_billing_key")

    async def refund(self, **_: Any) -> Any:
        raise _unsupported(
            "refund (v1 records store refunds; server-side refund API unconfirmed)"
        )

    async def report_usage(self, **_: Any) -> None:
        raise _unsupported("report_usage")
