"""Shared test fixtures for packages/usage/py -- real core doubles only, except a
PaymentProvider stub that implements every method (raising on any unexpected call).
Mirrors packages/usage/ts/test/fixtures.ts.
"""

from __future__ import annotations

from datetime import UTC, datetime

from boilpayment_core import (
    DEFAULT_POLICY,
    Period,
    ProviderCapabilities,
    Subscription,
)

BASE_POLICY = DEFAULT_POLICY


def mk_sub(**overrides) -> Subscription:
    base = {
        "id": "sub_1",
        "customer_id": "cust_1",
        "plan_id": "plan_pro",
        "provider": "stripe",
        "provider_ref": "sub_stripe_1",
        "status": "active",
        "current_period": Period(
            start=datetime(2026, 5, 1, tzinfo=UTC), end=datetime(2026, 6, 1, tzinfo=UTC)
        ),
        "anchor_day": 1,
        "cancel_at_period_end": False,
        "grace_until": None,
        "billing_key": None,
        "scheduled_plan_id": None,
        "created_at": datetime(2026, 1, 1, tzinfo=UTC),
    }
    base.update(overrides)
    return Subscription(**base)


class FakeProvider:
    """Implements every PaymentProvider method. Every method not needed by a given test scenario
    raises loudly, so an accidental/unexpected call fails the test instead of silently no-op'ing."""

    name = "stripe"

    def __init__(
        self, *, meters: bool = True, fail_first_n: int = 0, always_fail: bool = False
    ):
        self._meters = meters
        self._fail_first_n = fail_first_n
        self._always_fail = always_fail
        self._call_count = 0
        self.report_usage_calls: list[dict] = []

    def capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            native_subscriptions=True,
            partial_refund=True,
            meters=self._meters,
            scheduling="provider",
            webhook_signature=True,
        )

    async def create_customer(self, **_kw):
        raise NotImplementedError("unexpected call: create_customer")

    async def create_checkout(self, *_a, **_kw):
        raise NotImplementedError("unexpected call: create_checkout")

    async def get_payment(self, *_a, **_kw):
        raise NotImplementedError("unexpected call: get_payment")

    async def list_payments(self, **_kw):
        raise NotImplementedError("unexpected call: list_payments")

    async def get_subscription(self, *_a, **_kw):
        raise NotImplementedError("unexpected call: get_subscription")

    async def change_subscription(self, *_a, **_kw):
        raise NotImplementedError("unexpected call: change_subscription")

    async def cancel_subscription(self, *_a, **_kw):
        raise NotImplementedError("unexpected call: cancel_subscription")

    async def charge_billing_key(self, **_kw):
        raise NotImplementedError("unexpected call: charge_billing_key")

    async def refund(self, **_kw):
        raise NotImplementedError("unexpected call: refund")

    async def verify_webhook(self, **_kw):
        raise NotImplementedError("unexpected call: verify_webhook")

    async def report_usage(
        self, *, meter, customer_ref, quantity, occurred_at=None, idempotency_key=None
    ):
        self._call_count += 1
        self.report_usage_calls.append(
            {"customer_ref": customer_ref, "meter": meter, "quantity": quantity}
        )
        if self._always_fail or self._call_count <= self._fail_first_n:
            raise RuntimeError("provider unavailable")
