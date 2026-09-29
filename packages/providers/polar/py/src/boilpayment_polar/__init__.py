"""boilpayment — Polar provider.

spec: ../../spec/polar.pseudo.md
Mirrors packages/providers/polar/ts/src/index.ts exactly (function names, argument order,
return shape — camelCase <-> snake_case only).

NOTE: implemented directly over Polar's REST API (httpx) rather than through `polar-sdk`. The
installed py `polar-sdk` (0.32.0) and the installed ts `@polar-sh/sdk` (0.20.2) are far apart in
API surface (the ts SDK has no `refunds`/`events`/`meters` namespace and its `checkouts` is the
deprecated legacy API). To keep both language implementations calling identical endpoints/payloads
(per docs/ARCHITECTURE.md: "consistency across languages matters more than SDK usage"), both ts and
py talk to the REST API directly. Wire format is snake_case JSON.
"""

from __future__ import annotations

import base64
import copy
import hashlib
import hmac
import json
import time
from datetime import UTC, datetime
from typing import Any, Literal

import httpx
from boilpayment_core import (
    Checkout,
    CreateCheckoutInput,
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
    Refund,
    SaleEvidence,
    Subscription,
    WebhookSignatureError,
    money,
)

SERVER_URLS = {
    "production": "https://api.polar.sh",
    "sandbox": "https://sandbox-api.polar.sh",
}


def _money(amount_minor: int, currency: str) -> Money:
    return money(amount_minor, (currency or "usd").upper())  # EC:J8 -- safe-integer check


def _parse_dt(value: str | None) -> datetime:
    if not value:
        return datetime.now(tz=UTC)
    return datetime.fromisoformat(value)


# EC:E12 — Polar exposes little failure detail on the provider side (see spec)
def normalize_failure(*, message: str | None = None) -> PaymentFailure:
    return PaymentFailure(
        code="unknown",
        provider_code=None,
        retryable=True,
        user_message=message or "결제 처리 중 오류가 발생했습니다. 다시 시도해 주세요.",
    )


def _map_order_status(order: dict[str, Any]) -> str:
    status = order.get("status")
    if status == "refunded":
        return "refunded"
    if status == "partially_refunded":
        return "partially_refunded"
    if status == "paid" or order.get("paid"):
        return "succeeded"
    if status == "void":
        return "failed"
    return "pending"


# EC:E7 E12 — normalize Polar Order (raw REST, snake_case) -> Payment (pure)
def normalize_order(order: dict[str, Any]) -> Payment:
    kind = "subscription" if order.get("subscription_id") else "topup"
    metadata = order.get("metadata") or {}
    currency = order.get("currency", "usd")
    paid_amount = order.get("total_amount")
    if paid_amount is None:
        paid_amount = order.get("net_amount") or 0
    provider_subtotal = order.get("subtotal_amount")
    if provider_subtotal is None:
        provider_subtotal = paid_amount
    items = order.get("items") or []
    first_item = items[0] if items else {}
    return Payment(
        id=order["id"],
        customer_id="",
        provider="polar",
        provider_ref=order["id"],
        subscription_id=order.get("subscription_id"),
        amount=_money(paid_amount, currency),
        status=_map_order_status(order),
        kind=kind,
        period=None,
        occurred_at=_parse_dt(order.get("created_at")),
        failure=None,
        sale_evidence=SaleEvidence(
            provider_subtotal=_money(provider_subtotal, currency),
            discount_amount=_money(order.get("discount_amount") or 0, currency),
            price_ref=order.get("product_id") or first_item.get("product_price_id"),
            checkout_id=order.get("checkout_id"),
            payment_link_id=order.get("checkout_link_id")
            or metadata.get("checkout_link_id"),
            link_reference=metadata.get("reference_id")
            if isinstance(metadata.get("reference_id"), str)
            else None,
        ),
        affiliate_id=(
            metadata.get("affiliateId")
            if isinstance(metadata.get("affiliateId"), str)
            else metadata.get("affiliate_id")
            if isinstance(metadata.get("affiliate_id"), str)
            else None
        ),
        raw=order,
    )


SUB_STATUS: dict[str, str] = {
    "trialing": "trialing",
    "active": "active",
    "past_due": "past_due",
    "canceled": "canceled",
    "unpaid": "expired",
    "incomplete": "incomplete",  # EC:A27 -- never paid yet: no access, no dunning
    "incomplete_expired": "expired",
    "paused": "paused",  # EC:A27 -- trial ended without a payment method: no access
}


# EC:F(Polar) — normalize Subscription (raw REST) (pure). See spec "계약 메모".
def normalize_subscription(sub: dict[str, Any]) -> Subscription:
    md = sub.get("metadata") or {}
    start = _parse_dt(sub.get("current_period_start"))
    return Subscription(
        id=md.get("subscriptionId") or sub["id"],
        customer_id=md.get("customerId") or sub.get("customer_id", ""),
        plan_id=md.get("planId") or "",
        provider="polar",
        provider_ref=sub["id"],
        status=SUB_STATUS.get(sub.get("status", ""), "expired"),
        current_period=Period(
            start=start, end=_parse_dt(sub.get("current_period_end"))
        ),
        anchor_day=start.day,
        cancel_at_period_end=bool(sub.get("cancel_at_period_end")),
        grace_until=None,
        billing_key=None,
        scheduled_plan_id=None,
        created_at=_parse_dt(sub.get("created_at")),
        currency=sub["currency"].upper() if isinstance(sub.get("currency"), str) else None,  # EC:A28
        affiliate_id=(
            md.get("affiliateId")
            if isinstance(md.get("affiliateId"), str)
            else md.get("affiliate_id")
            if isinstance(md.get("affiliate_id"), str)
            else None
        ),
    )


def _map_refund_status(status: str | None) -> str:
    if status == "succeeded":
        return "succeeded"
    if status in ("failed", "canceled"):
        return "failed"
    return "pending"


def _map_refund_reason(reason: str) -> str:
    if reason in ("duplicate", "fraudulent"):
        return reason
    return "customer_request"


# EC:D4 D6 — normalize Refund (raw REST) (pure)
def normalize_refund(refund: dict[str, Any], rule_id: str) -> Refund:
    status = refund.get("status")
    return Refund(
        id=refund["id"],
        payment_id=refund.get("order_id", ""),
        customer_id=refund.get("customer_id") or "",
        amount=_money(refund.get("amount", 0), refund.get("currency", "usd")),
        status=_map_refund_status(status),
        provider_ref=refund["id"],
        credits_revoked=0,
        rule_id=rule_id,
        reason=refund.get("reason"),
        failure=normalize_failure() if status == "failed" else None,
        created_at=_parse_dt(refund.get("created_at")),
    )


# EC:F(Polar) — webhook event type mapping (pure)
def map_event_type(type_: str, refund_status: str | None = None) -> str:
    if type_ == "order.paid":
        return "payment.succeeded"
    if type_ == "order.created":
        return "payment.pending"
    if type_ == "order.refunded":
        return "unknown"  # Order totals do not identify a single refund.
    if type_ in ("refund.created", "refund.updated"):
        match _map_refund_status(refund_status):
            case "succeeded":
                return "refund.created"
            case "failed":
                return "refund.failed"
            case _:
                return "refund.pending"
    if type_ == "subscription.created":
        return "subscription.created"
    if type_ in (
        "subscription.updated",
        "subscription.active",
        "subscription.uncanceled",
    ):
        return "subscription.updated"
    if type_ in ("subscription.canceled", "subscription.revoked"):
        return "subscription.canceled"
    if type_ == "subscription.past_due":
        return "subscription.payment_failed"
    return "unknown"


# EC:F(Polar) — raw parsed webhook body -> NormalizedEvent (pure)
def to_normalized_event(
    parsed: dict[str, Any], delivery_id: str | None = None
) -> NormalizedEvent:
    type_ = parsed.get("type", "")
    data = parsed.get("data") or {}
    event_type = map_event_type(type_, data.get("status"))
    customer_ref: str | None = None
    subscription_ref: str | None = None
    payment_ref: str | None = None
    refund_ref: str | None = None
    amount: Money | None = None

    if type_.startswith("order."):
        customer_ref = data.get("customer_id")
        subscription_ref = data.get("subscription_id")
        payment_ref = data.get("id")
        if data.get("total_amount") is not None:
            amount = _money(data["total_amount"], data.get("currency", "usd"))
    elif type_.startswith("subscription."):
        customer_ref = data.get("customer_id")
        subscription_ref = data.get("id")
    elif type_ in ("refund.created", "refund.updated"):
        refund_ref = data.get("id")
        subscription_ref = data.get("subscription_id")
        customer_ref = data.get("customer_id")
        payment_ref = data.get("order_id")
        if data.get("amount") is not None:
            amount = _money(data["amount"], data.get("currency", "usd"))

    event_id = (
        f"{type_}:{data['id']}"
        if data.get("id")
        else parsed.get("id") or f"{type_}:{datetime.now(tz=UTC).timestamp()}"
    )
    return NormalizedEvent(
        id=delivery_id or parsed.get("id") or event_id,
        provider="polar",
        type=event_type,
        occurred_at=_parse_dt(parsed.get("timestamp")),
        customer_ref=customer_ref,
        subscription_ref=subscription_ref,
        payment_ref=payment_ref,
        refund_ref=refund_ref,
        amount=amount,
        raw=parsed,
    )


# EC:webhookSignature — Standard Webhooks HMAC verification, implemented manually (see spec).
def verify_standard_webhook_signature(
    *,
    headers: dict[str, str],
    raw_body: str,
    secret: str,
    received_at: datetime | None = None,
) -> None:
    lower = {k.lower(): v for k, v in headers.items()}
    id_ = lower.get("webhook-id")
    timestamp = lower.get("webhook-timestamp")
    sig_header = lower.get("webhook-signature")
    if not id_ or not timestamp or not sig_header:
        raise WebhookSignatureError(
            "missing webhook-id/webhook-timestamp/webhook-signature headers"
        )

    # mirrors PortoneProvider.verify_webhook -- Standard Webhooks 5-minute replay tolerance
    try:
        ts_sec = float(timestamp)
    except ValueError:
        raise WebhookSignatureError("invalid webhook timestamp")
    # EC:E17 -- freshness is enforced at receipt (wall clock); a re-verify of a stored row
    # (received_at set) checks the signature only.
    if received_at is None and abs(time.time() - ts_sec) > 300:
        raise WebhookSignatureError("webhook timestamp outside 5-minute tolerance")

    secret_raw = secret.removeprefix("whsec_")
    key = base64.b64decode(secret_raw)
    signed_content = f"{id_}.{timestamp}.{raw_body}".encode()
    expected = base64.b64encode(
        hmac.new(key, signed_content, hashlib.sha256).digest()
    ).decode("utf-8")

    candidates = []
    for part in sig_header.split(" "):
        candidates.append(part.split(",", 1)[1] if "," in part else part)

    matched = any(hmac.compare_digest(candidate, expected) for candidate in candidates)
    if not matched:
        raise WebhookSignatureError("invalid polar webhook signature")


class PolarProvider:
    name: Literal["polar"] = "polar"

    def __init__(
        self,
        *,
        access_token: str,
        webhook_secret: str,
        previous_webhook_secrets: list[str] | None = None,
        server: Literal["production", "sandbox"] = "production",
        api_base: str | None = None,
        logger: Logger | None = None,
        correlation_id: str | None = None,
    ) -> None:
        """`api_base` overrides the API host entirely (e.g. the local mock:
        "http://127.0.0.1:12213"). Takes precedence over `server`.
        `logger` — EC:L1 — logs one `provider.request` event per HTTP call (redacted — EC:L2).
        Defaults to NoopLogger. `correlation_id` — EC:L5 — overrides the correlationId logged for
        every `provider.request` event from this instance (otherwise falls back to the per-call
        Idempotency-Key header, as before). Prefer `with_correlation_id(id)` over passing this
        directly."""
        self._access_token = access_token
        self._webhook_secret = webhook_secret
        # EC:E20 -- secrets being rotated out; a stored webhook signed with one still re-verifies.
        self._previous_webhook_secrets = list(previous_webhook_secrets or [])
        self._base_url = api_base or SERVER_URLS[server]
        self._logger: Logger = logger or NoopLogger()
        self._correlation_id_override = correlation_id

    # EC:L5 -- a scoped clone carrying a fixed correlation_id for every `provider.request` log line
    # it emits. Not part of the PaymentProvider Protocol (duck-typed -- webhook.process checks for
    # it with `getattr(provider, "with_correlation_id", None)`), so this stays additive. A cheap
    # shallow copy is correct here because `_request` below is a normal instance method that reads
    # `self` at call time, not a closure bound at construction.
    def with_correlation_id(self, correlation_id: str) -> PolarProvider:
        clone = copy.copy(self)
        clone._correlation_id_override = correlation_id
        return clone

    # EC:L1 — one `provider.request` event per HTTP call, redacted (EC:L2) by the Logger implementation.
    async def _request(
        self,
        method: str,
        path: str,
        json_body: dict[str, Any] | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> Any:
        headers = {
            "Authorization": f"Bearer {self._access_token}",
            "Content-Type": "application/json",
        }
        if extra_headers:
            headers.update(extra_headers)
        correlation_id = self._correlation_id_override or (extra_headers or {}).get(
            "Idempotency-Key"
        )
        started_at = time.monotonic()
        status_code: int | None = None
        try:
            async with httpx.AsyncClient(
                base_url=self._base_url, timeout=30.0
            ) as client:
                res = await client.request(
                    method, path, json=json_body, headers=headers
                )
            status_code = res.status_code
            duration_ms = round((time.monotonic() - started_at) * 1000)
            if res.status_code >= 400:
                await self._logger.log(
                    {
                        "level": "warn",
                        "event": "provider.request",
                        "provider": "polar",
                        "method": method,
                        "path": path,
                        "status": status_code,
                        "durationMs": duration_ms,
                        "correlationId": correlation_id,
                        "providerErrorCode": "unknown",
                        "requestBody": json_body,
                        "responseBody": res.text,
                    }
                )
                raise ProviderError(
                    f"polar {method} {path} failed: {res.status_code}",
                    normalize_failure(message=res.text),
                    {"status": res.status_code, "body": res.text},
                    http_status=res.status_code,
                )
            result = None if (res.status_code == 204 or not res.content) else res.json()
            await self._logger.log(
                {
                    "level": "info",
                    "event": "provider.request",
                    "provider": "polar",
                    "method": method,
                    "path": path,
                    "status": status_code,
                    "durationMs": duration_ms,
                    "correlationId": correlation_id,
                    "providerErrorCode": None,
                    "requestBody": json_body,
                    "responseBody": result,
                }
            )
            return result
        except ProviderError:
            raise
        except Exception as err:
            duration_ms = round((time.monotonic() - started_at) * 1000)
            await self._logger.log(
                {
                    "level": "error",
                    "event": "provider.request",
                    "provider": "polar",
                    "method": method,
                    "path": path,
                    "status": status_code,
                    "durationMs": duration_ms,
                    "correlationId": correlation_id,
                    "providerErrorCode": "network_error",
                    "requestBody": json_body,
                    "error": str(err),
                }
            )
            raise

    def capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            native_subscriptions=True,
            partial_refund=True,
            meters=True,
            scheduling="provider",
            webhook_signature=True,
            upgrade_grant="on_payment",  # EC:A77
        )

    async def create_customer(
        self,
        *,
        email: str,
        name: str | None = None,
        metadata: dict[str, str] | None = None,
    ) -> dict[str, str]:
        customer = await self._request(
            "POST",
            "/v1/customers/",
            {"email": email, "name": name, "metadata": metadata},
        )
        return {"ref": customer["id"]}

    # EC:E6 — idempotency_key is best-effort (Polar API doesn't document idempotency header support)
    async def create_checkout(self, input: CreateCheckoutInput) -> Checkout:
        product_ref = (input.price.provider_price_refs or {}).get("polar")
        if not product_ref:
            raise PaymentKitError(
                f"set plan_prices.provider_price_refs for plan {input.plan.id} / "
                f"{input.price.currency} (see docs/GUIDE.md)",
                "missing_provider_price_ref",
                {"plan_id": input.plan.id},
            )
        metadata = {**(input.metadata or {}), "planId": input.plan.id}
        if input.affiliate_id:
            metadata["affiliateId"] = input.affiliate_id
        body: dict[str, Any] = {
            "products": [product_ref],
            "customer_id": input.customer_ref,
            "metadata": metadata,
            "success_url": input.success_url,
        }
        if input.allow_discount_codes:
            body["allow_discount_codes"] = True
        if input.preset_discount_code:
            body["discount_id"] = input.preset_discount_code
        checkout = await self._request(
            "POST",
            "/v1/checkouts/",
            body,
            {"Idempotency-Key": input.idempotency_key},
        )
        return Checkout(
            id=checkout["id"], url=checkout["url"], provider_ref=checkout["id"]
        )

    # EC:E7 E12
    async def get_payment(self, provider_ref: str) -> Payment:
        order = await self._request("GET", f"/v1/orders/{provider_ref}")
        return normalize_order(order)

    # EC:H4 E1 — Polar's list API has no `since` filter; filter client-side
    async def list_payments(
        self, *, customer_ref: str, since: datetime
    ) -> list[Payment]:
        res = await self._request(
            "GET", f"/v1/orders/?customer_id={customer_ref}&limit=100"
        )
        items = (res or {}).get("items", [])
        return [
            normalize_order(o) for o in items if _parse_dt(o.get("created_at")) >= since
        ]

    # EC:E3
    async def get_subscription(self, provider_ref: str) -> Subscription:
        sub = await self._request("GET", f"/v1/subscriptions/{provider_ref}")
        return normalize_subscription(sub)

    # EC:A1 — reset_anchor has no Polar equivalent; ignored (see spec)
    async def change_subscription(
        self,
        provider_ref: str,
        *,
        new_price_ref: str,
        proration: Literal["immediate", "none"],
        reset_anchor: bool,
    ) -> Subscription:
        sub = await self._request(
            "PATCH",
            f"/v1/subscriptions/{provider_ref}",
            {
                "product_id": new_price_ref,
                # EC:A77 -- "invoice" charges the difference now as its own order.
                "proration_behavior": "invoice"
                if proration == "immediate"
                else "next_period",
            },
        )
        return normalize_subscription(sub)

    # EC:A5
    async def cancel_subscription(
        self, provider_ref: str, *, at_period_end: bool
    ) -> Subscription:
        if at_period_end:
            sub = await self._request(
                "PATCH",
                f"/v1/subscriptions/{provider_ref}",
                {"cancel_at_period_end": True},
            )
        else:
            sub = await self._request("DELETE", f"/v1/subscriptions/{provider_ref}")
        return normalize_subscription(sub)

    # EC:A23 — undo cancel_at_period_end via the same PATCH endpoint change_subscription/
    # cancel_subscription use. Confirmed against Polar's docs (polar.sh/docs/features/
    # subscriptions/manage, 2026-09-09): uncancelling is a PATCH of cancel_at_period_end back to
    # False, and is rejected once the subscription has actually ended — there is no separate
    # uncancel endpoint. Pre-checks status so a fully-ended subscription raises our own
    # not_reactivatable (with the real Polar status) instead of surfacing whatever the PATCH errors.
    async def uncancel_subscription(self, provider_ref: str) -> Subscription:
        current = await self._request("GET", f"/v1/subscriptions/{provider_ref}")
        status = (current or {}).get("status")
        if status in ("canceled", "revoked"):
            raise PaymentKitError(
                f"polar subscription {provider_ref} is fully canceled and cannot be reactivated (status={status})",
                "not_reactivatable",
                {"id": provider_ref, "status": status},
            )
        sub = await self._request(
            "PATCH",
            f"/v1/subscriptions/{provider_ref}",
            {"cancel_at_period_end": False},
        )
        return normalize_subscription(sub)

    async def charge_billing_key(
        self,
        *,
        billing_key: str,
        amount: Money,
        order_id: str,
        customer_ref: str,
        idempotency_key: str,
    ) -> Payment:
        raise PaymentKitError(
            "billing key charge unsupported for polar (native subscriptions)",
            "unsupported",
        )

    # EC:D4 D6
    async def refund(
        self,
        *,
        payment_ref: str,
        amount: Money,
        reason: str,
        idempotency_key: str,
        extra: dict[str, Any] | None = None,
    ) -> Refund:
        refund = await self._request(
            "POST",
            "/v1/refunds/",
            {
                "order_id": payment_ref,
                "amount": amount.amount_minor,
                "reason": _map_refund_reason(reason),
            },
        )
        return normalize_refund(refund, "D4")

    # EC:C4
    async def report_usage(
        self,
        *,
        meter: str,
        customer_ref: str,
        quantity: int,
        occurred_at: datetime,
        idempotency_key: str,
    ) -> None:
        await self._request(
            "POST",
            "/v1/events/ingest",
            {
                "events": [
                    {
                        "name": meter,
                        "customer_id": customer_ref,
                        "timestamp": occurred_at.isoformat(),
                        "external_id": idempotency_key,
                        "metadata": {"value": quantity},
                    }
                ]
            },
        )

    # EC:E4 — manual Standard Webhooks verification (see spec "SDK 버전 불일치")
    async def verify_webhook(
        self,
        *,
        headers: dict[str, str],
        raw_body: str,
        received_at: datetime | None = None,
    ) -> NormalizedEvent:
        # EC:E20 -- the current secret first, then secrets being rotated out.
        last_error: WebhookSignatureError | None = None
        # EC:E21 -- rotated-out secrets only re-verify stored rows (received_at set), never new events.
        secrets = [self._webhook_secret, *self._previous_webhook_secrets] if received_at is not None else [self._webhook_secret]
        for secret in secrets:
            try:
                verify_standard_webhook_signature(
                    headers=headers, raw_body=raw_body, secret=secret, received_at=received_at
                )
                last_error = None
                break
            except WebhookSignatureError as err:
                last_error = err
        if last_error is not None:
            raise last_error
        try:
            parsed = json.loads(raw_body)
        except json.JSONDecodeError as err:
            raise WebhookSignatureError("invalid webhook payload json") from err
        return to_normalized_event(
            parsed, headers.get("webhook-id") or headers.get("WEBHOOK-ID")
        )
