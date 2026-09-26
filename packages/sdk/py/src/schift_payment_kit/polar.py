"""Thin re-export -- see ../README.md. Full surface of schift_payment_kit_polar (PolarProvider + pure normalizer functions).

NOT re-exported at the package root -- see root README "Root export & name collisions":
normalize_failure/normalize_subscription/normalize_refund/map_event_type/to_normalized_event
collide (different signatures) with the same names exported by schift_payment_kit.stripe.
"""
from __future__ import annotations

from schift_payment_kit_polar import (
    PolarProvider,
    map_event_type,
    normalize_failure,
    normalize_order,
    normalize_refund,
    normalize_subscription,
    to_normalized_event,
    verify_standard_webhook_signature,
)

__all__ = [
    "PolarProvider",
    "map_event_type",
    "normalize_failure",
    "normalize_order",
    "normalize_refund",
    "normalize_subscription",
    "to_normalized_event",
    "verify_standard_webhook_signature",
]
