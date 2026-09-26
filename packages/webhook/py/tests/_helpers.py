"""Shared test doubles for Phase 6 webhook regression tests (not collected by pytest --
no test_ prefix). FakeProvider implements every PaymentProvider method; any method not
given an explicit impl raises "unexpected call: <method>" so tests can prove a method
was (or was not) invoked -- modeled on examples/e2e/round_trip.py's FakeProvider and
packages/webhook/py/examples/smoke.py's FakeProvider/TossLikeProvider.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import datetime

from boilpayment_core import (
    NormalizedEvent,
    Payment,
    ProviderCapabilities,
    Subscription,
    WebhookSignatureError,
)


class FakeProvider:
    def __init__(
        self,
        *,
        verify: Callable[[dict[str, str], str], NormalizedEvent],
        name: str = "stripe",
        native_subscriptions: bool = True,
        get_payment_impl: Callable[[str], Payment] | None = None,
        get_subscription_impl: Callable[[str], Subscription] | None = None,
    ) -> None:
        self.name = name
        self._native_subscriptions = native_subscriptions
        self._verify = verify
        self._get_payment_impl = get_payment_impl
        self._get_subscription_impl = get_subscription_impl
        self.get_payment_called = False
        self.get_subscription_called = False

    def capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(
            native_subscriptions=self._native_subscriptions,
            partial_refund=True,
            meters=False,
            scheduling="provider",
            webhook_signature=True,
        )

    async def create_customer(self, **kwargs: object) -> dict[str, str]:
        raise RuntimeError("unexpected call: create_customer")

    async def create_checkout(self, input: object) -> object:
        raise RuntimeError("unexpected call: create_checkout")

    async def get_payment(self, provider_ref: str) -> Payment:
        self.get_payment_called = True
        if self._get_payment_impl is None:
            raise RuntimeError("unexpected call: get_payment")
        return self._get_payment_impl(provider_ref)

    async def list_payments(self, **kwargs: object) -> list[Payment]:
        raise RuntimeError("unexpected call: list_payments")

    async def get_subscription(self, provider_ref: str) -> Subscription:
        self.get_subscription_called = True
        if self._get_subscription_impl is None:
            raise RuntimeError("unexpected call: get_subscription")
        return self._get_subscription_impl(provider_ref)

    async def change_subscription(
        self, provider_ref: str, **kwargs: object
    ) -> Subscription:
        raise RuntimeError("unexpected call: change_subscription")

    async def cancel_subscription(
        self, provider_ref: str, **kwargs: object
    ) -> Subscription:
        raise RuntimeError("unexpected call: cancel_subscription")

    async def charge_billing_key(self, **kwargs: object) -> Payment:
        raise RuntimeError("unexpected call: charge_billing_key")

    async def refund(self, **kwargs: object) -> object:
        raise RuntimeError("unexpected call: refund")

    async def report_usage(self, **kwargs: object) -> None:
        raise RuntimeError("unexpected call: report_usage")

    async def verify_webhook(
        self, *, headers: dict[str, str], raw_body: str
    ) -> NormalizedEvent:
        return self._verify(headers, raw_body)


def json_verify(
    name: str = "stripe",
) -> Callable[[dict[str, str], str], NormalizedEvent]:
    """headers['x-sig'] must be 'ok', else WebhookSignatureError; JSON body -> NormalizedEvent
    (mirrors packages/webhook/py/examples/smoke.py)."""

    def _verify(headers: dict[str, str], raw_body: str) -> NormalizedEvent:
        if headers.get("x-sig") != "ok":
            raise WebhookSignatureError()
        parsed = json.loads(raw_body)
        return NormalizedEvent(
            id=parsed["id"],
            provider=name,
            type=parsed["type"],
            occurred_at=datetime.fromisoformat(parsed["occurredAt"]),
            customer_ref=parsed.get("customerRef"),
            subscription_ref=parsed.get("subscriptionRef"),
            payment_ref=parsed.get("paymentRef"),
            amount=None,
            raw=parsed,
        )

    return _verify
