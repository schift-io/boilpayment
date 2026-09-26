"""Thin re-export -- see ../README.md. Full surface of schift_payment_kit_stripe (StripeProvider + pure normalizer
functions).

NOT re-exported at the package root -- see root README "Root export & name collisions":
normalize_failure/normalize_subscription/normalize_refund/map_event_type/to_normalized_event
collide (different signatures) with the same names exported by schift_payment_kit.polar.
"""
from __future__ import annotations

from schift_payment_kit_stripe import (
    StripeProvider,
    invoice_payment_intent_ref,
    map_event_type,
    normalize_failure,
    normalize_invoice_as_payment,
    normalize_payment_intent,
    normalize_refund,
    normalize_subscription,
    to_normalized_event,
)

__all__ = [
    "StripeProvider",
    "invoice_payment_intent_ref",
    "map_event_type",
    "normalize_failure",
    "normalize_invoice_as_payment",
    "normalize_payment_intent",
    "normalize_refund",
    "normalize_subscription",
    "to_normalized_event",
]
