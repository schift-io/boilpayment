"""Smoke test — real code path through TossProvider, with a tiny httpx.MockTransport
standing in for api.tosspayments.com (no real PG calls, no live keys).
Run: .venv/bin/python packages/providers/toss/py/examples/smoke.py
"""

from __future__ import annotations

import asyncio
import dataclasses
import json

import httpx
from boilpayment_core import WebhookSignatureError
from boilpayment_toss import (
    TossProvider,
    TossProviderConfig,
    map_toss_webhook,
    normalize_toss_failure,
    normalize_toss_payment,
)

# ── Fixture JSON, copied from docs.tosspayments.com example responses (identical to ts smoke) ──

WEBHOOK_FIXTURE = {
    "eventType": "PAYMENT_STATUS_CHANGED",
    "createdAt": "2022-05-12T00:00:00.000",
    "data": {
        "paymentKey": "B3EvL1cKz9p-kO6XPNpfF",
        "status": "DONE",
        "orderId": "YOWWcpZSDCZ8WJC5x7mkl",
    },
}

PAYMENT_FIXTURE_DONE = {
    "paymentKey": "B3EvL1cKz9p-kO6XPNpfF",
    "orderId": "YOWWcpZSDCZ8WJC5x7mkl",
    "status": "DONE",
    "totalAmount": 15000,
    "currency": "KRW",
    "method": "카드",
    "approvedAt": "2022-05-12T00:00:05+09:00",
    "requestedAt": "2022-05-12T00:00:00+09:00",
}

PAYMENT_FIXTURE_ABORTED = {
    "paymentKey": "ABORTED_KEY",
    "orderId": "ord_aborted",
    "status": "ABORTED",
    "totalAmount": 5000,
    "currency": "KRW",
    "method": "카드",
    "requestedAt": "2022-05-12T00:10:00+09:00",
    "failure": {
        "code": "REJECT_CARD_COMPANY",
        "message": "카드사에서 승인을 거절했습니다.",
    },
}

PAYMENT_FIXTURE_VIRTUAL_ACCOUNT_CANCEL = {
    "paymentKey": "VA_KEY",
    "orderId": "ord_va",
    "status": "PARTIAL_CANCELED",
    "totalAmount": 20000,
    "currency": "KRW",
    "method": "가상계좌",
    "approvedAt": "2022-05-12T00:00:00+09:00",
    "cancels": [
        {
            "transactionKey": "txn_1",
            "cancelAmount": 5000,
            "canceledAt": "2022-05-13T00:00:00+09:00",
        }
    ],
}


_last_call: dict[str, str] = {}


def _handler(request: httpx.Request) -> httpx.Response:
    _last_call["url"] = str(request.url)
    path = request.url.path
    if path == "/v1/payments/confirm":
        return httpx.Response(200, json=PAYMENT_FIXTURE_DONE)
    if path == "/v1/payments/VA_KEY" and request.method == "GET":
        return httpx.Response(200, json=PAYMENT_FIXTURE_VIRTUAL_ACCOUNT_CANCEL)
    if path == "/v1/payments/VA_KEY/cancel":
        return httpx.Response(200, json=PAYMENT_FIXTURE_VIRTUAL_ACCOUNT_CANCEL)
    raise AssertionError(f"fake transport: unhandled path {path}")


def _asdict(obj):
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return {k: _asdict(v) for k, v in dataclasses.asdict(obj).items()}
    return obj


async def main() -> None:
    client = httpx.AsyncClient(
        base_url="https://api.tosspayments.com", transport=httpx.MockTransport(_handler)
    )
    provider = TossProvider(
        TossProviderConfig(
            secret_key="test_sk_dummy", allowed_webhook_ips=["203.0.113.10"]
        ),
        client,
    )

    print("capabilities:", json.dumps(_asdict(provider.capabilities())))

    confirmed = await provider.confirm_payment(
        payment_key=PAYMENT_FIXTURE_DONE["paymentKey"],
        order_id=PAYMENT_FIXTURE_DONE["orderId"],
        amount=15000,
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
        await provider.refund(
            payment_ref="VA_KEY",
            amount=confirmed.amount.__class__(amount_minor=5000, currency="KRW"),
            reason="customer request",
            idempotency_key="revoke:1",
        )
        print("UNEXPECTED: refund without refundReceiveAccount did not throw")
    except Exception as e:  # noqa: BLE001 — smoke assertion, printing the error deliberately
        print(
            "refund without refundReceiveAccount ->",
            getattr(e, "code", type(e).__name__),
            str(e),
        )

    from boilpayment_core import Money

    refund = await provider.refund(
        payment_ref="VA_KEY",
        amount=Money(amount_minor=5000, currency="KRW"),
        reason="customer request",
        idempotency_key="revoke:2",
        extra={
            "refundReceiveAccount": {
                "bank": "004",
                "accountNumber": "123456789",
                "holderName": "홍길동",
            }
        },
    )
    print(
        "refund ->",
        json.dumps(
            {"id": refund.id, "amount": _asdict(refund.amount), "status": refund.status}
        ),
    )

    raw_body = json.dumps(WEBHOOK_FIXTURE)
    allowed_event = await provider.verify_webhook(
        headers={"x-paykit-remote-ip": "203.0.113.10"}, raw_body=raw_body
    )
    print(
        "verify_webhook (allowed ip) ->",
        json.dumps(_asdict(allowed_event), default=str),
    )
    try:
        await provider.verify_webhook(
            headers={"x-paykit-remote-ip": "198.51.100.1"}, raw_body=raw_body
        )
        print("UNEXPECTED: disallowed ip did not throw")
    except WebhookSignatureError:
        print("verify_webhook (disallowed ip) -> threw WebhookSignatureError")

    print(
        "normalize_toss_payment(DONE) ->",
        json.dumps(_asdict(normalize_toss_payment(PAYMENT_FIXTURE_DONE)), default=str),
    )
    print(
        "normalize_toss_payment(ABORTED) ->",
        json.dumps(
            _asdict(normalize_toss_payment(PAYMENT_FIXTURE_ABORTED)), default=str
        ),
    )
    print(
        "normalize_toss_failure ->",
        json.dumps(_asdict(normalize_toss_failure(PAYMENT_FIXTURE_ABORTED["failure"]))),
    )
    print(
        "map_toss_webhook ->",
        json.dumps(_asdict(map_toss_webhook(WEBHOOK_FIXTURE)), default=str),
    )

    print("last fetch call path:", _last_call.get("url"))
    print("OK")


if __name__ == "__main__":
    asyncio.run(main())
