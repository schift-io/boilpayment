"""spec/cs.pseudo.md — EC:I6
Minimal HS256 JWT, stdlib-only (hmac/hashlib) -- no PyJWT dependency per ARCHITECTURE.md.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from dataclasses import dataclass
from datetime import UTC, datetime

from schift_payment_kit_core import PaymentKitError


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    pad = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + pad)


def _sign(header_and_payload: str, secret: str) -> str:
    digest = hmac.new(
        secret.encode("utf-8"), header_and_payload.encode("utf-8"), hashlib.sha256
    ).digest()
    return _b64url(digest)


@dataclass(kw_only=True, slots=True)
class WidgetClaims:
    customer_id: str
    exp: int


@dataclass(kw_only=True, slots=True)
class SignTokenInput:
    customer_id: str
    ttl_seconds: int
    now: datetime | None = None  # optional clock for determinism (tests/smokes)


def sign_token(input: SignTokenInput, secret: str) -> str:
    """cs.widget.sign_token({customer_id, ttl_seconds}, secret) -- app-side helper (no external JWT lib)."""
    header = _b64url(json.dumps({"alg": "HS256", "typ": "JWT"}).encode("utf-8"))
    now_s = int((input.now or datetime.now(UTC)).timestamp())
    payload = _b64url(
        json.dumps({"sub": input.customer_id, "exp": now_s + input.ttl_seconds}).encode(
            "utf-8"
        )
    )
    sig = _sign(f"{header}.{payload}", secret)
    return f"{header}.{payload}.{sig}"


def verify_token(token: str, secret: str, now: datetime | None = None) -> WidgetClaims:
    """EC:I6 -- cs.widget.verify_token(token, secret) -> {customer_id, exp}. Rejects bad signature or expiry."""
    parts = token.split(".")
    if len(parts) != 3:
        raise PaymentKitError("malformed widget token", "widget_token_invalid")
    header, payload, sig = parts
    expected = _sign(f"{header}.{payload}", secret)
    try:
        sig_bytes = _b64url_decode(sig)
        expected_bytes = _b64url_decode(expected)
    except Exception as err:
        raise PaymentKitError(
            "malformed widget token signature", "widget_token_invalid"
        ) from err
    if not hmac.compare_digest(sig_bytes, expected_bytes):
        raise PaymentKitError("invalid widget token signature", "widget_token_invalid")
    try:
        claims = json.loads(_b64url_decode(payload).decode("utf-8"))
    except Exception as err:
        raise PaymentKitError(
            "malformed widget token payload", "widget_token_invalid"
        ) from err
    sub = claims.get("sub")
    exp = claims.get("exp")
    if not sub or not isinstance(exp, int):
        raise PaymentKitError("malformed widget token claims", "widget_token_invalid")
    if exp <= int((now or datetime.now(UTC)).timestamp()):
        raise PaymentKitError("widget token expired", "widget_token_expired")
    return WidgetClaims(customer_id=sub, exp=exp)
