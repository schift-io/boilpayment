"""boilpayment — Stripe provider.

spec: ../../spec/stripe.pseudo.md
Mirrors packages/providers/stripe/ts/src/index.ts exactly (function names, argument order,
return shape — camelCase <-> snake_case only).
"""

from __future__ import annotations

import time
import urllib.parse
import warnings
from datetime import UTC, datetime
from typing import Any, Literal

import stripe
import stripe._stripe_client as _stripe_client_module
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
    Refund,
    Subscription,
    WebhookSignatureError,
)


# EC:L1 — the Python stripe SDK has no per-call request() choke point either (each resource method
# calls into the SDK's internal api requestor), but `StripeClient(http_client=...)` accepts any
# object implementing `request_with_retries_async` (the one method the async requestor path
# actually calls — verified 2026-09-09 against stripe==15.6.1 `_api_requestor.py`). Wrapping the
# same default client `StripeClient.__init__` would have built itself (`stripe._stripe_client
# .new_default_http_client(async_fallback_client=new_http_client_async_fallback())` — read from
# `stripe._stripe_client.py` 2026-09-09) around that one method covers every call site without
# touching each of them individually, mirrors the ts adapter's `on('response')` hook, AND keeps this
# provider's own default-client selection identical to what stripe-python would have done unwrapped
# (tests/_fake_http.py's seam — which patches those same two names on `stripe._stripe_client` — still
# works because we look them up on the module at construction time, not via a stale import). Request
# bodies are Stripe's own urlencoded form strings (not a dict), so they're not structured enough for
# `redact()`'s key-based scrubbing — deliberately NOT logged rather than risking a leak; only the
# response body (a redactable dict) and request metadata are logged.
def _default_http_client() -> Any:
    return _stripe_client_module.new_default_http_client(
        async_fallback_client=_stripe_client_module.new_http_client_async_fallback()
    )


class _LoggingHTTPClient:
    name = "logging"

    # EC:L5 -- `correlation_id_override`, when set (via StripeProvider's `correlation_id` kwarg /
    # `with_correlation_id()`), wins over the per-request Idempotency-Key-derived value below.
    def __init__(
        self, inner: Any, logger: Logger, correlation_id_override: str | None = None
    ) -> None:
        self._inner = inner
        self._logger = logger
        self._correlation_id_override = correlation_id_override

    async def request_with_retries_async(
        self,
        method: str,
        url: str,
        headers: Any,
        post_data: Any = None,
        max_network_retries: int | None = None,
        *,
        _usage: Any = None,
    ) -> tuple[Any, int, Any]:
        path = urllib.parse.urlsplit(url).path
        correlation_id = self._correlation_id_override
        if correlation_id is None:
            for k, v in dict(headers or {}).items():
                if k.lower() == "idempotency-key":
                    correlation_id = v
                    break
        started_at = time.monotonic()
        try:
            (
                content,
                status_code,
                resp_headers,
            ) = await self._inner.request_with_retries_async(
                method,
                url,
                headers,
                post_data,
                max_network_retries=max_network_retries,
                _usage=_usage,
            )
            duration_ms = round((time.monotonic() - started_at) * 1000)
            body_text = (
                content.decode("utf-8", errors="replace")
                if isinstance(content, (bytes, bytearray))
                else content
            )
            await self._logger.log(
                {
                    "level": "warn" if status_code >= 400 else "info",
                    "event": "provider.request",
                    "provider": "stripe",
                    "method": method,
                    "path": path,
                    "status": status_code,
                    "durationMs": duration_ms,
                    "correlationId": correlation_id,
                    "providerErrorCode": "unknown" if status_code >= 400 else None,
                    "responseBody": body_text,
                }
            )
            return content, status_code, resp_headers
        except Exception as err:
            duration_ms = round((time.monotonic() - started_at) * 1000)
            await self._logger.log(
                {
                    "level": "error",
                    "event": "provider.request",
                    "provider": "stripe",
                    "method": method,
                    "path": path,
                    "status": None,
                    "durationMs": duration_ms,
                    "correlationId": correlation_id,
                    "providerErrorCode": "network_error",
                    "error": str(err),
                }
            )
            raise

    async def close_async(self) -> None:
        close = getattr(self._inner, "close_async", None)
        if close is not None:
            await close()


# suppress noisy deprecation warnings from StripeClient's legacy (non-v1) namespaces; we use client.v1.*
warnings.filterwarnings("ignore", category=DeprecationWarning, module="stripe")

NormalizedEventType = (
    str  # see core.types.NormalizedEventType (Literal) for the closed set
)

# EC:E12 — failure code normalization table (see spec §실패 코드 정규화)
FAILURE_MAP: dict[str, dict[str, Any]] = {
    "insufficient_funds": {
        "code": "insufficient_funds",
        "retryable": True,
        "user_message": "카드 잔액이 부족합니다. 다른 결제수단을 시도해 주세요.",
    },
    "card_declined": {
        "code": "card_declined",
        "retryable": False,
        "user_message": "카드가 거절되었습니다. 발급사에 문의하거나 다른 카드를 사용해 주세요.",
    },
    "expired_card": {
        "code": "expired_card",
        "retryable": False,
        "user_message": "카드가 만료되었습니다. 카드 정보를 업데이트해 주세요.",
    },
    "processing_error": {
        "code": "processing_error",
        "retryable": True,
        "user_message": "일시적인 처리 오류입니다. 잠시 후 다시 시도해 주세요.",
    },
    "incorrect_cvc": {
        "code": "incorrect_cvc",
        "retryable": True,
        "user_message": "CVC 번호가 올바르지 않습니다.",
    },
    "incorrect_number": {
        "code": "incorrect_number",
        "retryable": True,
        "user_message": "카드 번호가 올바르지 않습니다.",
    },
    "authentication_required": {
        "code": "authentication_required",
        "retryable": True,
        "user_message": "추가 인증이 필요합니다.",
    },
    "lost_card": {
        "code": "lost_card",
        "retryable": False,
        "user_message": "카드가 사용 정지되었습니다.",
    },
    "stolen_card": {
        "code": "stolen_card",
        "retryable": False,
        "user_message": "카드가 사용 정지되었습니다.",
    },
    "api_connection_error": {
        "code": "provider_unavailable",
        "retryable": True,
        "user_message": "PG사 연결 오류입니다. 잠시 후 다시 시도해 주세요.",
    },
    "api_error": {
        "code": "provider_unavailable",
        "retryable": True,
        "user_message": "PG사 오류입니다. 잠시 후 다시 시도해 주세요.",
    },
    "rate_limit_error": {
        "code": "provider_unavailable",
        "retryable": True,
        "user_message": "일시적으로 요청이 몰렸습니다. 잠시 후 다시 시도해 주세요.",
    },
}


# EC:E12 — normalize Stripe error -> PaymentFailure (pure)
def normalize_failure(
    *,
    code: str | None = None,
    decline_code: str | None = None,
    message: str | None = None,
) -> PaymentFailure:
    key = decline_code or code or ""
    mapped = FAILURE_MAP.get(key)
    if mapped:
        return PaymentFailure(
            code=mapped["code"],
            provider_code=key,
            retryable=mapped["retryable"],
            user_message=mapped["user_message"],
        )
    return PaymentFailure(
        code="unknown",
        provider_code=key or None,
        retryable=False,
        user_message=message or "결제 중 알 수 없는 오류가 발생했습니다.",
    )


def _money(amount_minor: int, currency: str) -> Money:
    return Money(amount_minor=amount_minor, currency=currency.upper())


def _dt(unix_ts: int) -> datetime:
    return datetime.fromtimestamp(unix_ts, tz=UTC)


# EC:E7 — PaymentIntent.status -> PaymentStatus
def _map_intent_status(status: str) -> str:
    if status == "succeeded":
        return "succeeded"
    if status in (
        "requires_action",
        "requires_confirmation",
        "requires_payment_method",
    ):
        return "requires_action"
    if status in ("processing", "requires_capture"):
        return "pending"
    if status == "canceled":
        return "failed"
    return "pending"


def _map_invoice_status(status: str | None) -> str:
    if status == "paid":
        return "succeeded"
    if status in ("open", "draft"):
        return "pending"
    if status in ("uncollectible", "void"):
        return "failed"
    return "pending"


def _invoice_period(invoice: Any) -> Period | None:
    lines = getattr(invoice, "lines", None)
    data = getattr(lines, "data", None) if lines else None
    if not data:
        return None
    period = (
        data[0].get("period")
        if isinstance(data[0], dict)
        else getattr(data[0], "period", None)
    )
    if not period:
        return None
    start = period["start"] if isinstance(period, dict) else period.start
    end = period["end"] if isinstance(period, dict) else period.end
    return Period(start=_dt(start), end=_dt(end))


def _failure_from_last_error(err: Any) -> PaymentFailure | None:
    if not err:
        return None
    code = err.get("code") if isinstance(err, dict) else getattr(err, "code", None)
    decline_code = (
        err.get("decline_code")
        if isinstance(err, dict)
        else getattr(err, "decline_code", None)
    )
    message = (
        err.get("message") if isinstance(err, dict) else getattr(err, "message", None)
    )
    return normalize_failure(code=code, decline_code=decline_code, message=message)


# EC:E7 E12 — normalize PaymentIntent -> Payment (pure)
def normalize_payment_intent(pi: Any, invoice: Any | None = None) -> Payment:
    kind = "subscription" if invoice is not None else "topup"
    subscription_id = None
    if invoice is not None:
        subscription_id = _invoice_subscription_ref(invoice)
    return Payment(
        id=pi.id,
        customer_id="",
        provider="stripe",
        provider_ref=pi.id,
        subscription_id=subscription_id,
        amount=_money(pi.amount, pi.currency),
        status=_map_intent_status(pi.status),
        kind=kind,
        period=_invoice_period(invoice) if invoice is not None else None,
        occurred_at=_dt(pi.created),
        failure=_failure_from_last_error(getattr(pi, "last_payment_error", None)),
        raw={
            **_as_dict(pi),
            "metadata": {
                **_as_dict(_get(pi, "metadata")),
                **_invoice_subscription_metadata(invoice),
            },
        }
        if invoice is not None
        else pi,
    )


# EC:F(Stripe) — normalize Invoice -> Payment (subscription kind, pure)
def normalize_invoice_as_payment(invoice: Any, pi: Any | None = None) -> Payment:
    status = _map_invoice_status(getattr(invoice, "status", None))
    failure = None
    if getattr(invoice, "status", None) == "open" and pi is not None:
        failure = _failure_from_last_error(getattr(pi, "last_payment_error", None))
    sub = _invoice_subscription_ref(invoice)
    return Payment(
        id=invoice.id,
        customer_id="",
        provider="stripe",
        provider_ref=invoice.id,
        subscription_id=sub if isinstance(sub, str) else None,
        amount=_money(invoice.amount_paid or invoice.amount_due, invoice.currency),
        status=status,
        kind="subscription",
        period=_invoice_period(invoice),
        occurred_at=_dt(invoice.created),
        failure=failure,
        raw={
            **_as_dict(invoice),
            "metadata": {
                **_as_dict(_get(invoice, "metadata")),
                **_invoice_subscription_metadata(invoice),
            },
        },
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


# EC:F(Stripe) — normalize Subscription (pure). See spec "계약 메모" for id/customer_id/plan_id sourcing.
def _as_dict(obj: Any) -> dict[str, Any]:
    """StripeObject (stripe-python >= 13) is neither iterable nor a Mapping; use to_dict()."""
    if obj is None:
        return {}
    if hasattr(obj, "to_dict"):
        return dict(obj.to_dict())
    if isinstance(obj, dict):
        return dict(obj)
    if hasattr(obj, "items"):
        return dict(obj.items())
    if hasattr(obj, "__dict__"):
        return {k: v for k, v in vars(obj).items() if not k.startswith("_")}
    return {}


def _ref_id(v: Any) -> str | None:
    if isinstance(v, str):
        return v
    if v is None:
        return None
    return v.get("id") if isinstance(v, dict) else getattr(v, "id", None)


def _invoice_subscription_ref(invoice: Any) -> str | None:
    details = _get(_get(invoice, "parent"), "subscription_details")
    return _ref_id(_get(details, "subscription") or _get(invoice, "subscription"))


def _invoice_subscription_metadata(invoice: Any) -> dict[str, Any]:
    details = _get(_get(invoice, "parent"), "subscription_details")
    metadata = _get(details, "metadata")
    if metadata is None:
        metadata = _get(_get(invoice, "subscription_details"), "metadata")
    return _as_dict(metadata)


def invoice_payment_intent_ref(invoice: Any) -> str | None:
    """Invoice -> PaymentIntent id. Legacy API: `invoice.payment_intent`;
    API >= 2025-03-31 (basil): `invoice.payments.data[].payment.payment_intent`."""
    legacy = _ref_id(getattr(invoice, "payment_intent", None))
    if legacy:
        return legacy
    payments = getattr(invoice, "payments", None)
    data = (
        payments.get("data")
        if isinstance(payments, dict)
        else getattr(payments, "data", None)
    )
    for p in data or []:
        pay = p.get("payment") if isinstance(p, dict) else getattr(p, "payment", None)
        ref = _ref_id(
            pay.get("payment_intent")
            if isinstance(pay, dict)
            else getattr(pay, "payment_intent", None)
        )
        if ref:
            return ref
    return None


def _subscription_period(sub: Any) -> tuple[int, int]:
    """Stripe API >= 2025-03-31 moved current_period_* from Subscription to SubscriptionItem. Read both."""
    start = _get(sub, "current_period_start")
    end = _get(sub, "current_period_end")
    if start is None or end is None:
        items = _get(sub, "items")
        data = _get(items, "data") if items is not None else None
        item = data[0] if data else None
        if item is not None:
            start = start if start is not None else _get(item, "current_period_start")
            end = end if end is not None else _get(item, "current_period_end")
    if not isinstance(start, int) or not isinstance(end, int):
        raise PaymentKitError(
            f"stripe subscription {_get(sub, 'id', '?')} has no current period (neither on subscription nor items[0])",
            "provider_shape",
        )
    return start, end


def normalize_subscription(sub: Any) -> Subscription:
    md = _as_dict(_get(sub, "metadata"))
    anchor_dt = _dt(_get(sub, "billing_cycle_anchor"))
    period_start, period_end = _subscription_period(sub)
    customer = _get(sub, "customer")
    customer_id = md.get("customerId") or (
        customer if isinstance(customer, str) else getattr(customer, "id", "")
    )
    return Subscription(
        id=md.get("subscriptionId") or _get(sub, "id"),
        customer_id=customer_id,
        plan_id=md.get("planId") or "",
        provider="stripe",
        provider_ref=_get(sub, "id"),
        status=SUB_STATUS.get(_get(sub, "status"), "expired"),
        current_period=Period(
            start=_dt(period_start),
            end=_dt(period_end),
        ),
        anchor_day=anchor_dt.day,
        cancel_at_period_end=bool(_get(sub, "cancel_at_period_end")),
        grace_until=None,
        billing_key=None,
        scheduled_plan_id=None,
        created_at=_dt(_get(sub, "created")),
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
    return "requested_by_customer"


# EC:D4 D6 — normalize Refund (pure)
def normalize_refund(refund: Any, customer_id: str, rule_id: str) -> Refund:
    pi = getattr(refund, "payment_intent", None)
    payment_id = pi if isinstance(pi, str) else getattr(pi, "id", "") if pi else ""
    failure = None
    if getattr(refund, "status", None) == "failed":
        failure = normalize_failure(
            code=getattr(refund, "failure_reason", None),
            message=getattr(refund, "failure_reason", None),
        )
    return Refund(
        id=refund.id,
        payment_id=payment_id,
        customer_id=customer_id,
        amount=_money(refund.amount, refund.currency),
        status=_map_refund_status(getattr(refund, "status", None)),
        provider_ref=refund.id,
        credits_revoked=0,
        rule_id=rule_id,
        reason=getattr(refund, "reason", None),
        failure=failure,
        created_at=_dt(refund.created),
    )


# EC:F(Stripe) — webhook event type mapping (pure)
def map_event_type(event: Any) -> str:
    t = event["type"] if isinstance(event, dict) else event.type
    obj = event["data"]["object"] if isinstance(event, dict) else event.data.object
    if t == "invoice.paid":
        return "payment.succeeded"
    if t == "invoice.payment_failed":
        return "subscription.payment_failed"
    if t == "checkout.session.completed":
        mode = obj.get("mode") if isinstance(obj, dict) else getattr(obj, "mode", None)
        return "subscription.created" if mode == "subscription" else "payment.succeeded"
    if t == "payment_intent.succeeded":
        invoice = (
            obj.get("invoice")
            if isinstance(obj, dict)
            else getattr(obj, "invoice", None)
        )
        return "unknown" if invoice else "payment.succeeded"
    if t == "payment_intent.payment_failed":
        return "payment.failed"
    if t == "customer.subscription.created":
        return "subscription.created"
    if t == "customer.subscription.updated":
        return "subscription.updated"
    if t == "customer.subscription.deleted":
        return "subscription.canceled"
    if t in (
        "refund.created",
        "refund.updated",
        "refund.failed",
        "charge.refund.updated",
    ):
        match _map_refund_status(_get(obj, "status")):
            case "succeeded":
                return "refund.created"
            case "failed":
                return "refund.failed"
            case _:
                return "refund.pending"
    if t == "charge.refunded":
        return "unknown"  # Charge totals are cumulative, not one refund operation.
    if t == "charge.dispute.created":
        return "dispute.opened"
    if t == "charge.dispute.closed":
        return "dispute.closed"
    return "unknown"


def _get(obj: Any, key: str, default: Any = None) -> Any:
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


# EC:F(Stripe) — event -> NormalizedEvent (pure)
def to_normalized_event(event: Any) -> NormalizedEvent:
    event_type = map_event_type(event)
    t = _get(event, "type")
    obj = _get(_get(event, "data"), "object")
    customer_ref: str | None = None
    subscription_ref: str | None = None
    payment_ref: str | None = None
    refund_ref: str | None = None
    amount: Money | None = None

    if t in ("invoice.paid", "invoice.payment_failed"):
        customer = _get(obj, "customer")
        customer_ref = customer if isinstance(customer, str) else _get(customer, "id")
        subscription_ref = _invoice_subscription_ref(obj)
        payment_ref = _get(obj, "id")
        amount = _money(
            _get(obj, "amount_paid") or _get(obj, "amount_due") or 0,
            _get(obj, "currency"),
        )
    elif t == "checkout.session.completed":
        customer = _get(obj, "customer")
        customer_ref = (
            customer if isinstance(customer, str) else _get(customer, "id")
        ) or _get(obj, "client_reference_id")
        sub = _get(obj, "subscription")
        subscription_ref = sub if isinstance(sub, str) else None
        pi = _get(obj, "payment_intent")
        payment_ref = pi if isinstance(pi, str) else _get(pi, "id")
        amount_total = _get(obj, "amount_total")
        if amount_total is not None:
            amount = _money(amount_total, _get(obj, "currency") or "usd")
    elif t in ("payment_intent.succeeded", "payment_intent.payment_failed"):
        customer = _get(obj, "customer")
        customer_ref = customer if isinstance(customer, str) else _get(customer, "id")
        payment_ref = _get(obj, "id")
        amount = _money(_get(obj, "amount"), _get(obj, "currency"))
    elif t in (
        "customer.subscription.created",
        "customer.subscription.updated",
        "customer.subscription.deleted",
    ):
        customer = _get(obj, "customer")
        customer_ref = customer if isinstance(customer, str) else _get(customer, "id")
        subscription_ref = _get(obj, "id")
    elif t in (
        "refund.created",
        "refund.updated",
        "refund.failed",
        "charge.refund.updated",
    ):
        refund_ref = _get(obj, "id")
        pi = _get(obj, "payment_intent")
        payment_ref = pi if isinstance(pi, str) else _get(pi, "id")
        amount = _money(_get(obj, "amount"), _get(obj, "currency"))
    elif t == "charge.refunded":
        customer = _get(obj, "customer")
        customer_ref = customer if isinstance(customer, str) else _get(customer, "id")
        pi = _get(obj, "payment_intent")
        payment_ref = pi if isinstance(pi, str) else _get(pi, "id")
        amount = _money(_get(obj, "amount_refunded"), _get(obj, "currency"))
    elif t in ("charge.dispute.created", "charge.dispute.closed"):
        pi = _get(obj, "payment_intent")
        payment_ref = pi if isinstance(pi, str) else _get(pi, "id")
        amount = _money(_get(obj, "amount"), _get(obj, "currency"))

    return NormalizedEvent(
        id=_get(event, "id"),
        provider="stripe",
        type=event_type,
        occurred_at=_dt(_get(event, "created")),
        customer_ref=customer_ref,
        subscription_ref=subscription_ref,
        payment_ref=payment_ref,
        refund_ref=refund_ref,
        amount=amount,
        raw=event,
    )


class StripeProvider:
    name: Literal["stripe"] = "stripe"

    def __init__(
        self,
        *,
        secret_key: str,
        webhook_secret: str,
        api_version: str | None = None,
        api_base: str | None = None,
        logger: Logger | None = None,
        correlation_id: str | None = None,
    ) -> None:
        """`api_base` overrides the API host, e.g. stripe-mock: "http://127.0.0.1:12111".
        `logger` — EC:L1 — logs one `provider.request` event per HTTP call (redacted — EC:L2).
        Defaults to NoopLogger. `correlation_id` — EC:L5 — overrides the correlationId logged for
        every `provider.request` event from this instance (otherwise falls back to the per-call
        Idempotency-Key header, as before). Prefer `with_correlation_id(id)` over passing this
        directly."""
        self._init_kwargs: dict[str, Any] = {
            "secret_key": secret_key,
            "webhook_secret": webhook_secret,
            "api_version": api_version,
            "api_base": api_base,
            "logger": logger,
        }
        kwargs: dict[str, Any] = {"api_key": secret_key}
        if api_version:
            kwargs["stripe_version"] = api_version
        if api_base:
            kwargs["base_addresses"] = {"api": api_base}
        self._logger: Logger = logger or NoopLogger()
        kwargs["http_client"] = _LoggingHTTPClient(
            _default_http_client(), self._logger, correlation_id
        )
        self._client = stripe.StripeClient(**kwargs)
        self._webhook_secret = webhook_secret

    # EC:L5 -- a scoped clone carrying a fixed correlation_id for every `provider.request` log line
    # it emits. Not part of the PaymentProvider Protocol (duck-typed -- webhook.process checks for
    # it with `getattr(provider, "with_correlation_id", None)`), so this stays additive: no change
    # to the shared core interface, no ripple into lifecycle/refund/credits/cs call sites.
    # Reconstructs the Stripe SDK client (cheap -- no network I/O at construction) because the
    # logging wrapper above is a fresh object per StripeClient, not a closure over a shared `self`.
    def with_correlation_id(self, correlation_id: str) -> StripeProvider:
        return StripeProvider(**{**self._init_kwargs, "correlation_id": correlation_id})

    def capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            native_subscriptions=True,
            partial_refund=True,
            meters=True,
            scheduling="provider",
            webhook_signature=True,
        )

    async def create_customer(
        self,
        *,
        email: str,
        name: str | None = None,
        metadata: dict[str, str] | None = None,
    ) -> dict[str, str]:
        customer = await self._client.v1.customers.create_async(
            {"email": email, "name": name, "metadata": metadata}
        )
        return {"ref": customer.id}

    # EC:E6 — idempotency_key passed through to Stripe request options
    async def create_checkout(self, input: CreateCheckoutInput) -> Checkout:
        price_ref = (input.price.provider_price_refs or {}).get("stripe")
        if not price_ref:
            raise PaymentKitError(
                "missing stripe price ref for plan price",
                "missing_provider_price_ref",
                {"plan_id": input.plan.id},
            )
        mode = "subscription" if input.mode == "subscription" else "payment"
        metadata = {**(input.metadata or {}), "planId": input.plan.id}
        params: dict[str, Any] = {
            "mode": mode,
            "client_reference_id": input.customer_ref,
            "customer": input.customer_ref,
            "line_items": [{"price": price_ref, "quantity": 1}],
            "success_url": input.success_url,
            "cancel_url": input.cancel_url,
            "metadata": metadata,
        }
        if mode == "subscription":
            params["subscription_data"] = {"metadata": metadata}
        else:
            params["payment_intent_data"] = {"metadata": metadata}
        session = await self._client.v1.checkout.sessions.create_async(
            params, options={"idempotency_key": input.idempotency_key}
        )
        return Checkout(id=session.id, url=session.url or "", provider_ref=session.id)

    # EC:E7 E12 — accepts pi_... or in_...
    async def get_payment(self, provider_ref: str) -> Payment:
        if provider_ref.startswith("in_"):
            # No expand=payment_intent: the field does not exist on API >= 2025-03-31 (would 400).
            invoice = await self._client.v1.invoices.retrieve_async(provider_ref)
            pi_ref = invoice_payment_intent_ref(invoice)
            pi = (
                await self._client.v1.payment_intents.retrieve_async(pi_ref)
                if pi_ref
                else None
            )
            return normalize_invoice_as_payment(invoice, pi)
        pi = await self._client.v1.payment_intents.retrieve_async(
            provider_ref, {"expand": ["invoice"]}
        )
        # `invoice` was removed from PaymentIntent in newer Stripe API versions -> guard the attribute.
        _inv = getattr(pi, "invoice", None)
        invoice = _inv if _inv is not None and not isinstance(_inv, str) else None
        return normalize_payment_intent(pi, invoice)

    # EC:H4 E1 — dedup invoices vs bare payment intents
    async def list_payments(
        self, *, customer_ref: str, since: datetime
    ) -> list[Payment]:
        gte = int(since.timestamp())
        invoices = await self._client.v1.invoices.list_async(
            {"customer": customer_ref, "created": {"gte": gte}}
        )
        invoice_pis: set[str] = set()
        payments: list[Payment] = []
        for inv in invoices.data:
            invoice_pis.add(invoice_payment_intent_ref(inv) or "")
            payments.append(normalize_invoice_as_payment(inv))
        intents = await self._client.v1.payment_intents.list_async(
            {"customer": customer_ref, "created": {"gte": gte}}
        )
        for pi in intents.data:
            if pi.id in invoice_pis:
                continue
            payments.append(normalize_payment_intent(pi, None))
        return payments

    # EC:E3 — re-fetch current state
    async def get_subscription(self, provider_ref: str) -> Subscription:
        sub = await self._client.v1.subscriptions.retrieve_async(provider_ref)
        return normalize_subscription(sub)

    # EC:A1 — proration + anchor reset
    async def change_subscription(
        self,
        provider_ref: str,
        *,
        new_price_ref: str,
        proration: Literal["immediate", "none"],
        reset_anchor: bool,
    ) -> Subscription:
        current = await self._client.v1.subscriptions.retrieve_async(provider_ref)
        item = (
            current["items"]["data"][0]
            if isinstance(current, dict)
            else current.items.data[0]
        )
        item_id = item["id"] if isinstance(item, dict) else item.id
        params: dict[str, Any] = {
            "items": [{"id": item_id, "price": new_price_ref}],
            "proration_behavior": "create_prorations"
            if proration == "immediate"
            else "none",
        }
        if reset_anchor:
            params["billing_cycle_anchor"] = "now"
        sub = await self._client.v1.subscriptions.update_async(provider_ref, params)
        return normalize_subscription(sub)

    # EC:A5
    async def cancel_subscription(
        self, provider_ref: str, *, at_period_end: bool
    ) -> Subscription:
        if at_period_end:
            sub = await self._client.v1.subscriptions.update_async(
                provider_ref, {"cancel_at_period_end": True}
            )
        else:
            sub = await self._client.v1.subscriptions.cancel_async(provider_ref)
        return normalize_subscription(sub)

    # EC:A23 — undo cancel_at_period_end. Stripe rejects an update on a subscription whose status
    # is already fully "canceled" (there's nothing left to un-set), so this pre-checks status and
    # raises our own not_reactivatable with the real Stripe status rather than surfacing a raw
    # Stripe API error to the caller.
    async def uncancel_subscription(self, provider_ref: str) -> Subscription:
        current = await self._client.v1.subscriptions.retrieve_async(provider_ref)
        status = _get(current, "status")
        if status == "canceled":
            raise PaymentKitError(
                f"stripe subscription {provider_ref} is fully canceled and cannot be reactivated (status={status})",
                "not_reactivatable",
                {"id": provider_ref, "status": status},
            )
        sub = await self._client.v1.subscriptions.update_async(
            provider_ref, {"cancel_at_period_end": False}
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
            "billing key charge unsupported for stripe (native subscriptions)",
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
        payment_intent_ref = payment_ref
        customer_id = ""
        if payment_ref.startswith("in_"):
            invoice = await self._client.v1.invoices.retrieve_async(payment_ref)
            pi_ref = invoice_payment_intent_ref(invoice)
            if not pi_ref:
                raise PaymentKitError(
                    f"invoice {payment_ref} has no payment intent to refund",
                    "provider_shape",
                )
            payment_intent_ref = pi_ref
            customer = invoice.customer
            customer_id = (
                customer
                if isinstance(customer, str)
                else (customer.id if customer else "")
            )
        refund = await self._client.v1.refunds.create_async(
            {
                "payment_intent": payment_intent_ref,
                "amount": amount.amount_minor,
                "reason": _map_refund_reason(reason),
            },
            options={"idempotency_key": idempotency_key},
        )
        return normalize_refund(refund, customer_id, "D4")

    # EC:C4 — outbox reports through here; local usage_events remains source of truth
    async def report_usage(
        self,
        *,
        meter: str,
        customer_ref: str,
        quantity: int,
        occurred_at: datetime,
        idempotency_key: str,
    ) -> None:
        await self._client.v1.billing.meter_events.create_async(
            {
                "event_name": meter,
                "payload": {"stripe_customer_id": customer_ref, "value": str(quantity)},
                "identifier": idempotency_key,
                "timestamp": int(occurred_at.timestamp()),
            }
        )

    # EC:E4
    async def verify_webhook(
        self,
        *,
        headers: dict[str, str],
        raw_body: str,
        received_at: datetime | None = None,
    ) -> NormalizedEvent:
        sig = headers.get("stripe-signature") or headers.get("Stripe-Signature")
        if not sig:
            raise WebhookSignatureError("missing stripe-signature header")
        try:
            # EC:E17 -- the Python SDK has no receivedAt: widen the 300 s tolerance by the time
            # elapsed since receipt, which is the same check measured at receipt.
            tolerance = 300
            if received_at is not None:
                tolerance += max(0, int(time.time() - received_at.timestamp()))
            event = stripe.Webhook.construct_event(
                raw_body, sig, self._webhook_secret, tolerance=tolerance
            )
        except Exception as err:  # stripe.SignatureVerificationError et al.
            raise WebhookSignatureError(str(err)) from err
        return to_normalized_event(event)
