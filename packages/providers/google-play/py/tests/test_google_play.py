"""EC:N1 N3 N6 N9 N11 N14 E16 -- GooglePlayProvider against tools/mocks/google-play.

Mirrors packages/providers/google-play/ts/test/google-play.test.ts.
"""

from __future__ import annotations

import json
import os
import subprocess
from datetime import UTC, datetime
from pathlib import Path

import anyio
import httpx
import pytest
from boilpayment_core import (
    CollectingLogger,
    PaymentKitError,
    StoreProof,
    WebhookSignatureError,
)
from boilpayment_google_play import (
    GooglePlayProvider,
    GooglePlayProviderConfig,
    PubsubAuthConfig,
    period_start_from_expiry,
)

ROOT = Path(__file__).resolve().parents[5]
PKG = "io.boilpayment.test"
AUD = "https://example.test/webhook/google-play"
PUSH_EMAIL = "push@test.iam.gserviceaccount.com"


@pytest.fixture(scope="module")
def mock():
    proc = subprocess.Popen(
        ["node", str(ROOT / "tools/mocks/google-play/server.mjs")],
        env={**os.environ, "GOOGLE_PLAY_MOCK_PORT": "0"},
        stdout=subprocess.PIPE,
        text=True,
    )
    url = json.loads(proc.stdout.readline())["url"]
    sa = httpx.get(f"{url}/__mock/service-account").json()
    yield {"url": url, "sa": sa}
    proc.terminate()
    proc.wait(timeout=10)


def provider(mock, logger=None, **over) -> GooglePlayProvider:
    cfg = {
        "package_name": PKG,
        "service_account": mock["sa"],
        "api_base_url": mock["url"],
        "logger": logger or CollectingLogger(),
        "pubsub": PubsubAuthConfig(
            audience=AUD,
            service_account_email=PUSH_EMAIL,
            jwks_url=f"{mock['url']}/oidc/certs",
        ),
        "product_intervals": {"pro.monthly": "month"},
    }
    cfg.update(over)
    return GooglePlayProvider(GooglePlayProviderConfig(**cfg))


def post(mock, path: str, body: dict) -> dict:
    return httpx.post(f"{mock['url']}{path}", content=json.dumps(body)).json()


def sub(mock, token: str, **over):
    body = {
        "token": token,
        "subscriptionState": "SUBSCRIPTION_STATE_ACTIVE",
        "startTime": "2026-01-01T00:00:00Z",
        "acknowledgementState": "ACKNOWLEDGEMENT_STATE_PENDING",
        "externalAccountIdentifiers": {"obfuscatedExternalAccountId": "acct-1"},
        "testPurchase": {},
        "lineItems": [
            {
                "productId": "pro.monthly",
                "expiryTime": "2026-03-31T10:00:00.000Z",
                "latestSuccessfulOrderId": "GPA.1-1",
                "autoRenewingPlan": {
                    "autoRenewEnabled": True,
                    "recurringPrice": {
                        "currencyCode": "USD",
                        "units": "9",
                        "nanos": 990000000,
                    },
                },
            }
        ],
    }
    body.update(over)
    post(mock, "/__mock/subscriptions", body)


def code(fn) -> str:
    try:
        anyio.run(fn)
    except PaymentKitError as err:
        return err.code
    return "ok"


RENEWED = {
    "subscriptionNotification": {
        "version": "1.0",
        "notificationType": 2,
        "purchaseToken": "pytok-1",
        "subscriptionId": "pro.monthly",
    }
}


def test_verify_subscription_period_account_and_ack_state(mock):
    sub(mock, "pytok-1")
    v = anyio.run(
        provider(mock).verify_purchase,
        StoreProof(
            purchase_token="pytok-1", product_id="pro.monthly", subscription=True
        ),
    )
    assert (
        v.payment.provider_ref,
        v.payment.subscription_id,
        v.payment.amount.amount_minor,
        v.payment.customer_id,
    ) == ("s|pytok-1|GPA.1-1", "pytok-1", 999, "acct-1")
    assert (v.payment.period.start, v.payment.period.end) == (
        datetime(2026, 2, 28, 10, tzinfo=UTC),
        datetime(2026, 3, 31, 10, tzinfo=UTC),
    )
    assert (
        v.subscription_ref,
        v.account_token,
        v.environment,
        v.acknowledged,
        v.amount_from_store,
    ) == ("pytok-1", "acct-1", "sandbox", False, True)


def test_security_wrong_package_is_not_found(mock):
    assert (
        code(
            lambda: provider(mock, package_name="com.other.app").verify_purchase(
                StoreProof(
                    purchase_token="pytok-1",
                    product_id="pro.monthly",
                    subscription=True,
                )
            )
        )
        == "iap_purchase_not_found"
    )


def test_one_time_product_and_idempotent_ack(mock):
    post(
        mock,
        "/__mock/products",
        {
            "productId": "coins.100",
            "token": "pyptok-1",
            "purchaseState": 0,
            "purchaseTimeMillis": "1767225600000",
            "acknowledgementState": 0,
            "purchaseType": 0,
            "orderId": "GPA.9",
            "obfuscatedExternalAccountId": "acct-1",
        },
    )
    v = anyio.run(
        provider(mock).verify_purchase,
        StoreProof(
            purchase_token="pyptok-1", product_id="coins.100", subscription=False
        ),
    )
    assert (
        v.amount_from_store,
        v.environment,
        v.acknowledged,
        v.payment.provider_ref,
        v.payment.kind,
    ) == (False, "sandbox", False, "p|coins.100|pyptok-1", "topup")
    p = provider(mock)
    for ref in ("s|pytok-1|GPA.1-1", "s|pytok-1|GPA.1-1", "p|coins.100|pyptok-1"):
        anyio.run(p.acknowledge, ref)
    calls = httpx.get(f"{mock['url']}/__mock/acks").json()["calls"]
    assert len([c for c in calls if c["token"] == "pytok-1"]) == 1
    assert len([c for c in calls if c["token"] == "pyptok-1"]) == 1


def test_linked_token_and_period_math(mock):
    sub(mock, "pytok-2", linkedPurchaseToken="pytok-1")
    v = anyio.run(
        provider(mock).verify_purchase,
        StoreProof(purchase_token="pytok-2", subscription=True),
    )
    assert v.replaces_subscription_ref == "pytok-1"
    assert period_start_from_expiry(
        datetime(2026, 3, 31, tzinfo=UTC), "month"
    ) == datetime(2026, 2, 28, tzinfo=UTC)
    assert period_start_from_expiry(
        datetime(2026, 1, 15, 5, tzinfo=UTC), "month"
    ) == datetime(2025, 12, 15, 5, tzinfo=UTC)
    assert period_start_from_expiry(
        datetime(2028, 2, 29, tzinfo=UTC), "year"
    ) == datetime(2027, 2, 28, tzinfo=UTC)


def test_rtdn_mapping_and_push_security(mock):
    pushed = post(
        mock, "/__mock/push", {"notification": RENEWED, "messageId": "py-m-1"}
    )
    ev = anyio.run(
        lambda: provider(mock).verify_webhook(
            headers=pushed["headers"], raw_body=pushed["body"]
        )
    )
    assert (
        ev.id,
        ev.type,
        ev.subscription_ref,
        ev.payment_ref,
        ev.amount.amount_minor,
    ) == ("py-m-1", "payment.succeeded", "pytok-1", "s|pytok-1|GPA.1-1", 999)
    bad_cases = [
        {"sign": "none"},
        {"sign": "evil"},
        {"audience": "https://attacker.test"},
        {"email": "x@else.iam.gserviceaccount.com"},
        {"expired": True},
        {"notification": {**RENEWED, "packageName": "com.other.app"}},
    ]
    for bad in bad_cases:
        pushed = post(mock, "/__mock/push", {"notification": RENEWED, **bad})
        with pytest.raises(WebhookSignatureError):
            anyio.run(
                lambda pushed=pushed: provider(mock).verify_webhook(
                    headers=pushed["headers"], raw_body=pushed["body"]
                )
            )
    voided = post(
        mock,
        "/__mock/push",
        {
            "notification": {
                "voidedPurchaseNotification": {
                    "purchaseToken": "pyptok-1",
                    "orderId": "GPA.9",
                    "productType": 2,
                    "refundType": 1,
                }
            }
        },
    )
    ev = anyio.run(
        lambda: provider(mock).verify_webhook(
            headers=voided["headers"], raw_body=voided["body"]
        )
    )
    assert (ev.type, ev.payment_ref, ev.refund_ref, ev.amount) == (
        "refund.created",
        "p|?|pyptok-1",
        "gp-void:GPA.9",
        None,
    )
    logger = CollectingLogger()
    odd = post(
        mock,
        "/__mock/push",
        {
            "notification": {
                "subscriptionNotification": {
                    "version": "1.0",
                    "notificationType": 20,
                    "purchaseToken": "pytok-1",
                }
            }
        },
    )
    assert (
        anyio.run(
            lambda: provider(mock, logger).verify_webhook(
                headers=odd["headers"], raw_body=odd["body"]
            )
        ).type
        == "unknown"
    )
    assert any(e.get("event") == "webhook.unmapped" for e in logger.entries)


def test_cancel_turns_auto_renew_off(mock):
    s = anyio.run(
        lambda: provider(mock).cancel_subscription("pytok-1", at_period_end=True)
    )
    assert (s.provider_ref, s.cancel_at_period_end) == ("pytok-1", True)
