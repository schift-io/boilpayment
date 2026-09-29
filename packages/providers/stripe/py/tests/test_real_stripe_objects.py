"""Real stripe SDK objects (not test doubles) must never reach storage: every Payment the
normalizers build has to survive json.dumps, which is what the Postgres repo's JSON column does."""

from __future__ import annotations

import json
from dataclasses import asdict

import stripe
from boilpayment_stripe import (
    normalize_checkout_session_as_payment,
    normalize_invoice_as_payment,
    normalize_payment_intent,
)

NOW = 1_700_000_000


def _pi() -> stripe.PaymentIntent:
    return stripe.PaymentIntent.construct_from(
        {
            "id": "pi_1",
            "object": "payment_intent",
            "amount": 1000,
            "currency": "usd",
            "status": "succeeded",
            "created": NOW,
            "metadata": {"affiliateId": "aff1"},
            "latest_charge": {"id": "ch_1", "object": "charge", "amount": 1000},
        },
        "sk_test",
    )


def _invoice() -> stripe.Invoice:
    return stripe.Invoice.construct_from(
        {
            "id": "in_1",
            "object": "invoice",
            "status": "paid",
            "amount_paid": 1000,
            "amount_due": 1000,
            "currency": "usd",
            "created": NOW,
            "period_start": NOW,
            "period_end": NOW + 86400,
            "metadata": {},
        },
        "sk_test",
    )


def _session(**expanded: object) -> stripe.checkout.Session:
    return stripe.checkout.Session.construct_from(
        {
            "id": "cs_1",
            "object": "checkout.session",
            "mode": "payment",
            "amount_subtotal": 1000,
            "amount_total": 1000,
            "currency": "usd",
            "metadata": {},
            **expanded,
        },
        "sk_test",
    )


def _assert_storable(payment) -> None:
    json.dumps(payment.raw)
    json.dumps(asdict(payment), default=str)


def test_payment_intent_raw_is_plain():
    _assert_storable(normalize_payment_intent(_pi()))


def test_invoice_raw_is_plain():
    _assert_storable(normalize_invoice_as_payment(_invoice(), _pi()))


def test_checkout_session_with_expanded_intent_is_plain():
    _assert_storable(normalize_checkout_session_as_payment(_session(payment_intent=_pi())))


def test_checkout_session_wrapped_in_dict_with_intent_object_is_plain():
    # get_payment re-wraps a session as a dict around an object it just retrieved
    session = {**_session().to_dict(), "payment_intent": _pi()}
    _assert_storable(normalize_checkout_session_as_payment(session))


def test_checkout_session_wrapped_in_dict_with_invoice_object_is_plain():
    session = {**_session(mode="subscription").to_dict(), "invoice": _invoice()}
    _assert_storable(normalize_checkout_session_as_payment(session))
