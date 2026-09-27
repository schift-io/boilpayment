"""boilpayment — Toss Payments provider.

See spec/toss.pseudo.md for the full contract. Endpoints/enums verified against
docs.tosspayments.com/reference and docs.tosspayments.com/reference/using-api/webhook-events (2026-09).

Mirrors packages/providers/toss/ts/src/index.ts exactly (camelCase -> snake_case).
"""

from __future__ import annotations

import base64
import copy
import hashlib
import hmac
import ipaddress
import json
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta, timezone
from typing import Any, Literal
from urllib.parse import quote

import httpx
from boilpayment_core import (
    Checkout,
    CreateCheckoutInput,
    Logger,
    Money,
    NoopLogger,
    NormalizedEvent,
    NormalizedEventType,
    Payment,
    PaymentFailure,
    PaymentKitError,
    PaymentStatus,
    ProviderCapabilities,
    ProviderError,
    Refund,
    Subscription,
    WebhookSignatureError,
    money,  # EC:J8 -- safe-integer check at the provider boundary
)

BASE_URL = "https://api.tosspayments.com"


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


# ── pure normalizers (exported for smoke/unit use) ──────────────────────────


def normalize_toss_status(status: str) -> PaymentStatus:
    """EC:E8 — WAITING_FOR_DEPOSIT must map to pending; grants only happen on DONE."""
    if status in ("READY", "IN_PROGRESS", "WAITING_FOR_DEPOSIT"):
        return "pending"
    if status == "DONE":
        return "succeeded"
    if status == "CANCELED":
        return "refunded"
    if status == "PARTIAL_CANCELED":
        return "partially_refunded"
    if status in ("ABORTED", "EXPIRED"):
        return "failed"
    return "pending"


# EC:E9 pattern applied to Toss. Not exhaustive — unmapped codes fall back to
# {code: "unknown", retryable: False} and preserve provider_code for later extension.
_TOSS_FAILURE_MAP: dict[str, tuple[str, bool]] = {
    "REJECT_CARD_COMPANY": ("card_declined", True),
    "INVALID_STOPPED_CARD": ("card_declined", False),
    "RESTRICTED_TRANSFER_ACCOUNT": ("card_declined", False),
    "EXCEED_MAX_DAILY_PAYMENT_COUNT": ("card_declined", True),
    "INVALID_CARD_EXPIRATION": ("expired_card", False),
    "EXPIRED_CARD": ("expired_card", False),
    "NOT_ENOUGH_BALANCE": ("insufficient_funds", True),
    # Confirmed live 2026-09-09 against the real test API via `TossPayments-Test-Code:
    # REJECT_CARD_PAYMENT` (test_sk_ keys only) — real response body:
    # {"code":"REJECT_CARD_PAYMENT","message":"한도초과 혹은 잔액부족으로 결제에 실패했습니다."}.
    # Was previously unmapped (fell through to code='unknown', retryable=False) — real bug.
    "REJECT_CARD_PAYMENT": ("insufficient_funds", True),
    "EXCEED_MAX_PAYMENT_AMOUNT": ("card_declined", False),
    "INVALID_CARD_NUMBER": ("card_declined", False),
    "CARD_PROCESSING_ERROR": ("provider_unavailable", True),
    "FAILED_INTERNAL_SYSTEM_PROCESSING": ("provider_unavailable", True),
    "PROVIDER_ERROR": ("provider_unavailable", True),
    "EXCEED_MAX_ONE_DAY_WITHDRAW_AMOUNT": ("card_declined", False),
    "EXCEED_MAX_ONE_TIME_WITHDRAW_AMOUNT": ("card_declined", False),
}


def normalize_toss_failure(failure: dict[str, Any] | None) -> PaymentFailure | None:
    if not failure or not failure.get("code"):
        return None
    mapped = _TOSS_FAILURE_MAP.get(failure["code"])
    return PaymentFailure(
        code=mapped[0] if mapped else "unknown",
        provider_code=failure["code"],
        retryable=mapped[1] if mapped else False,
        user_message=failure.get("message") or "결제에 실패했습니다.",
    )


def normalize_toss_payment(raw: dict[str, Any]) -> Payment:
    """EC:F/E8/E9. `raw` is the Toss Payment object from confirm/get/billing responses."""
    status = normalize_toss_status(raw["status"])
    occurred = raw.get("approvedAt") or raw.get("requestedAt")
    return Payment(
        id=raw["paymentKey"],
        customer_id=raw.get("customerKey") or "",
        provider="toss",
        provider_ref=raw["paymentKey"],
        subscription_id=None,
        amount=money(
            amount_minor=raw["totalAmount"], currency=raw.get("currency") or "KRW"
        ),
        status=status,
        kind="subscription",
        period=None,
        occurred_at=_parse_dt(occurred),
        failure=normalize_toss_failure(raw.get("failure"))
        if status == "failed"
        else None,
        raw=raw,
    )


def _normalize_toss_refund(
    raw: dict[str, Any], *, payment_ref: str, amount: Money, reason: str
) -> Refund:
    cancels: list[dict[str, Any]] = raw.get("cancels") or []
    last = next((cancel for cancel in cancels if cancel.get("transactionKey") == raw.get("lastTransactionKey")), {})
    return Refund(
        id=last.get("transactionKey") or "",
        payment_id=raw["paymentKey"],
        # NOTE (contract gap — see spec "계약 변경 제안"): the provider adapter has no
        # access to our internal customer_id/rule_id. refund.execute must overwrite these.
        customer_id="",
        amount=money(
            amount_minor=last.get("cancelAmount", amount.amount_minor),
            currency=raw.get("currency") or amount.currency,
        ),
        status="succeeded" if last.get("cancelStatus") == "DONE" else "pending",
        provider_ref=last.get("transactionKey"),
        credits_revoked=0,
        rule_id="",
        reason=reason,
        failure=None,
        created_at=_parse_dt(last.get("canceledAt") or raw.get("approvedAt")),
    )


CashReceiptType = Literal["personal", "business"]
CashReceiptStatus = Literal["in_progress", "issued", "canceled", "failed"]



def _build_allowlist(entries: list[str]) -> list[ipaddress.IPv4Network | ipaddress.IPv6Network]:
    """EC:E22 -- addresses or CIDR blocks (IPv4/IPv6); anything else is refused at construction."""
    networks: list[ipaddress.IPv4Network | ipaddress.IPv6Network] = []
    for raw in entries:
        entry = raw.strip()
        try:
            networks.append(ipaddress.ip_network(entry, strict=False))
        except ValueError as exc:
            raise ValueError(f"toss allowed_webhook_ips: not an IP address or CIDR block: {raw}") from exc
    return networks


def _ip_allowed(networks: list[ipaddress.IPv4Network | ipaddress.IPv6Network], remote: str) -> bool:
    """EC:E22 -- a dual-stack socket reports an IPv4 peer as ::ffff:a.b.c.d; match it as IPv4."""
    try:
        addr: ipaddress.IPv4Address | ipaddress.IPv6Address = ipaddress.ip_address(remote)
    except ValueError:
        return False
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
        addr = addr.ipv4_mapped
    return any(addr.version == n.version and addr in n for n in networks)

@dataclass(kw_only=True, slots=True)
class CashReceiptFailure:
    code: str | None
    message: str | None


@dataclass(kw_only=True, slots=True)
class CashReceipt:
    """EC:K2 K3 K5 K6 — normalized cash receipt shape shared by issue/cancel/get."""

    receipt_key: str
    order_id: str
    type: CashReceiptType
    status: CashReceiptStatus
    amount: Money
    issue_number: str | None
    receipt_url: str | None
    failure: CashReceiptFailure | None
    raw: Any


def _to_toss_cash_receipt_type(type_: CashReceiptType) -> str:
    """EC:K3 — Toss `type` is the literal Korean string, not an enum code."""
    return "지출증빙" if type_ == "business" else "소득공제"


def _from_toss_cash_receipt_type(type_: str) -> CashReceiptType:
    return "business" if type_ == "지출증빙" else "personal"


def normalize_toss_cash_receipt(raw: dict[str, Any]) -> CashReceipt:
    """EC:K2 K5 K6. Confirmed live 2026-09-09 against the real Toss test API
    (POST /v1/cash-receipts, response fields: receiptKey/orderId/orderName/type/issueNumber/
    receiptUrl/businessNumber/transactionType/amount/taxFreeAmount/issueStatus/failure/
    customerIdentityNumber/requestedAt -- `issueStatus` observed value in test env was always
    `IN_PROGRESS`; `COMPLETED`/`FAILED` are documented but not observed live).
    `transactionType` distinguishes an issue response (`CONFIRM`) from a cancel response (`CANCEL`).
    """
    issue_status = str(raw.get("issueStatus") or "").upper()
    is_cancel = raw.get("transactionType") == "CANCEL"
    status: CashReceiptStatus
    if issue_status == "FAILED":
        status = "failed"
    elif is_cancel:
        status = "canceled"
    elif issue_status == "COMPLETED":
        status = "issued"
    else:
        status = "in_progress"
    failure = raw.get("failure")
    return CashReceipt(
        receipt_key=raw["receiptKey"],
        order_id=raw["orderId"],
        type=_from_toss_cash_receipt_type(raw.get("type", "")),
        status=status,
        amount=money(amount_minor=raw["amount"], currency="KRW"),
        issue_number=raw.get("issueNumber"),
        receipt_url=raw.get("receiptUrl"),
        failure=CashReceiptFailure(
            code=failure.get("code"), message=failure.get("message")
        )
        if failure
        else None,
        raw=raw,
    )


def map_toss_webhook(body: dict[str, Any]) -> NormalizedEvent:
    """EC:E3/E4 — normalizes the notification only; caller MUST re-fetch before acting."""
    event_type: str = body.get("eventType") or body.get("event_type") or "UNKNOWN"
    data = body.get("data") or {}
    cancellation = data if event_type == "CANCEL_STATUS_CHANGED" else next(
        (cancel for cancel in data.get("cancels", []) if cancel.get("transactionKey") == data.get("lastTransactionKey")), {}
    )
    normalized_type: NormalizedEventType = "unknown"
    if event_type in ("PAYMENT_STATUS_CHANGED", "DEPOSIT_CALLBACK"):
        status = data.get("status")
        if status == "DONE":
            normalized_type = "payment.succeeded"
        elif status in ("CANCELED", "PARTIAL_CANCELED"):
            normalized_type = "refund.created"
        elif status == "WAITING_FOR_DEPOSIT":
            normalized_type = "payment.pending"
        elif status in ("EXPIRED", "ABORTED"):
            normalized_type = "payment.failed"
    elif event_type == "CANCEL_STATUS_CHANGED":
        normalized_type = "refund.created" if data.get("cancelStatus") == "DONE" else "refund.pending"
    elif event_type == "BILLING_DELETED":
        normalized_type = "subscription.canceled"

    created_at = (
        body.get("createdAt") or data.get("approvedAt") or datetime.now(UTC).isoformat()
    )
    occurred_at = _parse_dt(created_at)
    # Kit compatibility rule: offset-free webhook times use Korea time, never host time.
    if occurred_at.tzinfo is None:
        occurred_at = occurred_at.replace(tzinfo=timezone(timedelta(hours=9)))
    amount = None
    amount_minor = cancellation.get("cancelAmount") if normalized_type.startswith("refund.") else data.get("totalAmount")
    currency = data.get("currency") if normalized_type.startswith("refund.") else data.get("currency", "KRW")
    if isinstance(amount_minor, (int, float)) and currency:
        # EC:J8 -- money() refuses a non-integer or unsafe amount (no silent int() truncation).
        amount = money(amount_minor=amount_minor, currency=currency)
    return NormalizedEvent(
        # Toss webhook bodies carry no unique event id; synthesize one. created_at is the
        # original event time so retries reuse the same value -> stable idempotency key.
        id=f"{event_type}:{data.get('paymentKey', 'na')}{':' + cancellation['transactionKey'] if cancellation.get('transactionKey') else ''}:{data.get('cancelStatus', data.get('status', 'na'))}:{created_at}",
        provider="toss",
        type=normalized_type,
        occurred_at=occurred_at,
        customer_ref=data.get("customerKey"),
        subscription_ref=None,
        payment_ref=data.get("paymentKey"),
        refund_ref=cancellation.get("transactionKey") if normalized_type.startswith("refund.") else None,
        amount=amount,
        raw=body,
    )


def _parse_dt(value: Any) -> datetime:
    if value is None:
        return datetime.now(UTC)
    if isinstance(value, datetime):
        return value
    text = str(value)
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return datetime.now(UTC)


# ── config / extra types ─────────────────────────────────────────────────────


@dataclass(kw_only=True, slots=True)
class TossProviderConfig:
    secret_key: str
    client_key: str | None = None
    allowed_webhook_ips: list[str] | None = (
        None  # EC:E4 variant — Toss webhooks are unsigned
    )
    # Overrides the API host, e.g. the local mock: "http://127.0.0.1:12211".
    # Defaults to the real Toss API.
    api_base: str | None = None
    # NOT part of normal operation. Injects the `TossPayments-Test-Code` header on every
    # request, which forces the real Toss test API to respond as if that failure occurred
    # (confirmed live 2026-09-09, e.g. REJECT_CARD_PAYMENT -> real
    # {"code":"REJECT_CARD_PAYMENT","message":"한도초과 혹은 잔액부족으로 결제에 실패했습니다."}) —
    # for exercising failure-path normalization against real Toss responses in
    # real_round_trip.py. Only works with test_sk_ keys; __init__ raises otherwise.
    test_code: str | None = None
    # EC:L1 — logs one `provider.request` event per HTTP call (redacted — EC:L2). Defaults to NoopLogger.
    logger: Logger | None = None
    # EC:L5 — overrides the correlationId logged for every `provider.request` event from this
    # instance (otherwise falls back to the per-call idempotency_key, as before). Prefer
    # `with_correlation_id(id)` over setting this directly.
    correlation_id: str | None = None


@dataclass(kw_only=True, slots=True)
class TossBillingKeyResult:
    billing_key: str
    customer_key: str
    raw: Any


class TossProvider:
    name = "toss"

    def __init__(
        self, config: TossProviderConfig, client: httpx.AsyncClient | None = None
    ):
        if config.test_code and not config.secret_key.startswith("test_sk_"):
            raise PaymentKitError(
                "test_code option requires a test_sk_ secret key", "test_keys_only"
            )
        self._secret_key = config.secret_key
        self.client_key = config.client_key
        self._allowed_webhook_ips = config.allowed_webhook_ips
        self._allowed_webhook_networks = _build_allowlist(config.allowed_webhook_ips or [])
        self._test_code = config.test_code
        self._logger: Logger = config.logger or NoopLogger()
        self._correlation_id_override = config.correlation_id
        self._client = client or httpx.AsyncClient(
            base_url=config.api_base or BASE_URL, timeout=30.0
        )

    # EC:L5 -- a scoped clone carrying a fixed correlation_id for every `provider.request` log line
    # it emits. Not part of the PaymentProvider Protocol (duck-typed -- webhook.process checks for
    # it with `getattr(provider, "with_correlation_id", None)`), so this stays additive. A cheap
    # shallow copy is correct here because `_request` below is a normal instance method that reads
    # `self` at call time, not a closure bound at construction (the shared httpx.AsyncClient is
    # fine to share between the clone and the original).
    def with_correlation_id(self, correlation_id: str) -> TossProvider:
        clone = copy.copy(self)
        clone._correlation_id_override = correlation_id
        return clone

    def capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            native_subscriptions=False,
            partial_refund=True,
            meters=False,
            scheduling="self",
            webhook_signature=False,
        )

    def _auth_header(self) -> str:
        token = base64.b64encode(f"{self._secret_key}:".encode()).decode("ascii")
        return f"Basic {token}"

    # EC:L1 — one `provider.request` event per HTTP call, redacted (EC:L2) by the Logger implementation.
    async def _request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        *,
        idempotency_key: str | None = None,
    ) -> Any:
        headers = {
            "Authorization": self._auth_header(),
            "Content-Type": "application/json",
        }
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        correlation_id = self._correlation_id_override or idempotency_key
        if self._test_code:
            headers["TossPayments-Test-Code"] = self._test_code
        started_at = time.monotonic()
        status_code: int | None = None
        try:
            res = await self._client.request(method, path, headers=headers, json=body)
            status_code = res.status_code
            try:
                data = res.json()
            except ValueError:
                data = {}
            duration_ms = round((time.monotonic() - started_at) * 1000)
            if res.is_error:
                failure = normalize_toss_failure(data) or PaymentFailure(
                    code="unknown",
                    provider_code=data.get("code"),
                    retryable=False,
                    user_message=data.get("message") or "toss api error",
                )
                await self._logger.log(
                    {
                        "level": "warn",
                        "event": "provider.request",
                        "provider": "toss",
                        "method": method,
                        "path": path,
                        "status": status_code,
                        "durationMs": duration_ms,
                        "correlationId": correlation_id,
                        "providerErrorCode": failure.code,
                        "requestBody": body,
                        "responseBody": data,
                    }
                )
                raise ProviderError(
                    data.get("message") or f"toss api error ({res.status_code})",
                    failure,
                    data,
                    http_status=res.status_code,
                )
            await self._logger.log(
                {
                    "level": "info",
                    "event": "provider.request",
                    "provider": "toss",
                    "method": method,
                    "path": path,
                    "status": status_code,
                    "durationMs": duration_ms,
                    "correlationId": correlation_id,
                    "providerErrorCode": None,
                    "requestBody": body,
                    "responseBody": data,
                }
            )
            return data
        except ProviderError:
            raise
        except Exception as err:
            duration_ms = round((time.monotonic() - started_at) * 1000)
            await self._logger.log(
                {
                    "level": "error",
                    "event": "provider.request",
                    "provider": "toss",
                    "method": method,
                    "path": path,
                    "status": status_code,
                    "durationMs": duration_ms,
                    "correlationId": correlation_id,
                    "providerErrorCode": "network_error",
                    "requestBody": body,
                    "error": str(err),
                }
            )
            raise

    async def create_customer(
        self,
        *,
        email: str,
        name: str | None = None,
        metadata: dict[str, str] | None = None,
    ) -> dict[str, str]:
        # EC:F — Toss has no customer object; customer_key is generated or supplied.
        provided = (metadata or {}).get("customerKey")
        if provided:
            return {"ref": provided}
        return {"ref": "cus_" + _sha256(email)[:40]}

    async def create_checkout(self, input: CreateCheckoutInput) -> Checkout:
        if input.price.currency != "KRW":
            raise PaymentKitError(
                f"toss only supports KRW, got {input.price.currency}",
                "currency_unsupported",
            )  # EC:E10
        order_id = (
            "ord_" + _sha256(input.idempotency_key)[:40]
        )  # EC:E6 — double-click reuses same order
        sep = "&" if "?" in input.success_url else "?"
        url = f"{input.success_url}{sep}orderId={order_id}&amount={input.price.amount_minor}"
        return Checkout(id=order_id, url=url, provider_ref=order_id)

    async def confirm_payment(
        self, *, payment_key: str, order_id: str, amount: int
    ) -> Payment:
        """Extra method (not in core PaymentProvider) — EC:E13, server-side confirm is mandatory."""
        raw = await self._request(
            "POST",
            "/v1/payments/confirm",
            {"paymentKey": payment_key, "orderId": order_id, "amount": amount},
        )
        return normalize_toss_payment(raw)

    async def issue_billing_key(
        self, *, auth_key: str, customer_key: str
    ) -> TossBillingKeyResult:
        """Extra method — EC:F billing key issuance."""
        raw = await self._request(
            "POST",
            "/v1/billing/authorizations/issue",
            {"authKey": auth_key, "customerKey": customer_key},
        )
        return TossBillingKeyResult(
            billing_key=raw["billingKey"], customer_key=raw["customerKey"], raw=raw
        )

    async def issue_billing_key_by_card(
        self,
        *,
        customer_key: str,
        card_number: str,
        card_expiration_year: str,
        card_expiration_month: str,
        customer_identity_number: str,
        card_password: str | None = None,
        customer_name: str | None = None,
        customer_email: str | None = None,
    ) -> TossBillingKeyResult:
        """Extra method — NOT part of the PaymentProvider contract. Test-mode-only escape
        hatch for paykit live (examples/live/real_round_trip.py): issues a billing key
        directly from raw card fields (POST /v1/billing/authorizations/card), skipping the
        widget/browser auth_key flow. Per Toss docs (docs.tosspayments.com/guides/v2/billing/
        integration-api, fetched 2026-09-09): in the test environment only the card's first
        six digits (BIN) need to be valid — the rest can be arbitrary, and card_password can
        be omitted entirely (confirmed live 2026-09-09: a real billing key was issued without
        it). Not every BIN classifies to a chargeable card type in the test environment
        though — BIN 490625 (BC, confirmed live 2026-09-09) issues a billing key that
        chargeBillingKey can actually charge; some other BINs issue a key that later fails
        chargeBillingKey with a real NOT_SUPPORTED_CARD_TYPE error. Guarded to test_sk_ keys.
        """
        if not self._secret_key.startswith("test_sk_"):
            raise PaymentKitError(
                "issue_billing_key_by_card refuses to run against a non-test secret key",
                "test_keys_only",
            )
        raw = await self._request(
            "POST",
            "/v1/billing/authorizations/card",
            {
                "customerKey": customer_key,
                "cardNumber": card_number,
                "cardExpirationYear": card_expiration_year,
                "cardExpirationMonth": card_expiration_month,
                "customerIdentityNumber": customer_identity_number,
                "cardPassword": card_password,
                "customerName": customer_name,
                "customerEmail": customer_email,
            },
        )
        return TossBillingKeyResult(
            billing_key=raw["billingKey"], customer_key=raw["customerKey"], raw=raw
        )

    async def charge_billing_key(
        self,
        *,
        billing_key: str,
        amount: Money,
        order_id: str,
        customer_ref: str,
        idempotency_key: str,
    ) -> Payment:
        raw = await self._request(
            "POST",
            f"/v1/billing/{billing_key}",
            {
                "customerKey": customer_ref,
                "amount": amount.amount_minor,
                "orderId": order_id,
                "orderName": "Subscription charge",
            },
            idempotency_key=idempotency_key,
        )
        return normalize_toss_payment(raw)

    async def get_payment(self, provider_ref: str) -> Payment:
        raw = await self._request("GET", f"/v1/payments/{provider_ref}")
        return normalize_toss_payment(raw)

    async def get_payment_by_order_id(self, order_id: str) -> Payment | None:
        """EC:A38 -- look an order up by the orderId the kit sent, without charging. 404 = none."""
        try:
            raw = await self._request("GET", f"/v1/payments/orders/{quote(order_id, safe='')}")
        except ProviderError as err:
            # EC:A52 -- only Toss's own NOT_FOUND_PAYMENT means "no such order"; any other 404 is an error.
            details = err.details if isinstance(err.details, dict) else {}
            if getattr(err, "http_status", None) == 404 and details.get("code") == "NOT_FOUND_PAYMENT":
                return None
            raise
        return normalize_toss_payment(raw)

    async def list_payments(
        self, *, customer_ref: str, since: datetime
    ) -> list[Payment]:
        # EC:H4 — Toss has no list-by-customer API. Best-effort via /v1/transactions;
        # matches only when the transaction row happens to carry customerKey. See spec.
        start_date = since.isoformat()
        # EC:A67 -- endDate is rounded up to the next second (a payment approved in the same second is kept).
        end_date = (datetime.now(UTC).replace(microsecond=0) + timedelta(seconds=1)).isoformat()
        raw = await self._request(
            "GET", f"/v1/transactions?startDate={start_date}&endDate={end_date}"
        )
        items: list[dict[str, Any]] = (
            raw if isinstance(raw, list) else raw.get("transactions", [])
        )
        matched = [t for t in items if t.get("customerKey") == customer_ref]
        # BUG FIX (found via live mock round trip): /v1/transactions rows are TransactionDto, not
        # Payment — field names differ (`amount`/`transactionAt` vs `totalAmount`/`approvedAt`).
        # Calling normalize_toss_payment directly on a transaction row raised KeyError on
        # "totalAmount". Remap to Payment-object field names first.
        return [
            normalize_toss_payment(
                {
                    "paymentKey": t.get("paymentKey"),
                    "customerKey": t.get("customerKey"),
                    "totalAmount": t.get("amount"),
                    "currency": t.get("currency"),
                    "status": t.get("status"),
                    "approvedAt": t.get("transactionAt"),
                    "requestedAt": t.get("transactionAt"),
                    "failure": None,
                }
            )
            for t in matched
        ]

    async def get_subscription(self, provider_ref: str) -> Subscription:
        # See spec/toss.pseudo.md "계약 변경 제안" — cannot fabricate Subscription fields.
        raise PaymentKitError(
            "toss has no native subscription; read from Repo.subscriptions",
            "unsupported",
        )

    async def change_subscription(
        self,
        provider_ref: str,
        *,
        new_price_ref: str,
        proration: str,
        reset_anchor: bool,
    ) -> Subscription:
        raise PaymentKitError(
            "toss has no native subscription; self-scheduler manages plan changes via Repo",
            "unsupported",
        )

    async def cancel_subscription(
        self, provider_ref: str, *, at_period_end: bool
    ) -> Subscription:
        raise PaymentKitError(
            "toss has no native subscription; self-scheduler manages cancellation via Repo",
            "unsupported",
        )

    # EC:A23 — same reasoning as get_subscription/change_subscription/cancel_subscription above.
    async def uncancel_subscription(self, provider_ref: str) -> Subscription:
        raise PaymentKitError(
            "toss has no native subscription; self-scheduler manages cancellation via Repo",
            "unsupported",
        )

    async def refund(
        self,
        *,
        payment_ref: str,
        amount: Money,
        reason: str,
        idempotency_key: str,
        extra: dict[str, Any] | None = None,
    ) -> Refund:
        raw_payment = await self._request("GET", f"/v1/payments/{payment_ref}")
        method = str(raw_payment.get("method") or "")
        extra = extra or {}
        if "가상계좌" in method and not extra.get("refundReceiveAccount"):
            raise PaymentKitError(
                "refundReceiveAccount required for Toss virtual account refunds",
                "refund_receive_account_required",
            )  # EC:D13
        body: dict[str, Any] = {"cancelReason": reason}
        if amount:
            body["cancelAmount"] = amount.amount_minor  # EC:D4 partial refund
        if extra.get("refundReceiveAccount"):
            body["refundReceiveAccount"] = extra["refundReceiveAccount"]
        raw = await self._request(
            "POST",
            f"/v1/payments/{payment_ref}/cancel",
            body,
            idempotency_key=idempotency_key,
        )
        return _normalize_toss_refund(
            raw, payment_ref=payment_ref, amount=amount, reason=reason
        )

    async def get_refund(self, *, payment_ref: str, refund_ref: str) -> Refund | None:
        raw = await self._request("GET", f"/v1/payments/{payment_ref}")
        cancellation = next((cancel for cancel in raw.get("cancels", []) if cancel.get("transactionKey") == refund_ref), None)
        if cancellation is None:
            return None
        return _normalize_toss_refund(
            {**raw, "lastTransactionKey": refund_ref}, payment_ref=payment_ref,
            amount=money(amount_minor=cancellation["cancelAmount"], currency=raw.get("currency") or "KRW"),
            reason=cancellation.get("cancelReason", ""),
        )

    async def issue_cash_receipt(
        self,
        *,
        payment_ref: str,
        type: CashReceiptType,
        customer_identity_number: str,
        order_name: str | None = None,
        tax_free_amount_minor: int | None = None,
    ) -> CashReceipt:
        """Extra method (not in core PaymentProvider) -- EC:K2 K3 K4. `POST /v1/cash-receipts`.

        Confirmed live 2026-09-09 against the real Toss test API (test_sk_ key): this endpoint is
        a standalone "수동 발급" (manual issuance) resource -- it does NOT itself validate that the
        given `orderId` belongs to an existing cash-eligible payment (a bare `orderId` with no
        matching payment issued successfully, HTTP 200). So the card-payment exclusion (EC:K4)
        MUST be enforced here, client-side, by re-fetching the payment and checking `method` --
        the provider will not reject it for us.
        """
        raw_payment = await self._request("GET", f"/v1/payments/{payment_ref}")
        method = str(raw_payment.get("method") or "")
        if "카드" in method:
            # EC:K4 -- card payments are not cash-receipt eligible (card sales slips serve that role).
            raise PaymentKitError(
                f"cash receipts are not issuable for card payments (payment_ref={payment_ref}, method={method})",
                "cash_receipt_unsupported_for_payment_method",
            )
        body: dict[str, Any] = {
            "orderId": raw_payment.get("orderId"),
            "orderName": order_name or raw_payment.get("orderName") or "Payment",
            "amount": raw_payment.get("totalAmount"),
            "type": _to_toss_cash_receipt_type(type),
            "customerIdentityNumber": customer_identity_number,
        }
        if tax_free_amount_minor:
            body["taxFreeAmount"] = tax_free_amount_minor
        raw = await self._request("POST", "/v1/cash-receipts", body)
        return normalize_toss_cash_receipt(raw)

    async def cancel_cash_receipt(
        self, *, receipt_key: str, amount_minor: int | None = None
    ) -> CashReceipt:
        """Extra method -- EC:K5 K6. `POST /v1/cash-receipts/{receiptKey}/cancel`. Confirmed live
        2026-09-09: omitting `amount` cancels the receipt in full; passing `amount` does a partial
        cancel (mirrors the payment-cancel endpoint's `cancelAmount` semantics, EC:D4).
        """
        body: dict[str, Any] = {}
        if amount_minor is not None:
            body["amount"] = amount_minor
        raw = await self._request(
            "POST", f"/v1/cash-receipts/{receipt_key}/cancel", body
        )
        return normalize_toss_cash_receipt(raw)

    async def get_cash_receipt(
        self, *, order_id: str, request_date: str
    ) -> CashReceipt | None:
        """Extra method -- EC:K7 duplicate-issuance guard support. Toss has no `GET` by
        `receiptKey` (confirmed live 2026-09-09: `GET /v1/cash-receipts/{receiptKey}` 404s as an
        unrouted path, not a Toss-shaped error) -- the only lookup is
        `GET /v1/cash-receipts?requestDate=yyyy-MM-dd` (list-by-date, confirmed live:
        `requestDate` is required, `startDate`/`endDate` are rejected as INVALID_REQUEST). This
        filters that list client-side by `orderId`. NOTE: with the given public test key this
        list call itself real-404s with `NOT_FOUND_MERCHANT_BUSINESS_NUMBER` (confirmed live
        2026-09-09) because the shared test merchant has no registered business number -- the
        endpoint shape is verified, a successful list response is not.
        """
        raw = await self._request(
            "GET", f"/v1/cash-receipts?requestDate={request_date}"
        )
        items: list[dict[str, Any]] = (
            raw
            if isinstance(raw, list)
            else raw.get("data") or raw.get("cashReceipts") or []
        )
        match = next((c for c in items if c.get("orderId") == order_id), None)
        return normalize_toss_cash_receipt(match) if match else None

    async def report_usage(
        self,
        *,
        meter: str,
        customer_ref: str,
        quantity: int,
        occurred_at: datetime,
        idempotency_key: str,
    ) -> None:
        raise PaymentKitError(
            "toss has no meters API", "unsupported"
        )  # capabilities().meters is False

    async def verify_webhook(
        self,
        *,
        headers: dict[str, str],
        raw_body: str,
        received_at: datetime | None = None,
        remote_address: str | None = None,
    ) -> NormalizedEvent:
        body = json.loads(raw_body)
        # EC:E4 E18 -- Toss webhooks carry no signature. Origin checks run at receipt (no
        # received_at); webhook.process re-verifies a stored row that already passed them.
        at_receipt = received_at is None
        # EC:E19 -- with no signature, the source address is the only origin proof: no allowlist
        # means every sender is accepted (a forged DONE notification was enough), so receipt fails
        # closed.
        if at_receipt and not self._allowed_webhook_ips:
            raise WebhookSignatureError("toss webhook ip allowlist is not configured (allowed_webhook_ips)")
        # The peer address the app read from its socket. A request header (x-paykit-remote-ip,
        # x-forwarded-for) is client-controlled and is never used.
        if (
            at_receipt
            and self._allowed_webhook_ips
            and (not remote_address or not _ip_allowed(self._allowed_webhook_networks, remote_address))
        ):
            raise WebhookSignatureError(
                f"toss webhook ip not allowed: {remote_address or 'unknown'}"
            )
        # EC:E18 -- a virtual-account DEPOSIT_CALLBACK is genuine only when its `secret` equals the
        # one Toss returned on that payment (Toss docs: webhook-events, DEPOSIT_CALLBACK.secret).
        event_type = body.get("eventType") or body.get("event_type")
        # EC:E19 -- a DEPOSIT_CALLBACK without its secret cannot be checked, so it is refused.
        if at_receipt and event_type == "DEPOSIT_CALLBACK" and not isinstance(body.get("secret"), str):
            raise WebhookSignatureError("toss deposit callback without secret")
        if at_receipt and isinstance(body.get("secret"), str):
            order_id = body.get("orderId") or (body.get("data") or {}).get("orderId")
            if not order_id:
                raise WebhookSignatureError("toss deposit callback without orderId")
            payment = await self._request("GET", f"/v1/payments/orders/{quote(str(order_id), safe='')}")
            stored = payment.get("secret") if isinstance(payment, dict) else None
            if not isinstance(stored, str) or not hmac.compare_digest(
                stored.encode(), body["secret"].encode()
            ):
                raise WebhookSignatureError("toss deposit callback secret mismatch")
        return map_toss_webhook(body)  # EC:E3 — caller must re-fetch before acting
