"""boilpayment — PortOne V2 provider.

See spec/portone.pseudo.md for the full contract. Endpoints/request-response shapes
verified 2026-09-09 against the real V2 OpenAPI spec (portone-io/server-sdk repo,
codegen/openapi.json — the developers.portone.io site itself is JS-rendered and did not
yield full schemas via fetch, so the raw OpenAPI source was used instead) and the
Standard Webhooks spec. This resolved two previously-"unverified" endpoints and surfaced
three additional real bugs in this module — see inline NOTE comments at
normalize_portone_status, issue_billing_key, charge_billing_key, schedule_payment,
cancel_schedules, and list_payments.

Mirrors packages/providers/portone/ts/src/index.ts exactly (camelCase -> snake_case).
"""

from __future__ import annotations

import base64
import binascii
import copy
import hashlib
import hmac
import json
import time
import urllib.parse
from dataclasses import dataclass
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
)

BASE_URL = "https://api.portone.io"


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


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


# ── pure normalizers (exported for smoke/unit use) ──────────────────────────


def normalize_portone_status(status: str) -> PaymentStatus:
    """EC:E8 — VIRTUAL_ACCOUNT_ISSUED must map to pending; grants only happen on PAID.

    Status literals verified against the real V2 OpenAPI spec (Payment discriminator:
    CANCELLED | FAILED | PAID | PARTIAL_CANCELLED | PAY_PENDING | READY |
    VIRTUAL_ACCOUNT_ISSUED) — the in-flight status is ``PAY_PENDING``, not ``PENDING`` as
    an earlier draft of this module assumed.
    """
    if status in ("READY", "PAY_PENDING", "VIRTUAL_ACCOUNT_ISSUED"):
        return "pending"
    if status == "PAID":
        return "succeeded"
    if status == "FAILED":
        return "failed"
    if status == "CANCELLED":
        return "refunded"
    if status == "PARTIAL_CANCELLED":
        return "partially_refunded"
    return "pending"


def normalize_portone_failure(failure: dict[str, Any] | None) -> PaymentFailure | None:
    """EC:E9 — many PGs behind PortOne, each with its own failure codes. Heuristic only."""
    if not failure:
        return None
    pg_code = str(failure.get("pgCode") or "").upper()
    code = "unknown"
    retryable = False
    if "INSUFFICIENT" in pg_code:
        code = "insufficient_funds"
    elif "EXPIRED" in pg_code:
        code = "expired_card"
    elif "DECLINE" in pg_code or "REJECT" in pg_code:
        code = "card_declined"
    elif "TIMEOUT" in pg_code or "NETWORK" in pg_code or "UNAVAILABLE" in pg_code:
        code = "provider_unavailable"
        retryable = True
    return PaymentFailure(
        code=code,
        provider_code=failure.get("pgCode"),
        retryable=retryable,
        user_message=failure.get("pgMessage")
        or failure.get("reason")
        or "결제에 실패했습니다.",
    )


def normalize_portone_payment(raw: dict[str, Any]) -> Payment:
    """EC:F/E8/E9. `raw` is the PortOne V2 Payment object."""
    status = normalize_portone_status(raw["status"])
    amount = raw.get("amount") or {}
    total = amount.get("total") if isinstance(amount, dict) else amount
    occurred = raw.get("paidAt") or raw.get("requestedAt")
    return Payment(
        id=raw.get("id") or raw.get("paymentId"),
        customer_id=(raw.get("customer") or {}).get("id") or "",
        provider="portone",
        provider_ref=raw.get("id") or raw.get("paymentId"),
        subscription_id=None,
        amount=Money(amount_minor=total, currency=raw.get("currency") or "KRW"),
        status=status,
        kind="subscription",
        period=None,
        occurred_at=_parse_dt(occurred),
        failure=normalize_portone_failure(raw.get("failure"))
        if status == "failed"
        else None,
        raw=raw,
    )


def _normalize_portone_refund(
    raw: dict[str, Any], *, payment_ref: str, amount: Money, reason: str
) -> Refund:
    cancellation = raw.get("cancellation") or raw
    return Refund(
        id=cancellation.get("id") or "",
        payment_id=payment_ref,
        # NOTE (contract gap — see spec "계약 변경 제안"): customer_id/rule_id unknown to the
        # provider adapter. refund.execute must overwrite these before persisting.
        customer_id="",
        amount=Money(
            amount_minor=cancellation.get(
                "totalAmount", cancellation.get("amount", amount.amount_minor)
            ),
            currency=amount.currency,
        ),
        status="succeeded" if cancellation.get("status") == "SUCCEEDED" else "failed" if cancellation.get("status") == "FAILED" else "pending",
        provider_ref=cancellation.get("id"),
        credits_revoked=0,
        rule_id="",
        reason=reason,
        failure=None,
        created_at=_parse_dt(cancellation.get("cancelledAt") or cancellation.get("requestedAt")),
    )


CashReceiptType = Literal["personal", "business"]
CashReceiptStatus = Literal["issued", "issue_failed", "canceled"]


@dataclass(kw_only=True, slots=True)
class CashReceipt:
    """EC:K2 K3 K5 K6 — normalized cash receipt shape shared by issue/cancel/get."""

    payment_ref: str
    type: CashReceiptType | None
    status: CashReceiptStatus
    amount: Money | None
    issue_number: str | None
    receipt_url: str | None
    raw: Any


def normalize_portone_cash_receipt(raw: dict[str, Any]) -> CashReceipt:
    """EC:K2 K3 K5 K6 K7. `raw` is a PortOne V2 CashReceipt (oneOf IssuedCashReceipt /
    IssueFailedCashReceipt / CancelledCashReceipt, discriminated by `status`) -- confirmed against
    the real V2 OpenAPI spec (portone-io/server-sdk `codegen/openapi.json`, 2026-09-09; not
    exercised against the live API -- see `issue_cash_receipt`/`get_cash_receipt` doc comments).
    """
    status_raw = raw.get("status")
    status: CashReceiptStatus = (
        "canceled"
        if status_raw == "CANCELLED"
        else "issue_failed"
        if status_raw == "ISSUE_FAILED"
        else "issued"
    )
    amount_raw = raw.get("amount")
    type_raw = raw.get("type")
    return CashReceipt(
        payment_ref=raw.get("paymentId", ""),
        type="business"
        if type_raw == "CORPORATE"
        else "personal"
        if type_raw == "PERSONAL"
        else None,
        status=status,
        amount=Money(amount_minor=amount_raw, currency=raw.get("currency") or "KRW")
        if isinstance(amount_raw, (int, float))
        else None,
        issue_number=raw.get("issueNumber"),
        receipt_url=raw.get("url"),
        raw=raw,
    )


def map_portone_webhook(body: dict[str, Any]) -> NormalizedEvent:
    """EC:E3/E4 — normalizes the notification only; caller MUST re-fetch before acting."""
    event_type: str = body.get("type") or "unknown"
    data = body.get("data") or {}
    normalized_type: NormalizedEventType = "unknown"
    if event_type == "Transaction.Paid":
        normalized_type = "payment.succeeded"
    elif event_type == "Transaction.Failed":
        normalized_type = "payment.failed"
    elif event_type in ("Transaction.Cancelled", "Transaction.PartialCancelled"):
        normalized_type = "refund.created"
    elif event_type in (
        "Transaction.VirtualAccountIssued",
        "Transaction.PayPending",
    ):
        normalized_type = "payment.pending"
    elif event_type == "Transaction.CancelPending":
        normalized_type = "refund.pending"
    elif event_type == "Transaction.DisputeCreated":
        normalized_type = "dispute.opened"
    elif event_type == "Transaction.DisputeResolved":
        normalized_type = "dispute.closed"
    # else: includes BillingKey.* — logged, not acted on (per brief)

    timestamp = body.get("timestamp") or datetime.now(UTC).isoformat()
    return NormalizedEvent(
        # Overwritten with headers["webhook-id"] by verify_webhook (the true Standard
        # Webhooks message id). This fallback is only used when mapping raw bodies directly.
        id=f"{event_type}:{data.get('paymentId', data.get('billingKey', 'na'))}{':' + data['cancellationId'] if data.get('cancellationId') else ''}:{timestamp}",
        provider="portone",
        type=normalized_type,
        occurred_at=_parse_dt(timestamp),
        customer_ref=None,
        subscription_ref=None,
        payment_ref=data.get("paymentId"),
        refund_ref=data.get("cancellationId") if normalized_type.startswith("refund.") else None,
        amount=None,
        raw=body,
    )


# ── config / extra types ─────────────────────────────────────────────────────


@dataclass(kw_only=True, slots=True)
class PortoneProviderConfig:
    api_secret: str
    store_id: str
    webhook_secret: str  # "whsec_..." per Standard Webhooks
    channel_key: str | None = None
    scheduling: Literal["provider", "self"] = "provider"
    # Override the API host, e.g. the local mock: "http://127.0.0.1:12212". Only used when
    # no explicit `client` is passed to PortoneProvider(). Defaults to https://api.portone.io.
    api_base: str | None = None
    # EC:L1 — logs one `provider.request` event per HTTP call (redacted — EC:L2). Defaults to NoopLogger.
    logger: Logger | None = None
    # EC:L5 — the only source of correlationId for `provider.request` log lines (`_request` has no
    # per-call idempotency_key threaded in). Prefer `with_correlation_id(id)` over setting directly.
    correlation_id: str | None = None


class PortoneProvider:
    name = "portone"

    def __init__(
        self, config: PortoneProviderConfig, client: httpx.AsyncClient | None = None
    ):
        self._api_secret = config.api_secret
        self._store_id = config.store_id
        self._webhook_secret = config.webhook_secret
        self.channel_key = config.channel_key
        self._scheduling = config.scheduling
        self._logger: Logger = config.logger or NoopLogger()
        self._correlation_id_override = config.correlation_id
        self._client = client or httpx.AsyncClient(
            base_url=config.api_base or BASE_URL, timeout=30.0
        )

    # EC:L5 -- a scoped clone carrying a fixed correlation_id for every `provider.request` log line
    # it emits. Not part of the PaymentProvider Protocol (duck-typed -- webhook.process checks for
    # it with `getattr(provider, "with_correlation_id", None)`), so this stays additive. A cheap
    # shallow copy is correct here because `_request` below is a normal instance method that reads
    # `self` at call time (the shared httpx.AsyncClient is fine to share with the clone).
    def with_correlation_id(self, correlation_id: str) -> PortoneProvider:
        clone = copy.copy(self)
        clone._correlation_id_override = correlation_id
        return clone

    def capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            native_subscriptions=False,
            partial_refund=True,
            meters=False,
            scheduling=self._scheduling,
            webhook_signature=True,
        )

    # EC:L1 — one `provider.request` event per HTTP call, redacted (EC:L2) by the Logger implementation.
    async def _request(
        self, method: str, path: str, body: dict[str, Any] | None = None
    ) -> Any:
        headers = {
            "Authorization": f"PortOne {self._api_secret}",
            "Content-Type": "application/json",
        }
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
                failure = normalize_portone_failure(
                    data.get("failure")
                    or {"pgCode": data.get("type"), "pgMessage": data.get("message")}
                ) or PaymentFailure(
                    code="unknown",
                    provider_code=data.get("type"),
                    retryable=False,
                    user_message=data.get("message") or "portone api error",
                )
                await self._logger.log(
                    {
                        "level": "warn",
                        "event": "provider.request",
                        "provider": "portone",
                        "method": method,
                        "path": path,
                        "status": status_code,
                        "durationMs": duration_ms,
                        "correlationId": self._correlation_id_override,
                        "providerErrorCode": failure.code,
                        "requestBody": body,
                        "responseBody": data,
                    }
                )
                raise ProviderError(
                    data.get("message") or f"portone api error ({res.status_code})",
                    failure,
                    data,
                )
            await self._logger.log(
                {
                    "level": "info",
                    "event": "provider.request",
                    "provider": "portone",
                    "method": method,
                    "path": path,
                    "status": status_code,
                    "durationMs": duration_ms,
                    "correlationId": self._correlation_id_override,
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
                    "provider": "portone",
                    "method": method,
                    "path": path,
                    "status": status_code,
                    "durationMs": duration_ms,
                    "correlationId": self._correlation_id_override,
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
        # EC:F — PortOne V2 has no standalone customer-create API; customer is inline per payment.
        provided = (metadata or {}).get("customerId")
        if provided:
            return {"ref": provided}
        return {"ref": "cus_" + _sha256(email)[:40]}

    async def create_checkout(self, input: CreateCheckoutInput) -> Checkout:
        payment_id = "pay_" + _sha256(input.idempotency_key)[:40]  # EC:E6
        sep = "&" if "?" in input.success_url else "?"
        url = f"{input.success_url}{sep}paymentId={payment_id}"
        return Checkout(id=payment_id, url=url, provider_ref=payment_id)

    async def confirm_payment(self, payment_id: str, expected_amount: Money) -> Payment:
        """Extra method — EC:E13/E10, server-side re-fetch + amount verification before granting."""
        raw = await self._request("GET", f"/payments/{payment_id}")
        if raw["status"] != "PAID":
            raise PaymentKitError(
                f"portone payment {payment_id} is not PAID (status={raw['status']})",
                "payment_not_paid",
            )
        amount = raw.get("amount") or {}
        total = amount.get("total") if isinstance(amount, dict) else amount
        if total != expected_amount.amount_minor:
            raise PaymentKitError(
                f"portone payment amount mismatch: expected {expected_amount.amount_minor}, got {total}",
                "amount_mismatch",
            )  # EC:E10
        return normalize_portone_payment(raw)

    async def issue_billing_key(
        self, *, customer: dict[str, Any], method: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        """Extra method — EC:F billing key issuance.

        Confirmed against the real V2 OpenAPI spec (portone-io/server-sdk
        `codegen/openapi.json`, fetched 2026-09-09): ``POST /billing-keys``
        (IssueBillingKeyBody -> IssueBillingKeyResponse) IS a server-side issuance path (in
        addition to the client SDK's requestIssueBillingKey). The response nests the key
        under ``billingKeyInfo.billingKey``, not top-level ``billingKey`` as an earlier
        draft of this module assumed — that was a real bug, fixed here.
        """
        body: dict[str, Any] = {
            "storeId": self._store_id,
            "channelKey": self.channel_key,
            "customer": customer,
        }
        if method:
            body["method"] = method
        raw = await self._request("POST", "/billing-keys", body)
        return {
            "billing_key": (raw.get("billingKeyInfo") or {}).get("billingKey"),
            "raw": raw,
        }

    async def charge_billing_key(
        self,
        *,
        billing_key: str,
        amount: Money,
        order_id: str,
        customer_ref: str,
        idempotency_key: str,
    ) -> Payment:
        # order_id is used as PortOne's {paymentId} path segment — PortOne's idempotency model
        # is "caller supplies a unique paymentId per attempt" rather than an Idempotency-Key header.
        raw = await self._request(
            "POST",
            f"/payments/{order_id}/billing-key",
            {
                "storeId": self._store_id,
                "billingKey": billing_key,
                "orderName": "Subscription charge",
                "amount": {"total": amount.amount_minor},
                "currency": amount.currency,
                "customer": {"id": customer_ref},
            },
        )
        # Confirmed against the real V2 OpenAPI spec: PayWithBillingKeyResponse is
        # `{ payment: BillingKeyPaymentSummary }` where BillingKeyPaymentSummary is only
        # `{ pgTxId, paidAt }` — NOT a full Payment object as an earlier draft assumed
        # (normalize_portone_payment(raw["payment"]) would have produced a Payment with an
        # undefined status/amount/id). A 200 response here means the charge succeeded
        # synchronously (failures come back as a non-2xx PayWithBillingKeyError, handled by
        # _request() above), so the normalized Payment is built from what we already know
        # (order_id, amount, currency, customer_ref) plus the summary's paidAt/pgTxId.
        summary = raw.get("payment", raw)
        return normalize_portone_payment(
            {
                "id": order_id,
                "status": "PAID",
                "amount": {"total": amount.amount_minor},
                "currency": amount.currency,
                "customer": {"id": customer_ref},
                "paidAt": summary.get("paidAt"),
                "requestedAt": summary.get("paidAt"),
                "pgTxId": summary.get("pgTxId"),
            }
        )

    async def schedule_payment(
        self,
        *,
        billing_key: str,
        amount: Money,
        order_id: str,
        customer_ref: str,
        time_to_pay: datetime,
    ) -> Any:
        """Extra method — EC:F, scheduling='provider' path: reserve the next charge with PortOne.

        Confirmed against the real V2 OpenAPI spec: CreatePaymentScheduleBody is
        ``{ payment: BillingKeyPaymentScheduleInput, timeToPay }`` — the billing-key
        payment fields must be nested under ``payment``, not sent flat as an earlier draft
        did.
        """
        return await self._request(
            "POST",
            f"/payments/{order_id}/schedule",
            {
                "payment": {
                    "storeId": self._store_id,
                    "billingKey": billing_key,
                    "orderName": "Subscription charge",
                    "amount": {"total": amount.amount_minor},
                    "currency": amount.currency,
                    "customer": {"id": customer_ref},
                },
                "timeToPay": time_to_pay.isoformat(),
            },
        )

    async def cancel_schedules(
        self, *, billing_key: str | None = None, schedule_ids: list[str] | None = None
    ) -> Any:
        """Extra method — EC:F.

        Confirmed against the real V2 OpenAPI spec: the cancel-schedule endpoint is
        ``DELETE /payment-schedules`` (NOT ``/payments/{paymentId}/schedule`` as an earlier
        draft assumed — that path/method combination doesn't exist), taking
        ``{ storeId, billingKey?, scheduleIds? }`` (at least one of billing_key/schedule_ids
        required) and returning ``{ revokedScheduleIds, revokedAt }``. There is no way to
        cancel schedules by payment_id.
        """
        if not billing_key and not schedule_ids:
            raise PaymentKitError(
                "cancel_schedules requires billing_key or schedule_ids",
                "invalid_request",
            )
        body: dict[str, Any] = {"storeId": self._store_id}
        if billing_key:
            body["billingKey"] = billing_key
        if schedule_ids:
            body["scheduleIds"] = schedule_ids
        return await self._request("DELETE", "/payment-schedules", body)

    async def get_payment(self, provider_ref: str) -> Payment:
        raw = await self._request("GET", f"/payments/{provider_ref}")
        return normalize_portone_payment(raw)

    async def list_payments(
        self, *, customer_ref: str, since: datetime
    ) -> list[Payment]:
        # Confirmed against the real V2 OpenAPI spec: GET /payments takes ONE query
        # parameter named `requestBody` whose value is the URL-encoded JSON body
        # (GetPaymentsBody = { page?, filter? }) — a PortOne convention for GET endpoints
        # with complex filters, not the `filter.from`/`filter.customer.id` flat query
        # params an earlier draft used. More importantly: PaymentFilterInput has NO
        # customer-id field at all (its full field list is merchantId/storeId/
        # timestampType/from/until/status/methods/pgProvider/isTest/isScheduled/sortBy/
        # sortOrder/version/webhookStatus/platformType/currency/isEscrow/escrowStatus/
        # card*/giftCertificateType/cashReceipt*/textSearch) — server-side customer
        # filtering is not possible. This resolves the spec's "미검증" note definitively
        # rather than leaving it best-effort: we filter by date range only and match
        # customer_ref client-side, exactly as spec/portone.pseudo.md's documented fallback.
        request_body = json.dumps({"filter": {"from": since.isoformat()}})
        query = urllib.parse.urlencode({"requestBody": request_body})
        raw = await self._request("GET", f"/payments?{query}")
        items: list[dict[str, Any]] = raw.get("items") or raw.get("payments") or []
        return [
            normalize_portone_payment(p)
            for p in items
            if (p.get("customer") or {}).get("id") == customer_ref
        ]

    async def get_subscription(self, provider_ref: str) -> Subscription:
        # See spec/portone.pseudo.md "계약 변경 제안" — cannot fabricate Subscription fields.
        raise PaymentKitError(
            "portone has no native subscription; read from Repo.subscriptions",
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
            "portone has no native subscription; scheduler manages plan changes via Repo",
            "unsupported",
        )

    async def cancel_subscription(
        self, provider_ref: str, *, at_period_end: bool
    ) -> Subscription:
        raise PaymentKitError(
            "portone has no native subscription; scheduler manages cancellation via Repo",
            "unsupported",
        )

    # EC:A23 — same reasoning as get_subscription/change_subscription/cancel_subscription above.
    async def uncancel_subscription(self, provider_ref: str) -> Subscription:
        raise PaymentKitError(
            "portone has no native subscription; scheduler manages cancellation via Repo",
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
        extra = extra or {}
        body: dict[str, Any] = {"storeId": self._store_id, "reason": reason}
        if amount:
            body["amount"] = (
                amount.amount_minor
            )  # EC:D4 — PG may reject partials (EC:D14), propagated as ProviderError
        if extra.get("refundAccount"):
            body["refundAccount"] = extra[
                "refundAccount"
            ]  # EC:D13-equivalent for virtual accounts
        raw = await self._request("POST", f"/payments/{payment_ref}/cancel", body)
        return _normalize_portone_refund(
            raw, payment_ref=payment_ref, amount=amount, reason=reason
        )

    async def get_refund(self, *, payment_ref: str, refund_ref: str) -> Refund | None:
        raw = await self._request("GET", f"/payments/{urllib.parse.quote(payment_ref, safe='')}")
        cancellation = next((cancel for cancel in raw.get("cancellations", []) if cancel.get("id") == refund_ref), None)
        if cancellation is None:
            return None
        return _normalize_portone_refund(
            {"cancellation": cancellation}, payment_ref=payment_ref,
            amount=Money(amount_minor=cancellation["totalAmount"], currency=raw["currency"]),
            reason=cancellation.get("reason", ""),
        )

    async def issue_cash_receipt(
        self,
        *,
        payment_ref: str,
        type: CashReceiptType,
        customer_identity_number: str,
        order_name: str | None = None,
        tax_free_amount_minor: int | None = None,
        customer_name: str | None = None,
        customer_email: str | None = None,
        customer_phone_number: str | None = None,
    ) -> CashReceipt:
        """Extra method (not in core PaymentProvider) -- EC:K2 K3 K4. `POST /cash-receipts`
        (IssueCashReceiptBody -> IssueCashReceiptResponse). Confirmed against the real V2 OpenAPI
        spec (portone-io/server-sdk `codegen/openapi.json`, 2026-09-09) -- this resolves a real
        gap in the brief this method was written against: there is **no**
        `POST /payments/{paymentId}/cash-receipt` issuance endpoint in the V2 API (only
        `GET .../cash-receipt` and `POST .../cash-receipt/cancel` are payment-scoped); issuance is
        the standalone `/cash-receipts` resource, keyed by `paymentId` in the request body plus a
        required `channelKey`. NOT exercised against the live PortOne API (no real cash-eligible
        payment was completable server-side in this environment). EC:K4 (card exclusion) is
        applied best-effort from `PaidPayment.method.type` (`PaymentMethodCard` per the real
        schema) -- PortOne fans out to many PGs with inconsistent method reporting, so this is
        documented as heuristic-only, same caveat as `normalize_portone_failure` above.
        """
        if not self.channel_key:
            raise PaymentKitError(
                "channel_key is required to issue a PortOne cash receipt",
                "channel_key_required",
            )
        raw_payment = await self._request("GET", f"/payments/{payment_ref}")
        method_type = str((raw_payment.get("method") or {}).get("type") or "")
        if method_type == "PaymentMethodCard":
            # EC:K4 -- card payments are not cash-receipt eligible (card sales slips serve that role).
            raise PaymentKitError(
                f"cash receipts are not issuable for card payments (payment_ref={payment_ref})",
                "cash_receipt_unsupported_for_payment_method",
            )
        amount = raw_payment.get("amount") or {}
        total = amount.get("total") if isinstance(amount, dict) else amount
        body: dict[str, Any] = {
            "paymentId": payment_ref,
            "channelKey": self.channel_key,
            "type": "CORPORATE" if type == "business" else "PERSONAL",
            "orderName": order_name or raw_payment.get("orderName") or "Payment",
            "currency": raw_payment.get("currency") or "KRW",
            "amount": {"total": total, "taxFree": tax_free_amount_minor},
            "customer": {
                "identityNumber": customer_identity_number,
                "name": customer_name,
                "email": customer_email,
                "phoneNumber": customer_phone_number,
            },
        }
        raw = await self._request("POST", "/cash-receipts", body)
        # IssueCashReceiptResponse is `{ cashReceipt: CashReceiptSummary }` (issueNumber/url/
        # pgReceiptId only, per the real OpenAPI spec) -- not a full CashReceipt object, so build
        # ours from what we already know (paymentId/type/amount) plus the summary's issueNumber/url.
        summary = raw.get("cashReceipt") or raw
        return normalize_portone_cash_receipt(
            {
                "status": "ISSUED",
                "paymentId": payment_ref,
                "type": "CORPORATE" if type == "business" else "PERSONAL",
                "amount": total,
                "currency": raw_payment.get("currency") or "KRW",
                "issueNumber": summary.get("issueNumber"),
                "url": summary.get("url"),
            }
        )

    async def cancel_cash_receipt(self, *, payment_ref: str) -> CashReceipt:
        """Extra method -- EC:K5 K6. `POST /payments/{paymentId}/cash-receipt/cancel`. Confirmed
        against the real V2 OpenAPI spec: response is `CancelCashReceiptResponse`
        (`{ cancelledAmount, cancelledAt }` only -- no receipt identity fields, and **no partial
        cancel support** -- the endpoint takes no request body at all), so the returned
        `CashReceipt` is synthesized from the input `payment_ref` plus the response's
        `cancelledAmount`. Not exercised against the live API -- see `issue_cash_receipt` doc
        comment.
        """
        raw = await self._request(
            "POST",
            f"/payments/{payment_ref}/cash-receipt/cancel",
            {"storeId": self._store_id},
        )
        return normalize_portone_cash_receipt(
            {
                "status": "CANCELLED",
                "paymentId": payment_ref,
                "amount": raw.get("cancelledAmount"),
            }
        )

    async def get_cash_receipt(self, *, payment_ref: str) -> CashReceipt | None:
        """Extra method -- EC:K7 duplicate-issuance guard support.
        `GET /payments/{paymentId}/cash-receipt` -- confirmed against the real V2 OpenAPI spec;
        returns 404 `CashReceiptNotFoundError` when none exists (mapped here to `None` rather than
        raising, so callers can treat "no receipt yet" as a normal case). Not exercised against
        the live API.
        """
        try:
            raw = await self._request("GET", f"/payments/{payment_ref}/cash-receipt")
            return normalize_portone_cash_receipt(raw)
        except ProviderError as err:
            if err.failure.provider_code == "CashReceiptNotFoundError":
                return None
            raise

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
            "portone has no meters API", "unsupported"
        )  # capabilities().meters is False

    async def verify_webhook(
        self,
        *,
        headers: dict[str, str],
        raw_body: str,
        received_at: datetime | None = None,
    ) -> NormalizedEvent:
        id_ = headers.get("webhook-id") or headers.get("svix-id")
        timestamp = headers.get("webhook-timestamp") or headers.get("svix-timestamp")
        sig_header = headers.get("webhook-signature") or headers.get("svix-signature")
        if not id_ or not timestamp or not sig_header:
            raise WebhookSignatureError(
                "missing Standard Webhooks headers (webhook-id/webhook-timestamp/webhook-signature)"
            )
        try:
            ts_sec = float(timestamp)
        except ValueError:
            raise WebhookSignatureError("invalid webhook timestamp")
        # EC:E17 -- measured at receipt when process() re-verifies a stored body.
        ref = received_at.timestamp() if received_at is not None else time.time()
        if abs(ref - ts_sec) > 300:
            raise WebhookSignatureError("webhook timestamp outside 5-minute tolerance")
        secret_b64 = self._webhook_secret.removeprefix("whsec_")
        key = base64.b64decode(secret_b64)
        signed_content = f"{id_}.{timestamp}.{raw_body}".encode()
        expected = base64.b64encode(
            hmac.new(key, signed_content, hashlib.sha256).digest()
        )
        candidates = []
        for part in sig_header.split(" "):
            candidates.append(part.split(",", 1)[1] if "," in part else part)
        ok = False
        for sig in candidates:
            try:
                sig_bytes = base64.b64decode(sig)
            except (ValueError, binascii.Error):
                continue
            if hmac.compare_digest(sig_bytes, base64.b64decode(expected)):
                ok = True
                break
        if not ok:
            raise WebhookSignatureError("portone webhook signature mismatch")
        body = json.loads(raw_body)
        event = map_portone_webhook(body)  # EC:E3 — caller must re-fetch before acting
        event.id = id_  # webhook-id is the stable Standard Webhooks message id
        return event
