"""boilpayment -- Apple App Store in-app purchase provider.

spec: ../../spec/apple.pseudo.md
Mirrors packages/providers/apple/ts/src/index.ts (camelCase <-> snake_case only).

The purchase happens on the device (StoreKit 2). The app posts `Transaction.jwsRepresentation`;
verify_purchase checks the signature chain, bundle id and environment, then re-fetches the
transaction from the App Store Server API (EC:E3). Notifications V2 arrive at verify_webhook.
"""

from __future__ import annotations

import json
import time
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
    minor_units_from_milliunits,
)

from .jws import APPLE_LEAF_OID, APPLE_WWDR_OID, app_store_api_token, verify_apple_jws
from .notifications import map_notification_type

__all__ = [
    "APPLE_API_HOSTS",
    "APPLE_LEAF_OID",
    "APPLE_WWDR_OID",
    "AppleProvider",
    "AppleProviderConfig",
    "app_store_api_token",
    "map_notification_type",
    "transaction_to_payment",
    "transaction_to_subscription",
    "verify_apple_jws",
]

APPLE_API_HOSTS = {
    "production": "https://api.storekit.apple.com",
    "sandbox": "https://api.storekit-sandbox.apple.com",
}
_STATUS = {1: "active", 2: "expired", 3: "past_due", 4: "past_due", 5: "canceled"}


@dataclass(kw_only=True, slots=True)
class AppleProviderConfig:
    bundle_id: str
    root_certificates: list[str]  # PEM. Production: Apple Root CA - G3
    issuer_id: str  # App Store Server API key
    key_id: str
    private_key: str
    app_apple_id: int | None = None  # required to accept Production notifications
    api_base_url: dict[str, str] = field(
        default_factory=dict
    )  # {"production": ..., "sandbox": ...}
    logger: Logger | None = None
    now: Any = None  # callable returning datetime (tests)


def _dt(ms: int | None) -> datetime:
    return datetime.fromtimestamp((ms or 0) / 1000, tz=UTC)


def _is_sub(t: dict[str, Any]) -> bool:
    return t.get("type") == "Auto-Renewable Subscription"


def _env(t: dict[str, Any]) -> str:
    return "production" if t.get("environment") == "Production" else "sandbox"


def _unsupported(what: str) -> PaymentKitError:
    return PaymentKitError(
        f"{what} is not supported for Apple in-app purchases (on-device store)",
        "unsupported",
    )


def transaction_to_payment(t: dict[str, Any]) -> tuple[Payment, bool]:
    """EC:N11 -- JWSTransaction -> Payment. Price is milliunits; absent price -> amount 0, from_store False."""
    currency = (t.get("currency") or "USD").upper()
    from_store = isinstance(t.get("price"), int)
    sub = _is_sub(t)
    payment = Payment(
        id=t["transactionId"],
        customer_id=t.get("appAccountToken") or "",
        provider="apple",
        provider_ref=t["transactionId"],
        subscription_id=t["originalTransactionId"] if sub else None,
        amount=Money(
            amount_minor=minor_units_from_milliunits(t["price"], currency)
            if from_store
            else 0,
            currency=currency,
        ),
        status="refunded" if t.get("revocationDate") else "succeeded",
        kind="subscription" if sub else "topup",
        period=Period(start=_dt(t["purchaseDate"]), end=_dt(t["expiresDate"]))
        if sub and t.get("expiresDate")
        else None,
        occurred_at=_dt(t["purchaseDate"]),
        failure=None,
        cash_receipt=None,
        raw=t,
    )
    return payment, from_store


def transaction_to_subscription(
    t: dict[str, Any],
    *,
    now: datetime,
    status: int | None = None,
    auto_renew: bool | None = None,
    grace_until: datetime | None = None,
) -> Subscription:
    end = _dt(t.get("expiresDate") or t["purchaseDate"])
    state = (
        _STATUS.get(status, "expired")
        if status is not None
        else ("active" if end > now else "expired")
    )
    first = _dt(t.get("originalPurchaseDate") or t["purchaseDate"])
    return Subscription(
        id=t["originalTransactionId"],
        customer_id=t.get("appAccountToken") or "",
        plan_id="",
        provider="apple",
        provider_ref=t["originalTransactionId"],
        status=state,
        current_period=Period(start=_dt(t["purchaseDate"]), end=end),
        anchor_day=first.day,
        cancel_at_period_end=auto_renew is False,
        grace_until=grace_until,
        billing_key=None,
        scheduled_plan_id=None,
        version=0,
        created_at=first,
    )


class AppleProvider:
    name = "apple"

    def __init__(self, config: AppleProviderConfig):
        self._c = config
        self._logger: Logger = config.logger or NoopLogger()

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

    def _verify(self, jws: str) -> dict[str, Any]:
        return verify_apple_jws(
            jws, root_certificates=self._c.root_certificates, now=self._now()
        )

    def _transaction(self, jws: str) -> dict[str, Any]:
        """EC:N3 -- a proof for another app is refused before anything is recorded."""
        t = self._verify(jws)
        if t.get("bundleId") != self._c.bundle_id:
            raise PaymentKitError(
                "transaction belongs to another app",
                "iap_wrong_app",
                {"bundleId": t.get("bundleId")},
            )
        return t

    async def _api(self, env: str, path: str) -> Any:
        base = self._c.api_base_url.get(env) or APPLE_API_HOSTS[env]
        token = app_store_api_token(
            issuer_id=self._c.issuer_id,
            key_id=self._c.key_id,
            private_key=self._c.private_key,
            bundle_id=self._c.bundle_id,
            now=self._now(),
        )
        started = time.monotonic()
        async with httpx.AsyncClient(timeout=30.0) as client:
            res = await client.get(
                f"{base}{path}", headers={"Authorization": f"Bearer {token}"}
            )
        ok = res.status_code < 400
        await self._logger.log(
            {
                "level": "info" if ok or res.status_code == 404 else "warn",
                "event": "provider.request",
                "provider": "apple",
                "method": "GET",
                "path": path,
                "status": res.status_code,
                "durationMs": round((time.monotonic() - started) * 1000),
                "providerErrorCode": None if ok else str(res.status_code),
            }
        )
        if res.status_code == 404:
            return None
        if not ok:
            raise ProviderError(
                f"apple GET {path} failed: {res.status_code}",
                PaymentFailure(
                    code="provider_unavailable",
                    provider_code=str(res.status_code),
                    retryable=res.status_code >= 500 or res.status_code == 429,
                    user_message="App Store 확인 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.",
                ),
                {"status": res.status_code},
            )
        return json.loads(res.text)

    async def _fetch_transaction(
        self, transaction_id: str, env: str | None = None
    ) -> dict[str, Any]:
        for e in [env] if env else ["production", "sandbox"]:
            body = await self._api(
                e, f"/inApps/v1/transactions/{quote(transaction_id, safe='')}"
            )
            if body:
                return self._transaction(body["signedTransactionInfo"])
        raise PaymentKitError(
            "transaction not found at the App Store",
            "iap_purchase_not_found",
            {"transactionId": transaction_id},
        )

    async def verify_purchase(self, proof: StoreProof) -> VerifiedStorePurchase:
        if not proof.signed_transaction:
            raise PaymentKitError(
                "Apple proof needs signed_transaction", "iap_proof_invalid"
            )
        sent = self._transaction(proof.signed_transaction)
        env = _env(sent)
        live = await self._fetch_transaction(
            sent["transactionId"], env
        )  # EC:E3 -- the store's view wins
        if live["transactionId"] != sent["transactionId"] or _env(live) != env:
            raise PaymentKitError(
                "store transaction does not match the proof", "iap_proof_invalid"
            )
        payment, from_store = transaction_to_payment(live)
        sub = _is_sub(live)
        return VerifiedStorePurchase(
            payment=payment,
            amount_from_store=from_store,
            product_id=live["productId"],
            subscription_ref=live["originalTransactionId"] if sub else None,
            subscription=transaction_to_subscription(live, now=self._now())
            if sub
            else None,
            account_token=live.get("appAccountToken"),
            environment=env,  # type: ignore[arg-type]
            ownership="family_shared"
            if live.get("inAppOwnershipType") == "FAMILY_SHARED"
            else "purchased",
            acknowledged=True,
        )

    async def get_payment(self, provider_ref: str) -> Payment:
        return transaction_to_payment(await self._fetch_transaction(provider_ref))[0]

    async def list_payments(self, **_: Any) -> list[Payment]:
        """Apple has no per-customer payment list; support flows match on the account token instead."""
        return []

    async def get_subscription(self, provider_ref: str) -> Subscription:
        for e in ("production", "sandbox"):
            body = await self._api(
                e, f"/inApps/v1/subscriptions/{quote(provider_ref, safe='')}"
            )
            items = [
                i
                for g in (body or {}).get("data", [])
                for i in g.get("lastTransactions", [])
            ]
            item = next(
                (i for i in items if i.get("originalTransactionId") == provider_ref),
                None,
            )
            if item is None:
                continue
            t = self._transaction(item["signedTransactionInfo"])
            renewal = (
                self._verify(item["signedRenewalInfo"])
                if item.get("signedRenewalInfo")
                else None
            )
            grace = renewal.get("gracePeriodExpiresDate") if renewal else None
            return transaction_to_subscription(
                t,
                now=self._now(),
                status=item.get("status"),
                auto_renew=(renewal.get("autoRenewStatus") == 1) if renewal else None,
                grace_until=_dt(grace) if grace else None,
            )
        raise PaymentKitError(
            "subscription not found at the App Store",
            "iap_purchase_not_found",
            {"originalTransactionId": provider_ref},
        )

    async def verify_webhook(
        self, *, headers: dict[str, str], raw_body: str
    ) -> NormalizedEvent:
        """EC:N1 N5 N6 N13 -- App Store Server Notifications V2. The whole payload is a signed JWS."""
        try:
            signed = json.loads(raw_body).get("signedPayload")
        except (ValueError, AttributeError):
            signed = None
        if not isinstance(signed, str):
            raise WebhookSignatureError("apple notification has no signedPayload")
        try:
            note = self._verify(signed)
        except PaymentKitError as err:
            raise WebhookSignatureError(str(err)) from err
        data = note.get("data") or {}
        if (
            data.get("bundleId") is not None
            and data.get("bundleId") != self._c.bundle_id
        ):
            raise WebhookSignatureError("apple notification for another app")
        if data.get("environment") == "Production" and (
            self._c.app_apple_id is None
            or data.get("appAppleId") != self._c.app_apple_id
        ):
            raise WebhookSignatureError(
                "apple production notification with a missing or different appAppleId"
            )
        event_type, known = map_notification_type(note.get("notificationType", ""))
        if not known:
            await self._logger.log(
                {
                    "level": "info",
                    "event": "webhook.unmapped",
                    "provider": "apple",
                    "providerErrorCode": note.get("notificationType"),
                }
            )
        t = (
            self._transaction(data["signedTransactionInfo"])
            if data.get("signedTransactionInfo")
            else None
        )
        pay = transaction_to_payment(t) if t else None
        is_refund = event_type == "refund.created"
        return NormalizedEvent(
            id=note["notificationUUID"],
            provider="apple",
            type=event_type,  # type: ignore[arg-type]
            occurred_at=_dt(note.get("signedDate") or int(time.time() * 1000)),
            customer_ref=t.get("appAccountToken") if t else None,
            subscription_ref=t["originalTransactionId"] if t and _is_sub(t) else None,
            payment_ref=t["transactionId"] if t else None,
            amount=pay[0].amount if pay and pay[1] else None,
            refund_ref=f"apple-{note['notificationType'].lower()}:{t['transactionId']}"
            if is_refund and t
            else None,
            raw={
                "notificationType": note.get("notificationType"),
                "subtype": note.get("subtype"),
                "transaction": t,
            },
        )

    async def create_customer(self, **_: Any) -> dict[str, str]:
        raise _unsupported("create_customer (use store_account_token(customer_id))")

    async def create_checkout(self, *_: Any, **__: Any) -> Any:
        raise _unsupported("create_checkout")

    async def change_subscription(self, *_: Any, **__: Any) -> Subscription:
        raise _unsupported("change_subscription")

    async def cancel_subscription(self, *_: Any, **__: Any) -> Subscription:
        raise _unsupported("cancel_subscription")

    async def uncancel_subscription(self, *_: Any, **__: Any) -> Subscription:
        raise _unsupported("uncancel_subscription")

    async def charge_billing_key(self, **_: Any) -> Payment:
        raise _unsupported("charge_billing_key")

    async def refund(self, **_: Any) -> Any:
        raise _unsupported(
            "refund (Apple decides refunds; REFUND notifications are reconciled)"
        )

    async def report_usage(self, **_: Any) -> None:
        raise _unsupported("report_usage")
