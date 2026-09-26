"""EC:N1 N3 -- App Store signed data (JWS compact, ES256, x5c chain) verification.

Mirrors packages/providers/apple/ts/src/jws.ts. Implemented with `cryptography` instead of the
`app-store-server-library` package: the library's API client fixes the store hostnames (no base-URL
injection for the local mock) and the verifier is small. Checks mirror the library's
SignedDataVerifier: chain leaf <- intermediate <- trusted root, Apple marker OIDs on leaf and
intermediate, validity dates, then the ES256 signature itself.
"""

from __future__ import annotations

import base64
import json
import time
from datetime import UTC, datetime
from typing import Any

from boilpayment_core import PaymentKitError
from cryptography import x509
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import (
    decode_dss_signature,
    encode_dss_signature,
)

APPLE_LEAF_OID = "1.2.840.113635.100.6.11.1"
APPLE_WWDR_OID = "1.2.840.113635.100.6.2.1"


def _b64url(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _enc(value: Any) -> str:
    raw = json.dumps(value, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _invalid(message: str) -> PaymentKitError:
    return PaymentKitError(message, "iap_signature_invalid")


def _has_oid(cert: x509.Certificate, oid: str) -> bool:
    try:
        cert.extensions.get_extension_for_oid(x509.ObjectIdentifier(oid))
        return True
    except x509.ExtensionNotFound:
        return False


def _is_ca(cert: x509.Certificate) -> bool:
    try:
        return bool(
            cert.extensions.get_extension_for_class(x509.BasicConstraints).value.ca
        )
    except x509.ExtensionNotFound:
        return False


def _within(cert: x509.Certificate, at: datetime) -> bool:
    return cert.not_valid_before_utc <= at <= cert.not_valid_after_utc


def verify_apple_jws(
    token: str, *, root_certificates: list[str], now: datetime | None = None
) -> dict[str, Any]:
    """Verifies an App Store JWS and returns its decoded payload. Raises iap_signature_invalid."""
    parts = token.split(".") if isinstance(token, str) else []
    if len(parts) != 3:
        raise _invalid("signed data is not a compact JWS")
    try:
        header = json.loads(_b64url(parts[0]))
        payload = json.loads(_b64url(parts[1]))
    except ValueError as err:
        raise _invalid("signed data is not valid JSON") from err
    if header.get("alg") != "ES256":
        raise _invalid("signed data must use ES256")
    x5c = header.get("x5c")
    if not isinstance(x5c, list) or len(x5c) != 3:
        raise _invalid("signed data needs a 3-certificate x5c chain")
    try:
        leaf, intermediate, presented_root = (
            x509.load_der_x509_certificate(base64.b64decode(c)) for c in x5c
        )
    except ValueError as err:
        raise _invalid("x5c certificate could not be parsed") from err
    roots = [x509.load_pem_x509_certificate(p.encode()) for p in root_certificates]
    want = presented_root.fingerprint(hashes.SHA256())
    root = next((r for r in roots if r.fingerprint(hashes.SHA256()) == want), None)
    if root is None:
        raise _invalid("x5c chain does not end at a trusted root")
    at = now or datetime.now(tz=UTC)
    if not _is_ca(intermediate) or _is_ca(leaf):
        raise _invalid("x5c chain has the wrong CA flags")
    try:
        intermediate.verify_directly_issued_by(root)
    except (ValueError, TypeError, InvalidSignature) as err:
        raise _invalid("intermediate is not signed by the trusted root") from err
    try:
        leaf.verify_directly_issued_by(intermediate)
    except (ValueError, TypeError, InvalidSignature) as err:
        raise _invalid("leaf is not signed by the intermediate") from err
    if not (_within(leaf, at) and _within(intermediate, at) and _within(root, at)):
        raise _invalid("x5c certificate is outside its validity period")
    if not _has_oid(leaf, APPLE_LEAF_OID):
        raise _invalid("leaf lacks the App Store signing OID")
    if not _has_oid(intermediate, APPLE_WWDR_OID):
        raise _invalid("intermediate lacks the Apple WWDR OID")
    sig = _b64url(parts[2])
    if len(sig) != 64:
        raise _invalid("ES256 signature must be 64 bytes")
    der = encode_dss_signature(
        int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big")
    )
    key = leaf.public_key()
    if not isinstance(key, ec.EllipticCurvePublicKey):
        raise _invalid("leaf key is not an EC key")
    try:
        key.verify(der, f"{parts[0]}.{parts[1]}".encode(), ec.ECDSA(hashes.SHA256()))
    except InvalidSignature as err:
        raise _invalid("JWS signature does not verify") from err
    return payload


def app_store_api_token(
    *,
    issuer_id: str,
    key_id: str,
    private_key: str,
    bundle_id: str,
    now: datetime | None = None,
) -> str:
    """ES256 JWT for the App Store Server API (bearer token), signed with the .p8 key."""
    iat = int(now.timestamp() if now else time.time())
    head = _enc({"alg": "ES256", "kid": key_id, "typ": "JWT"})
    body = _enc(
        {
            "iss": issuer_id,
            "iat": iat,
            "exp": iat + 300,
            "aud": "appstoreconnect-v1",
            "bid": bundle_id,
        }
    )
    key = serialization.load_pem_private_key(private_key.encode(), password=None)
    if not isinstance(key, ec.EllipticCurvePrivateKey):
        raise PaymentKitError(
            "App Store API key must be an EC private key", "iap_config_invalid"
        )
    r, s = decode_dss_signature(
        key.sign(f"{head}.{body}".encode(), ec.ECDSA(hashes.SHA256()))
    )
    sig = (
        base64.urlsafe_b64encode(r.to_bytes(32, "big") + s.to_bytes(32, "big"))
        .rstrip(b"=")
        .decode()
    )
    return f"{head}.{body}.{sig}"
