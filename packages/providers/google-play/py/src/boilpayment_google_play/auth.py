"""EC:N1 -- Google auth pieces, implemented with `cryptography` (no google-auth): both are small, and
the JWKS URL / token endpoint must be injectable for the local mock. Mirrors ts/src/auth.ts.

1. Pub/Sub push OIDC token verification (RS256 JWT against Google's JWKS).
   https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions
2. Service-account access token (JWT bearer grant) for the androidpublisher API.
   https://developers.google.com/identity/protocols/oauth2/service-account#httprest
"""

from __future__ import annotations

import base64
import json
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs"
GOOGLE_ISSUERS = ["accounts.google.com", "https://accounts.google.com"]
ANDROIDPUBLISHER_SCOPE = "https://www.googleapis.com/auth/androidpublisher"


class PushAuthError(Exception):
    pass


@dataclass(kw_only=True, slots=True)
class PubsubAuthConfig:
    audience: str  # the audience configured on the push subscription
    service_account_email: (
        str  # the service account the push subscription authenticates as
    )
    jwks_url: str | None = None
    issuers: list[str] = field(default_factory=lambda: list(GOOGLE_ISSUERS))


def _b64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _enc(v: Any) -> str:
    return (
        base64.urlsafe_b64encode(json.dumps(v, separators=(",", ":")).encode())
        .rstrip(b"=")
        .decode()
    )


_jwks_cache: dict[str, Any] = {}


async def _jwks(url: str, refresh: bool) -> list[dict[str, Any]]:
    hit = _jwks_cache.get(url)
    if not refresh and hit and time.time() - hit["at"] < 3600:
        return hit["keys"]
    async with httpx.AsyncClient(timeout=15.0) as client:
        res = await client.get(url)
    if res.status_code >= 400:
        raise PushAuthError(f"jwks fetch failed: {res.status_code}")
    keys = res.json()["keys"]
    _jwks_cache[url] = {"keys": keys, "at": time.time()}
    return keys


def _rsa_key(jwk: dict[str, Any]) -> rsa.RSAPublicKey:
    n = int.from_bytes(_b64(jwk["n"]), "big")
    e = int.from_bytes(_b64(jwk["e"]), "big")
    return rsa.RSAPublicNumbers(e, n).public_key()


async def verify_push_token(
    authorization: str | None, config: PubsubAuthConfig, now: datetime | None = None
) -> dict[str, Any]:
    """Verifies `Authorization: Bearer <OIDC JWT>` from a Pub/Sub push. Raises PushAuthError."""
    if not authorization or not authorization.startswith("Bearer "):
        raise PushAuthError("push request has no bearer token")
    parts = authorization[7:].split(".")
    if len(parts) != 3:
        raise PushAuthError("push token is not a JWT")
    try:
        header = json.loads(_b64(parts[0]))
        claims = json.loads(_b64(parts[1]))
    except ValueError as err:
        raise PushAuthError("push token is not valid JSON") from err
    if header.get("alg") != "RS256":
        raise PushAuthError("push token must be RS256")
    url = config.jwks_url or GOOGLE_JWKS_URL
    key = next(
        (k for k in await _jwks(url, False) if k.get("kid") == header.get("kid")), None
    )
    if key is None:
        key = next(
            (k for k in await _jwks(url, True) if k.get("kid") == header.get("kid")),
            None,
        )
    if key is None:
        raise PushAuthError("push token signed by an unknown key")
    try:
        _rsa_key(key).verify(
            _b64(parts[2]),
            f"{parts[0]}.{parts[1]}".encode(),
            padding.PKCS1v15(),
            hashes.SHA256(),
        )
    except InvalidSignature as err:
        raise PushAuthError("push token signature does not verify") from err
    now_s = now.timestamp() if now else time.time()
    if not isinstance(claims.get("exp"), (int, float)) or claims["exp"] < now_s:
        raise PushAuthError("push token expired")
    if isinstance(claims.get("iat"), (int, float)) and claims["iat"] > now_s + 300:
        raise PushAuthError("push token issued in the future")
    if str(claims.get("iss")) not in config.issuers:
        raise PushAuthError("push token issuer is not Google")
    if claims.get("aud") != config.audience:
        raise PushAuthError("push token audience mismatch")
    if (
        claims.get("email") != config.service_account_email
        or claims.get("email_verified") is not True
    ):
        raise PushAuthError("push token is not from the configured service account")
    return claims


class ServiceAccountTokens:
    """Access token for androidpublisher, cached until one minute before expiry."""

    def __init__(self, account: dict[str, Any]):
        self._account = account
        self._cached: tuple[str, float] | None = None

    async def token(self) -> str:
        if self._cached and time.time() < self._cached[1]:
            return self._cached[0]
        token_uri = (
            self._account.get("token_uri") or "https://oauth2.googleapis.com/token"
        )
        iat = int(time.time())
        head = _enc({"alg": "RS256", "typ": "JWT"})
        body = _enc(
            {
                "iss": self._account["client_email"],
                "scope": ANDROIDPUBLISHER_SCOPE,
                "aud": token_uri,
                "iat": iat,
                "exp": iat + 3600,
            }
        )
        key = serialization.load_pem_private_key(
            self._account["private_key"].encode(), password=None
        )
        if not isinstance(key, rsa.RSAPrivateKey):
            raise TypeError("service account key must be RSA")
        sig = (
            base64.urlsafe_b64encode(
                key.sign(f"{head}.{body}".encode(), padding.PKCS1v15(), hashes.SHA256())
            )
            .rstrip(b"=")
            .decode()
        )
        async with httpx.AsyncClient(timeout=15.0) as client:
            res = await client.post(
                token_uri,
                data={
                    "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                    "assertion": f"{head}.{body}.{sig}",
                },
            )
        if res.status_code >= 400:
            raise RuntimeError(f"google token request failed: {res.status_code}")
        js = res.json()
        self._cached = (
            js["access_token"],
            time.time() + (js.get("expires_in", 3600) - 60),
        )
        return js["access_token"]
