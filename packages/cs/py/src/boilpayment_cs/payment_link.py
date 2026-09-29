"""Provider-safe customer and affiliate references for hosted payment links."""

from __future__ import annotations

import base64
import binascii
import json
import re
from typing import Final, TypedDict
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from boilpayment_core import PaymentKitError, ProviderName

_STRIPE_REFERENCE = re.compile(r"^[A-Za-z0-9_-]{1,200}$")
_REFERENCE_PARAMETERS: Final[dict[str, str]] = {
    "stripe": "client_reference_id",
    "polar": "reference_id",
}


class PaymentLinkReference(TypedDict):
    customer_id: str
    affiliate_id: str | None


def build_payment_link_url(
    *,
    provider: ProviderName,
    link_url: str,
    customer_id: str,
    affiliate_id: str | None = None,
) -> str:
    """Add a compact customer reference while preserving existing query parameters."""
    if not customer_id or affiliate_id == "":
        raise PaymentKitError(
            "payment link reference values must be non-empty",
            "payment_link_reference_invalid",
        )
    payload = json.dumps(
        {"v": 1, "c": customer_id, "a": affiliate_id},
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode()
    reference = base64.urlsafe_b64encode(payload).decode().rstrip("=")
    if _STRIPE_REFERENCE.fullmatch(reference) is None:
        raise PaymentKitError(
            "payment link reference exceeds provider limits",
            "payment_link_reference_invalid",
        )
    parsed = urlsplit(link_url)
    if not parsed.scheme or not parsed.netloc:
        raise PaymentKitError("payment link URL is invalid", "payment_link_url_invalid")
    try:
        parameter = _REFERENCE_PARAMETERS[provider]
    except KeyError:
        raise PaymentKitError(
            "payment links support Stripe and Polar only",
            "payment_link_provider_unsupported",
        ) from None
    query = [(key, value) for key, value in parse_qsl(parsed.query, keep_blank_values=True) if key != parameter]
    query.append((parameter, reference))
    return urlunsplit(parsed._replace(query=urlencode(query)))


def decode_payment_link_reference(reference: str) -> PaymentLinkReference | None:
    """Parse an untrusted provider reference, returning None for invalid/non-kit values."""
    if _STRIPE_REFERENCE.fullmatch(reference) is None:
        return None
    padded = reference + "=" * (-len(reference) % 4)
    try:
        value = json.loads(base64.urlsafe_b64decode(padded).decode())
    except (binascii.Error, json.JSONDecodeError, UnicodeDecodeError):
        return None
    if (
        not isinstance(value, dict)
        or value.get("v") != 1
        or not isinstance(value.get("c"), str)
        or not value["c"]
        or value.get("a") is not None
        and (not isinstance(value.get("a"), str) or not value["a"])
    ):
        return None
    return {"customer_id": value["c"], "affiliate_id": value.get("a")}
