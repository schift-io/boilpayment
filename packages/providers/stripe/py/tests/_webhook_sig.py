"""Test helper — builds a Stripe `Stripe-Signature` header value by hand, mirroring Stripe's
documented scheme (https://stripe.com/docs/webhooks/signatures#verify-manually) rather than
delegating to the SDK's own `stripe.WebhookSignature.generate_signature_header` test helper:

    signed_payload = "{timestamp}.{body}"
    v1 = HMAC-SHA256(signed_payload, secret) as hex
    header = "t={timestamp},v1={v1}"
"""

from __future__ import annotations

import hashlib
import hmac
import time


def sign_stripe_payload(payload: str, secret: str, timestamp: int | None = None) -> str:
    if timestamp is None:
        timestamp = int(time.time())
    signed_payload = f"{timestamp}.{payload}"
    v1 = hmac.new(
        secret.encode("utf-8"), signed_payload.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return f"t={timestamp},v1={v1}"
