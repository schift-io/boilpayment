"""EC:N1 N3 N5 N6 N14 E16 -- AppleProvider against the local App Store mock (tools/mocks/apple).

Mirrors packages/providers/apple/ts/test/apple.test.ts.
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import time
from pathlib import Path

import anyio
import httpx
import pytest
from boilpayment_apple import AppleProvider, AppleProviderConfig
from boilpayment_core import (
    CollectingLogger,
    PaymentKitError,
    StoreProof,
    WebhookSignatureError,
)
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

ROOT = Path(__file__).resolve().parents[5]
BUNDLE = "io.boilpayment.test"
DAY = 86_400_000


@pytest.fixture(scope="module")
def mock():
    proc = subprocess.Popen(
        ["node", str(ROOT / "tools/mocks/apple/server.mjs")],
        env={
            **os.environ,
            "APPLE_MOCK_PORT": "0",
            "BOILPAYMENT_PYTHON": str(ROOT / ".venv/bin/python"),
        },
        stdout=subprocess.PIPE,
        text=True,
    )
    info = json.loads(proc.stdout.readline())
    chain = Path(info["chainDir"])
    yield {
        "url": info["url"],
        "chain": chain,
        "root": (chain / "root.pem").read_text(),
        "api_key": (chain / "api.key").read_text(),
    }
    proc.terminate()
    proc.wait(timeout=10)


def provider(mock, logger=None, **over) -> AppleProvider:
    cfg = {
        "bundle_id": BUNDLE,
        "app_apple_id": 123,
        "root_certificates": [mock["root"]],
        "issuer_id": "issuer",
        "key_id": "KEY1",
        "private_key": mock["api_key"],
        "api_base_url": {
            "production": f"{mock['url']}/production",
            "sandbox": f"{mock['url']}/sandbox",
        },
        "logger": logger or CollectingLogger(),
    }
    cfg.update(over)
    return AppleProvider(AppleProviderConfig(**cfg))


def post(mock, path: str, body: dict) -> dict:
    return httpx.post(f"{mock['url']}{path}", content=json.dumps(body)).json()


def now_ms() -> int:
    return int(time.time() * 1000)


def sign_with(chain_dir: Path, stem: str, payload: dict) -> str:
    def enc(v: dict) -> str:
        return base64.urlsafe_b64encode(json.dumps(v).encode()).rstrip(b"=").decode()

    certs = [
        x509.load_pem_x509_certificate((chain_dir / f"{stem}{n}.pem").read_bytes())
        for n in ("leaf", "intermediate", "root")
    ]
    x5c = [
        base64.b64encode(c.public_bytes(serialization.Encoding.DER)).decode()
        for c in certs
    ]
    key = serialization.load_pem_private_key(
        (chain_dir / f"{stem}leaf.key").read_bytes(), password=None
    )
    head, body = enc({"alg": "ES256", "x5c": x5c}), enc(payload)
    r, s = decode_dss_signature(
        key.sign(f"{head}.{body}".encode(), ec.ECDSA(hashes.SHA256()))
    )
    sig = (
        base64.urlsafe_b64encode(r.to_bytes(32, "big") + s.to_bytes(32, "big"))
        .rstrip(b"=")
        .decode()
    )
    return f"{head}.{body}.{sig}"


def code(fn) -> str:
    try:
        anyio.run(fn)
    except PaymentKitError as err:
        return err.code
    return "ok"


def test_verifies_subscription_and_refetches(mock):
    t = now_ms()
    jws = post(
        mock,
        "/__mock/transactions",
        {
            "transactionId": "py-100",
            "productId": "pro.monthly",
            "purchaseDate": t - DAY,
            "expiresDate": t + 29 * DAY,
            "price": 9990,
            "currency": "USD",
            "appAccountToken": "acct-1",
        },
    )["signedTransaction"]
    v = anyio.run(provider(mock).verify_purchase, StoreProof(signed_transaction=jws))
    assert (
        v.payment.provider_ref,
        v.payment.subscription_id,
        v.payment.kind,
        v.payment.amount.amount_minor,
    ) == ("py-100", "py-100", "subscription", 999)
    assert (
        v.subscription_ref,
        v.account_token,
        v.environment,
        v.ownership,
        v.amount_from_store,
    ) == ("py-100", "acct-1", "sandbox", "purchased", True)
    assert v.subscription.status == "active"


def test_security_wrong_app_untrusted_chain_and_tampered_jws_rejected(mock):
    other = post(
        mock,
        "/__mock/transactions",
        {
            "transactionId": "py-other",
            "productId": "x",
            "purchaseDate": now_ms(),
            "bundleId": "com.else",
            "type": "Consumable",
        },
    )
    assert (
        code(
            lambda: provider(mock).verify_purchase(
                StoreProof(signed_transaction=other["signedTransaction"])
            )
        )
        == "iap_wrong_app"
    )
    evil = sign_with(
        mock["chain"],
        "evil-",
        {
            "transactionId": "py-evil",
            "bundleId": BUNDLE,
            "productId": "x",
            "purchaseDate": now_ms(),
            "environment": "Sandbox",
            "type": "Consumable",
        },
    )
    assert (
        code(
            lambda: provider(mock).verify_purchase(StoreProof(signed_transaction=evil))
        )
        == "iap_signature_invalid"
    )
    good = post(
        mock,
        "/__mock/transactions",
        {
            "transactionId": "py-tamper",
            "productId": "x",
            "purchaseDate": now_ms(),
            "type": "Consumable",
        },
    )["signedTransaction"]
    h, b, s = good.split(".")
    header = json.loads(base64.urlsafe_b64decode(h + "=" * (-len(h) % 4)))

    def enc(v) -> str:
        return base64.urlsafe_b64encode(json.dumps(v).encode()).rstrip(b"=").decode()

    body = json.loads(base64.urlsafe_b64decode(b + "=" * (-len(b) % 4)))
    for bad in (
        f"{enc({'alg': 'none'})}.{b}.",
        f"{enc({**header, 'alg': 'HS256'})}.{b}.{s}",
        f"{enc({**header, 'x5c': header['x5c'][:2]})}.{b}.{s}",
        f"{h}.{enc({**body, 'price': 1})}.{s}",
        "not-a-jws",
    ):
        assert (
            code(
                lambda bad=bad: provider(mock).verify_purchase(
                    StoreProof(signed_transaction=bad)
                )
            )
            == "iap_signature_invalid"
        )


def test_api_auth_and_zero_decimal_currency(mock):
    jws = post(
        mock,
        "/__mock/transactions",
        {
            "transactionId": "py-auth",
            "productId": "x",
            "purchaseDate": now_ms(),
            "type": "Consumable",
            "price": 1100000,
            "currency": "KRW",
        },
    )["signedTransaction"]
    wrong = (mock["chain"] / "leaf.key").read_text()
    assert (
        code(
            lambda: provider(mock, private_key=wrong).verify_purchase(
                StoreProof(signed_transaction=jws)
            )
        )
        == "provider"
    )
    v = anyio.run(provider(mock).verify_purchase, StoreProof(signed_transaction=jws))
    assert (
        v.payment.kind,
        v.payment.subscription_id,
        v.payment.amount.amount_minor,
        v.payment.amount.currency,
    ) == ("topup", None, 1100, "KRW")


def test_notifications_map_and_security(mock):
    t = now_ms()
    post(
        mock,
        "/__mock/transactions",
        {
            "transactionId": "py-200",
            "productId": "pro.monthly",
            "purchaseDate": t - 31 * DAY,
            "expiresDate": t - DAY,
            "price": 9990,
        },
    )
    renew = post(
        mock,
        "/__mock/notification",
        {
            "notificationType": "DID_RENEW",
            "transaction": {
                "transactionId": "py-201",
                "originalTransactionId": "py-200",
                "productId": "pro.monthly",
                "purchaseDate": t - DAY,
                "expiresDate": t + 29 * DAY,
                "price": 9990,
                "type": "Auto-Renewable Subscription",
                "environment": "Sandbox",
                "bundleId": BUNDLE,
                "currency": "USD",
            },
        },
    )
    ev = anyio.run(
        lambda: provider(mock).verify_webhook(headers={}, raw_body=renew["body"])
    )
    assert (ev.type, ev.payment_ref, ev.subscription_ref, ev.amount.amount_minor) == (
        "payment.succeeded",
        "py-201",
        "py-200",
        999,
    )
    refund = post(
        mock,
        "/__mock/notification",
        {
            "notificationType": "REFUND",
            "transaction": {"transactionId": "py-100", "revocationDate": t},
        },
    )
    ev = anyio.run(
        lambda: provider(mock).verify_webhook(headers={}, raw_body=refund["body"])
    )
    assert (ev.type, ev.refund_ref, ev.amount.amount_minor) == (
        "refund.created",
        "apple-refund:py-100",
        999,
    )
    prod = post(
        mock,
        "/__mock/notification",
        {
            "notificationType": "TEST",
            "data": {"environment": "Production", "appAppleId": 999},
        },
    )["body"]
    for body, p in (
        (
            post(
                mock, "/__mock/notification", {"notificationType": "TEST", "evil": True}
            )["body"],
            provider(mock),
        ),
        (
            post(
                mock,
                "/__mock/notification",
                {"notificationType": "TEST", "data": {"bundleId": "com.other"}},
            )["body"],
            provider(mock),
        ),
        (prod, provider(mock)),
        (prod, provider(mock, app_apple_id=None)),
        ("{}", provider(mock)),
    ):
        with pytest.raises(WebhookSignatureError):
            anyio.run(
                lambda body=body, p=p: p.verify_webhook(headers={}, raw_body=body)
            )
    logger = CollectingLogger()
    ev = anyio.run(
        lambda: provider(mock, logger).verify_webhook(
            headers={},
            raw_body=post(
                mock, "/__mock/notification", {"notificationType": "METADATA_UPDATE"}
            )["body"],
        )
    )
    assert ev.type == "unknown"
    assert any(e.get("event") == "webhook.unmapped" for e in logger.entries)


def test_get_subscription_reads_grace_and_auto_renew(mock):
    post(
        mock,
        "/__mock/status",
        {
            "originalTransactionId": "py-200",
            "status": 4,
            "autoRenewStatus": 0,
            "gracePeriodExpiresDate": now_ms() + 3 * DAY,
        },
    )
    sub = anyio.run(provider(mock).get_subscription, "py-200")
    assert (sub.provider_ref, sub.status, sub.cancel_at_period_end) == (
        "py-200",
        "past_due",
        True,
    )
    assert sub.grace_until is not None
