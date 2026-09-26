"""Smoke test — real code path through PortoneProvider, with a tiny httpx.MockTransport
standing in for api.portone.io (no real PG calls, no live keys).
Run: .venv/bin/python packages/providers/portone/py/examples/smoke.py
"""

from __future__ import annotations

import asyncio
import base64
import dataclasses
import hashlib
import hmac
import json
import time

import httpx
from boilpayment_core import Money, WebhookSignatureError
from boilpayment_portone import (
    PortoneProvider,
    PortoneProviderConfig,
    map_portone_webhook,
    normalize_portone_failure,
    normalize_portone_payment,
)

WEBHOOK_SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"  # dummy Standard Webhooks test secret (identical to ts smoke)

# ── Fixture JSON, shaped per developers.portone.io/api/rest-v2 example responses (identical to ts smoke) ──

WEBHOOK_BODY_FIXTURE = {
    "type": "Transaction.Cancelled",
    "timestamp": "2024-04-25T10:00:00.000Z",
    "data": {
        "paymentId": "example-payment-id",
        "storeId": "store-ae356798-3d20-4969-b739-14c6b0e1a667",
        "transactionId": "55451513-9763-4a7a-bb43-78a4c65be843",
        "cancellationId": "0cdd91e9-4e7c-44a3-a72e-1a6511826c2b",
    },
}

PAYMENT_FIXTURE_PAID = {
    "id": "example-payment-id",
    "status": "PAID",
    "amount": {"total": 15000, "taxFree": 0, "vat": 1364},
    "currency": "KRW",
    "customer": {"id": "cus_abc"},
    "paidAt": "2026-09-01T00:00:05.000Z",
    "requestedAt": "2026-09-01T00:00:00.000Z",
}

PAYMENT_FIXTURE_FAILED = {
    "id": "example-payment-failed",
    "status": "FAILED",
    "amount": {"total": 8000},
    "currency": "KRW",
    "customer": {"id": "cus_abc"},
    "requestedAt": "2026-09-01T00:10:00.000Z",
    "failure": {"pgCode": "INSUFFICIENT_BALANCE", "pgMessage": "잔액이 부족합니다."},
}


def sign_standard_webhook(secret: str, id_: str, timestamp: str, body: str) -> str:
    secret_b64 = secret.removeprefix("whsec_")
    key = base64.b64decode(secret_b64)
    signed_content = f"{id_}.{timestamp}.{body}".encode()
    sig = base64.b64encode(
        hmac.new(key, signed_content, hashlib.sha256).digest()
    ).decode("ascii")
    return f"v1,{sig}"


_last_call: dict[str, str] = {}


def _handler(request: httpx.Request) -> httpx.Response:
    _last_call["url"] = str(request.url)
    path = request.url.path
    if path == "/payments/example-payment-id" and request.method == "GET":
        return httpx.Response(200, json=PAYMENT_FIXTURE_PAID)
    if path == "/payments/example-payment-id/cancel":
        return httpx.Response(
            200,
            json={
                "cancellation": {
                    "id": "cxl_1",
                    "totalAmount": 5000,
                    "cancelledAt": "2026-09-02T00:00:00.000Z",
                }
            },
        )
    raise AssertionError(f"fake transport: unhandled path {path}")


def _asdict(obj):
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return {k: _asdict(v) for k, v in dataclasses.asdict(obj).items()}
    return obj


async def main() -> None:
    client = httpx.AsyncClient(
        base_url="https://api.portone.io", transport=httpx.MockTransport(_handler)
    )
    provider = PortoneProvider(
        PortoneProviderConfig(
            api_secret="test_sk_dummy",
            store_id="store_dummy",
            webhook_secret=WEBHOOK_SECRET,
        ),
        client,
    )

    print("capabilities:", json.dumps(_asdict(provider.capabilities())))

    confirmed = await provider.confirm_payment(
        "example-payment-id", Money(amount_minor=15000, currency="KRW")
    )
    print(
        "confirm_payment ->",
        json.dumps(
            {
                "id": confirmed.id,
                "status": confirmed.status,
                "amount": _asdict(confirmed.amount),
            }
        ),
    )

    try:
        await provider.confirm_payment(
            "example-payment-id", Money(amount_minor=999, currency="KRW")
        )
        print("UNEXPECTED: amount mismatch did not throw")
    except Exception as e:  # noqa: BLE001 — smoke assertion, printing the error deliberately
        print(
            "confirm_payment amount mismatch ->",
            getattr(e, "code", type(e).__name__),
            str(e),
        )

    refund = await provider.refund(
        payment_ref="example-payment-id",
        amount=Money(amount_minor=5000, currency="KRW"),
        reason="customer request",
        idempotency_key="revoke:1",
    )
    print(
        "refund ->",
        json.dumps(
            {"id": refund.id, "amount": _asdict(refund.amount), "status": refund.status}
        ),
    )

    raw_body = json.dumps(WEBHOOK_BODY_FIXTURE)
    id_ = "msg_2aXpZoWFrKlmCfxbRSjBRXP2C6H"
    timestamp = str(int(time.time()))
    signature = sign_standard_webhook(WEBHOOK_SECRET, id_, timestamp, raw_body)
    event = await provider.verify_webhook(
        headers={
            "webhook-id": id_,
            "webhook-timestamp": timestamp,
            "webhook-signature": signature,
        },
        raw_body=raw_body,
    )
    print(
        "verify_webhook (valid signature) ->", json.dumps(_asdict(event), default=str)
    )

    tampered_body = json.dumps(
        {
            **WEBHOOK_BODY_FIXTURE,
            "data": {
                **WEBHOOK_BODY_FIXTURE["data"],
                "paymentId": "attacker-controlled",
            },
        }
    )
    try:
        await provider.verify_webhook(
            headers={
                "webhook-id": id_,
                "webhook-timestamp": timestamp,
                "webhook-signature": signature,
            },
            raw_body=tampered_body,
        )
        print("UNEXPECTED: tampered body did not throw")
    except WebhookSignatureError:
        print("verify_webhook (tampered body) -> threw WebhookSignatureError")

    print(
        "normalize_portone_payment(PAID) ->",
        json.dumps(
            _asdict(normalize_portone_payment(PAYMENT_FIXTURE_PAID)), default=str
        ),
    )
    print(
        "normalize_portone_payment(FAILED) ->",
        json.dumps(
            _asdict(normalize_portone_payment(PAYMENT_FIXTURE_FAILED)), default=str
        ),
    )
    print(
        "normalize_portone_failure ->",
        json.dumps(
            _asdict(normalize_portone_failure(PAYMENT_FIXTURE_FAILED["failure"]))
        ),
    )
    print(
        "map_portone_webhook ->",
        json.dumps(_asdict(map_portone_webhook(WEBHOOK_BODY_FIXTURE)), default=str),
    )

    print("last fetch call path:", _last_call.get("url"))
    print("OK")


if __name__ == "__main__":
    asyncio.run(main())
