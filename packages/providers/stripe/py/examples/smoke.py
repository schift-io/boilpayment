"""Smoke test — no live Stripe keys. Exercises verify_webhook against a self-signed payload and the
pure normalize functions against fixture objects. Mirrors ts/examples/smoke.ts field-for-field so the
two languages can be diffed. Run: .venv/bin/python
packages/providers/stripe/py/examples/smoke.py
"""

from __future__ import annotations

import asyncio
import json

import stripe
from boilpayment_core import WebhookSignatureError
from boilpayment_stripe import (
    StripeProvider,
    map_event_type,
    normalize_failure,
    normalize_invoice_as_payment,
    normalize_payment_intent,
    normalize_subscription,
    to_normalized_event,
)


def dc(obj):
    """dataclass (nested) -> plain dict for json.dumps, mirroring JSON.stringify of the ts smoke."""
    import dataclasses

    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return {f.name: dc(getattr(obj, f.name)) for f in dataclasses.fields(obj)}
    if isinstance(obj, list):
        return [dc(v) for v in obj]
    if isinstance(obj, dict):
        return {k: dc(v) for k, v in obj.items()}
    if hasattr(obj, "isoformat"):
        return obj.isoformat()
    if hasattr(
        obj, "to_dict"
    ):  # stripe StripeObject (Event, Invoice, PaymentIntent, ...)
        return dc(obj.to_dict())
    if isinstance(obj, _Obj):
        return dc(obj._data)
    return obj


async def main() -> None:
    webhook_secret = "whsec_testsecret1234567890"
    provider = StripeProvider(secret_key="sk_test_dummy", webhook_secret=webhook_secret)

    print("=== capabilities ===")
    print(provider.capabilities())

    now = 1_700_000_000  # fixed epoch so ts/py smokes are byte-comparable (parity.sh)
    invoice_event = {
        "id": "evt_test_invoice_paid",
        "object": "event",
        "type": "invoice.paid",
        "created": now,
        "data": {
            "object": {
                "id": "in_test_1",
                "object": "invoice",
                "customer": "cus_test_1",
                "subscription": "sub_test_1",
                "amount_paid": 5000,
                "amount_due": 5000,
                "currency": "krw",
                "status": "paid",
                "created": now,
                "lines": {
                    "data": [{"period": {"start": now, "end": now + 30 * 86400}}]
                },
            }
        },
    }
    payload = json.dumps(invoice_event)
    header = stripe.WebhookSignature.generate_signature_header(payload, webhook_secret)

    print("\n=== verifyWebhook (valid signature, invoice.paid) ===")
    normalized = await provider.verify_webhook(
        headers={"stripe-signature": header}, raw_body=payload
    )
    print(json.dumps(dc(normalized), indent=2, ensure_ascii=False))

    print("\n=== verifyWebhook (bad signature) ===")
    try:
        await provider.verify_webhook(
            headers={"stripe-signature": "t=0,v1=deadbeef"}, raw_body=payload
        )
        print("FAIL: expected WebhookSignatureError, none thrown")
    except WebhookSignatureError as err:
        print("OK: rejected as WebhookSignatureError (code:", getattr(err, "code", None), ")")

    print("\n=== normalize_failure fixtures ===")
    print("insufficient_funds ->", normalize_failure(decline_code="insufficient_funds"))
    print("unknown code ->", normalize_failure(code="some_weird_code", message="weird"))

    print("\n=== normalize_payment_intent fixture (topup, requires_action) ===")
    pi = {
        "id": "pi_test_1",
        "amount": 10000,
        "currency": "krw",
        "status": "requires_action",
        "created": now,
        "last_payment_error": None,
        "invoice": None,
    }
    print(
        json.dumps(dc(normalize_payment_intent(_Obj(pi))), indent=2, ensure_ascii=False)
    )

    print("\n=== normalize_invoice_as_payment fixture ===")
    print(
        json.dumps(
            dc(normalize_invoice_as_payment(_Obj(invoice_event["data"]["object"]))),
            indent=2,
            ensure_ascii=False,
        )
    )

    print("\n=== normalize_subscription fixture ===")
    sub = {
        "id": "sub_test_1",
        "customer": "cus_test_1",
        "status": "active",
        "current_period_start": now,
        "current_period_end": now + 30 * 86400,
        "billing_cycle_anchor": now,
        "cancel_at_period_end": False,
        "created": now,
        "metadata": {"customerId": "internal_cust_1", "planId": "plan_pro"},
    }
    print(
        json.dumps(dc(normalize_subscription(_Obj(sub))), indent=2, ensure_ascii=False)
    )

    print("\n=== map_event_type(checkout.session.completed, mode=subscription) ===")
    print(
        map_event_type(
            {
                "type": "checkout.session.completed",
                "data": {"object": {"mode": "subscription"}},
            }
        )
    )

    print("\n=== to_normalized_event (charge.dispute.created fixture) ===")
    dispute_event = {
        "id": "evt_test_dispute",
        "type": "charge.dispute.created",
        "created": now,
        "data": {
            "object": {"payment_intent": "pi_test_2", "amount": 3000, "currency": "krw"}
        },
    }
    print(
        json.dumps(dc(to_normalized_event(dispute_event)), indent=2, ensure_ascii=False)
    )

    print("\nSMOKE OK")


def _wrap(value):
    if isinstance(value, dict):
        return _Obj(value)
    if isinstance(value, list):
        return [_wrap(v) for v in value]
    return value


class _Obj:
    """Minimal attr-accessor wrapper so fixtures built as plain dicts satisfy `getattr(x, 'field')`
    call sites in the provider's normalize_* functions, recursively (real Stripe SDK objects behave
    the same way, supporting both attribute and dict-style access at every nesting level)."""

    def __init__(self, data: dict):
        self._data = data

    def __getattr__(self, name):
        if name in self._data:
            return _wrap(self._data[name])
        raise AttributeError(name)

    # Real StripeObject also exposes dict-style access and to_dict(); the double must too.
    def to_dict(self) -> dict:
        return dict(self._data)

    def get(self, key, default=None):
        return _wrap(self._data.get(key, default))

    def __contains__(self, key):
        return key in self._data

    def __getitem__(self, key):
        return _wrap(self._data[key])

    def keys(self):
        return self._data.keys()


if __name__ == "__main__":
    asyncio.run(main())
